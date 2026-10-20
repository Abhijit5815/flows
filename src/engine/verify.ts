import { z } from 'zod';
import type { Decider } from '../decider/decider.ts';
import { GROUNDING, GROUNDING_LABELS, groundingInput } from '../decider/entailment.ts';
import type { Lookup } from '../graph/lookup.ts';
import type { Graph, GraphNode } from '../graph/schema.ts';
import { FlowSchema, type Flow } from '../model/flow.ts';
import { claimOf, flowName, isRunClaim, label, LOGIN_CLAIM, premiseOf } from './describe.ts';
import { isLogin } from './subflows.ts';

type Step = Flow['steps'][number];
type Evidence = Step['evidence'];

// claims: every step, check, name and description the flow states; proven: those the graph backs. keep: a person
// wrote these steps, so problems are reported and nothing is dropped (PLAN.md Phase 5: human edits are never
// overwritten).
export type Verified = { ok: true; flow: Flow; claims: number; proven: number; reasons: string[]; keep: boolean };
export type Verification = Verified | { ok: false; id: string; name: string; reasons: string[] };

// Per flow id: steps = a person wrote the steps; text = a person wrote the name and description (their own words,
// not claims the graph has to back).
export type Human = { steps: boolean; text: boolean };

export type VerifyContext = { graph: Graph; nodes: Lookup; grounding: Decider; maxDepth: number; human?: ReadonlyMap<string, Human> };

const UI_KINDS = new Set(['page', 'layout', 'component', 'form', 'action']);

// Every evidence item must be a node of this graph at the place it names; one that isn't makes the claim false.
function cite(evidence: Evidence, ctx: VerifyContext): { nodes: GraphNode[]; problem?: string } {
  const nodes: GraphNode[] = [];
  for (const item of evidence) {
    if (item.type !== 'code') return { nodes, problem: `${item.type} evidence can't be checked against source` };
    const node = ctx.nodes.node(item.node_id);
    if (node === undefined) return { nodes, problem: `${item.node_id} is not in the ${ctx.graph.role} graph` };
    if (item.ref !== `${node.file}:${node.line}`) return { nodes, problem: `${item.node_id} is at ${node.file}:${node.line}, not ${item.ref}` };
    nodes.push(node);
  }
  return { nodes };
}

// Everything a node leads to along the graph's edges, itself included.
function reachable(from: readonly GraphNode[], ctx: VerifyContext): Set<string> {
  const seen = new Set<string>();
  for (const queue = from.map((node) => node.id); queue.length > 0; ) {
    const id = queue.shift() as string; // safe: the queue is not empty
    if (seen.has(id)) continue;
    seen.add(id);
    queue.push(...ctx.nodes.out(id).map((node) => node.id));
  }
  return seen;
}

async function supported(evidence: string, claim: string, ctx: VerifyContext): Promise<{ ok: boolean; p: number }> {
  const decision = await ctx.grounding.decide(GROUNDING, groundingInput(evidence, claim), GROUNDING_LABELS);
  return { ok: decision.label === 'supported', p: decision.all_probs.supported ?? 0 };
}

// Why a step's expected result is not what source says, or undefined when it is.
function checkProblem(step: Step, cited: GraphNode[], flow: Flow, ctx: VerifyContext): string | undefined {
  const check = step.check;
  if (check === null) return undefined;
  const { nodes, problem } = cite(check.evidence, ctx);
  if (problem !== undefined) return problem;
  if (check.kind === 'api') {
    if (flow.kind === 'ui') return 'the UI graph has no responses to check against';
    const route = cited.find((node) => node.kind === 'route');
    const responses = route === undefined ? [] : ctx.nodes.out(route.id, 'handled-by').flatMap((handler) => ctx.nodes.out(handler.id, 'responds-with'));
    const response = nodes.find((node) => node.kind === 'response' && responses.some((own) => own.id === node.id));
    if (response?.kind !== 'response') return "it cites no response of this route's handler";
    if (check.status !== undefined && check.status !== response.attrs.status) return `${response.id} sends ${response.attrs.status ?? 'an unknown status'}, not ${check.status}`;
    const extra = (check.fields ?? []).filter((field) => !response.attrs.fields.includes(field));
    return extra.length > 0 ? `${response.id} has no field ${extra.join(', ')}` : undefined;
  }
  if (check.page !== undefined && !nodes.some((node) => node.kind === 'page' && label(node) === check.page && cited.some((own) => own.id === node.id))) {
    return `the step does not open ${check.page}`;
  }
  if (check.element !== undefined) {
    const shown = reachable(cited, ctx);
    if (!nodes.some((node) => label(node) === check.element && shown.has(node.id))) return `${check.element} is not on what this step shows`;
  }
  return undefined;
}

// Why a step does not hold, or undefined when every part of it is backed by the graph.
async function stepProblem(step: Step, flow: Flow, ctx: VerifyContext): Promise<{ problem?: string; nodes: GraphNode[] }> {
  const { nodes, problem } = cite(step.evidence, ctx);
  if (problem !== undefined) return { problem, nodes };
  if (step.kind === 'ui' && !nodes.some((node) => UI_KINDS.has(node.kind))) return { problem: 'a UI step must cite a page, layout, component, form or action', nodes };
  if (step.kind === 'api' && step.request !== undefined) {
    const target = nodes.find((node) => node.kind === (flow.kind === 'ui' ? 'api-call' : 'route'));
    if (target?.kind !== 'api-call' && target?.kind !== 'route') return { problem: `an API step in a ${flow.kind.toUpperCase()} flow must cite its ${flow.kind === 'ui' ? 'API call' : 'route'}`, nodes };
    if (target.attrs.method !== step.request.method || target.attrs.path !== step.request.path) {
      return { problem: `${step.request.method} ${step.request.path} is not what ${target.id} sends`, nodes };
    }
  }
  // A subflow step a person made names the flow it runs; checkSubflows checks that flow.
  if (step.kind === 'subflow' && isRunClaim(step.claim)) return { nodes };
  if (step.claim !== claimOf(step.kind, nodes)) {
    const grounded = await supported(premiseOf(step.kind, nodes), step.claim, ctx);
    if (!grounded.ok) return { problem: `"${step.claim}" is not supported by its evidence (p=${grounded.p.toFixed(2)})`, nodes };
  }
  return { nodes };
}

async function verifyOne(input: unknown, ctx: VerifyContext): Promise<Verification> {
  const parsed = FlowSchema.safeParse(input);
  const meta = z.object({ id: z.string(), name: z.string() }).partial().safeParse(input).data;
  const [id, name] = [meta?.id ?? '(no id)', meta?.name ?? '(no name)'];
  if (!parsed.success) return { ok: false, id, name, reasons: [`not a valid flow: ${z.prettifyError(parsed.error).replace(/\n/g, ' ')}`] };
  const flow = parsed.data;
  if ((flow.kind === 'ui') !== (ctx.graph.role === 'web')) return { ok: false, id, name, reasons: [`a ${flow.kind} flow is checked against the ${flow.kind === 'ui' ? 'web' : 'api'} graph, not the ${ctx.graph.role} graph`] };

  const human = ctx.human?.get(flow.id);
  const keep = human?.steps ?? false;
  const reasons: string[] = [];
  let claims = 0;
  let proven = 0;
  const steps: Step[] = [];
  for (const step of flow.steps) {
    claims += step.check === null ? 1 : 2;
    const { problem, nodes } = await stepProblem(step, flow, ctx);
    if (problem !== undefined) {
      reasons.push(keep ? `${step.id} is not backed by source: ${problem}` : `${step.id} dropped: ${problem}`);
      if (keep) steps.push(step);
      continue;
    }
    proven += 1;
    const checkIssue = checkProblem(step, nodes, flow, ctx);
    if (checkIssue !== undefined) reasons.push(keep ? `${step.id} check is not backed by source: ${checkIssue}` : `${step.id} check dropped: ${checkIssue}`);
    else if (step.check !== null) proven += 1;
    steps.push({ ...step, check: checkIssue === undefined || keep ? step.check : null });
  }
  // A person may build a flow from subflows alone; anything else needs a step of its own left.
  if (!keep && !steps.some((step) => step.kind !== 'subflow')) return { ok: false, id, name, reasons: [...reasons, 'no step survived'] };
  // Once a person wrote the steps, the name and description are part of their flow, not claims to prove.
  if (human?.text || keep) return { ok: true, flow: { ...flow, steps }, claims, proven, reasons, keep };

  // The name and description are claims too; the proven steps are their premise.
  const premise = steps.map((step) => `${step.claim}.`).join(' ');
  const template = flowName({ steps }, ctx.nodes);
  let kept: Flow = { ...flow, steps };
  claims += 1;
  if (flow.name === template || (await supported(premise, flow.name, ctx)).ok) proven += 1;
  else {
    reasons.push(`name "${flow.name}" is not supported by the steps; using "${template ?? flow.id}"`);
    kept = { ...kept, name: template ?? flow.id };
  }
  if (flow.description !== undefined) {
    claims += 1;
    if ((await supported(premise, flow.description, ctx)).ok) proven += 1;
    else {
      reasons.push(`description "${flow.description}" is not supported by the steps; removed`);
      const { description: _, ...rest } = kept;
      kept = rest;
    }
  }
  return { ok: true, flow: kept, claims, proven, reasons, keep };
}

// Subflow steps must point to a flow of the same kind that passed, outside any cycle, nesting at most maxDepth deep.
// A generated Log-in step also needs a login flow as its target, and must cite guards its own entry sits behind.
function checkSubflows(results: Verification[], ctx: VerifyContext): void {
  const byId = new Map(results.flatMap((result) => (result.ok ? [[result.flow.id, result] as const] : [])));
  const subflows = (result: Verified) => result.flow.steps.filter((step) => step.kind === 'subflow');
  const problems = new Map<Step, string>();

  // Whether `from` is reached again by following subflow references out of `to`.
  const leadsBack = (to: string, from: string): boolean => {
    const seen = new Set<string>();
    for (const queue = [to]; queue.length > 0; ) {
      const id = queue.shift() as string; // safe: the queue is not empty
      if (id === from) return true;
      if (seen.has(id)) continue;
      seen.add(id);
      const target = byId.get(id);
      if (target !== undefined) queue.push(...subflows(target).flatMap((step) => step.subflow_ref ?? []));
    }
    return false;
  };
  // Where a flow starts: its own first step, or, for a flow built from subflows alone, where the first one it runs
  // (other than Log-in) starts.
  const entryOf = (result: Verified, seen: ReadonlySet<string>): string => {
    const first = result.flow.steps.find((step) => step.kind !== 'subflow')?.evidence[0];
    if (first !== undefined) return first.type === 'code' ? first.node_id : '';
    const run = result.flow.steps.find((step) => step.kind === 'subflow' && !step.claim.startsWith(LOGIN_CLAIM));
    const target = byId.get(run?.subflow_ref ?? '');
    return target === undefined || seen.has(target.flow.id) ? '' : entryOf(target, new Set([...seen, target.flow.id]));
  };
  for (const result of byId.values()) {
    const entry = entryOf(result, new Set([result.flow.id]));
    for (const step of subflows(result)) {
      const target = byId.get(step.subflow_ref ?? '');
      if (target === undefined || target.flow.kind !== result.flow.kind) problems.set(step, `${step.subflow_ref} is not one of the ${result.flow.kind.toUpperCase()} flows that passed`);
      else if (leadsBack(target.flow.id, result.flow.id)) problems.set(step, `${step.subflow_ref} leads back to ${result.flow.id} (a cycle)`);
      else if (step.claim.startsWith(LOGIN_CLAIM)) {
        const guards = new Set(ctx.nodes.out(entry, 'guarded-by').map((node) => node.id));
        const unguarded = step.evidence.flatMap((item) => (item.type === 'code' && !guards.has(item.node_id) ? [item.node_id] : []));
        if (!isLogin(target.flow, ctx.nodes)) problems.set(step, `${step.subflow_ref} is not a login flow`);
        else if (unguarded.length > 0) problems.set(step, `${entry} is not guarded by ${unguarded.join(', ')}`);
      }
    }
  }
  // Depth along the references that are left, so no cycle remains to follow.
  const memo = new Map<string, number>();
  const depth = (result: Verified): number => {
    let deepest = memo.get(result.flow.id);
    if (deepest !== undefined) return deepest;
    deepest = 0;
    for (const step of subflows(result)) {
      const target = problems.has(step) ? undefined : byId.get(step.subflow_ref ?? '');
      if (target !== undefined) deepest = Math.max(deepest, 1 + depth(target));
    }
    memo.set(result.flow.id, deepest);
    return deepest;
  };
  for (const result of byId.values()) {
    for (const step of subflows(result)) {
      const target = problems.has(step) ? undefined : byId.get(step.subflow_ref ?? '');
      const below = target === undefined ? 0 : 1 + depth(target);
      if (below > ctx.maxDepth) problems.set(step, `subflows would nest ${below} deep; the cap is ${ctx.maxDepth}`);
    }
  }
  for (const result of byId.values()) {
    for (const step of subflows(result)) {
      const why = problems.get(step);
      if (why === undefined) continue;
      result.proven -= 1;
      result.reasons.push(result.keep ? `${step.id} is not backed by source: ${why}` : `${step.id} dropped: ${why}`);
      if (!result.keep) result.flow = { ...result.flow, steps: result.flow.steps.filter((own) => own !== step) };
    }
  }
}

// PLAN.md Phase 4 verifier: each claim is checked against the graph by node id; what source doesn't back is dropped.
export async function verifyFlows(inputs: readonly unknown[], ctx: VerifyContext): Promise<Verification[]> {
  const results: Verification[] = [];
  for (const input of inputs) results.push(await verifyOne(input, ctx));
  checkSubflows(results, ctx);
  return results;
}
