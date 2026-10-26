import { resolve } from 'node:path';
import type { Project, ProjectConfig, Repo } from '../config/project.ts';
import type { Decider } from '../decider/decider.ts';
import { lookup } from '../graph/lookup.ts';
import type { Graph } from '../graph/schema.ts';
import { FALLBACK_CATEGORY_ID, type Category } from '../model/category.ts';
import { FlowSchema, type Flow } from '../model/flow.ts';
import { loadRules, type LearnedRule } from '../rules/learned.ts';
import { eventBase, type TraceEvent } from '../trace/event.ts';
import type { TraceSink } from '../trace/sink.ts';
import { liveFor, matchFlow, NOT_OBSERVED, ROLE_NOT_EXPLORED, rolesOf, unexploredGuard, type Live } from '../live/crosscheck.ts';
import { indexOf } from '../live/match.ts';
import { candidates } from './candidates.ts';
import { classify } from './classify.ts';
import { deciderText } from './describe.ts';
import { loadEdits, type Edits } from './edits.ts';
import { judge, judgeObserved, type Verdict } from './judge.ts';
import type { OptionalLlm } from './llm.ts';
import { proposeName } from './name.ts';
import { reachability, unreachableBecause } from './reach.ts';
import { loadFlows, saveFlows, type FlowSet } from './store.ts';
import { markStale } from './stale.ts';
import { addLoginSubflows } from './subflows.ts';
import { verifyFlows, type Human, type Verified } from './verify.ts';

export type EngineDeps = {
  decider: Decider; // destructive-risk and flow-category
  grounding: Decider; // claim-vs-evidence
  llm: OptionalLlm;
  trace: TraceSink;
  categories: readonly Category[];
  categoryLabels: readonly string[]; // the flow-category task's labels
  config: ProjectConfig['engine'];
};

// What people taught Flows about the repo: their latest verdict on each flow, and their edits and added flows.
export type HumanInput = { verdicts: ReadonlyMap<string, Verdict>; edits: Edits };

export const verdictsOf = (rules: readonly LearnedRule[]): Map<string, Verdict> =>
  new Map(rules.flatMap((rule) => (rule.type === 'feedback' && (rule.kind === 'correct' || rule.kind === 'wrong' || rule.kind === 'never') ? [[rule.flow, rule.kind] as const] : [])));

// PLAN.md Phase 4 flow engine, for one repo's graph: candidates, Login subflows, verifier, reachability, classify,
// names, judge. Phase 5: a person's edits and added flows are laid over the result, and what a person set is never
// overwritten. Phase 3: with live runs, the cross-check confirms the flows the live app showed, tags the gaps, and
// adds the observed flows source doesn't have. Every skipped candidate, verification and judgement goes to the trace
// as a verdict event.
export async function buildFlows(graph: Graph, human: HumanInput, deps: EngineDeps, live?: Live): Promise<FlowSet> {
  const nodes = lookup(graph);
  const record = (started: number, stage: Extract<TraceEvent, { kind: 'verdict' }>['stage'], subject: string, outcome: string, reasons: string[]) =>
    deps.trace.record({ ...eventBase(started), kind: 'verdict', stage, subject, outcome, reasons });
  const { overrides } = human.edits;
  // A folder registered as both web and api shares one .flows/: each role takes only the flows of its own kind.
  const added = human.edits.added.filter((flow) => (flow.kind === 'ui') === (graph.role === 'web'));

  const found = candidates(graph);
  const generated = addLoginSubflows(found.flows, nodes);
  // A person's steps replace the generated ones, and steps they switched off stay off.
  const withSteps = (flow: Flow): Flow => {
    const override = overrides[flow.id];
    if (override === undefined) return flow;
    const steps = (override.steps ?? flow.steps).map((step) => (override.disabled_steps?.includes(step.id) ? { ...step, enabled: false } : step));
    return { ...flow, steps };
  };
  const addedIds = new Set(added.map((flow) => flow.id));
  const flows = [...generated.flows.filter((flow) => !addedIds.has(flow.id)), ...added].map(withSteps);
  const people = new Map<string, Human>(flows.flatMap((flow) => (addedIds.has(flow.id) || overrides[flow.id]?.steps !== undefined ? [[flow.id, { steps: true, text: addedIds.has(flow.id) }] as const] : [])));

  // A flow a reviewer marked wrong (or never) is rejected as it stands, and nothing can use it as a subflow.
  const refused = flows.filter((flow) => human.verdicts.get(flow.id) === 'wrong' || human.verdicts.get(flow.id) === 'never');
  const results = await verifyFlows(
    flows.filter((flow) => !refused.includes(flow)),
    { graph, nodes, grounding: deps.grounding, maxDepth: deps.config.max_subflow_depth, human: people },
  );
  const reach = reachability(graph, nodes);
  const index = live === undefined ? undefined : indexOf(graph);
  const roles = index === undefined || live === undefined ? [] : rolesOf(index, live.seen);
  const used = new Set<string>(); // observed flows a source flow matched
  const set: FlowSet = { flows: [], reasons: {}, rejected: [], decisions: {}, unreachable: reach.unreachable, notes: generated.notes, runs: live?.runs.map((run) => run.id) ?? [], roles, gone: [] };
  for (const skip of found.skipped) {
    if (skip.flow !== undefined && addedIds.has(skip.flow.id)) continue; // a person promoted it
    set.rejected.push({ subject: skip.node, name: skip.name, reasons: [skip.reason], ...(skip.flow === undefined ? {} : { flow: skip.flow }) });
    record(performance.now(), 'candidates', skip.node, 'skipped', [skip.reason]);
  }

  const judged: Verified[] = refused.map((flow) => ({ ok: true, flow, claims: 1, proven: 1, reasons: [], keep: true }));
  for (const result of results) {
    if (result.ok) judged.push(result);
    else {
      set.rejected.push({ subject: result.id, name: result.name, reasons: result.reasons });
      record(performance.now(), 'verifier', result.id, 'rejected', result.reasons);
    }
  }
  const byId = new Map(judged.map((result) => [result.flow.id, result.flow]));
  for (const result of judged) {
    const started = performance.now();
    const { id } = result.flow;
    const verdict = human.verdicts.get(id);
    const override = overrides[id] ?? {};
    const own = addedIds.has(id);
    if (!refused.includes(result.flow)) record(started, 'verifier', id, result.reasons.length === 0 ? 'kept' : 'kept with changes', result.reasons);
    // The LLM names only what nobody named: not a person's own flow, nor a flow a person renamed or refused.
    const named = own || override.name !== undefined || refused.includes(result.flow) ? { reasons: [] } : await proposeName(result.flow, deps.llm, deps.grounding);
    const classified = await classify(deciderText(result.flow, nodes), deps);
    const match = index === undefined || live === undefined || refused.includes(result.flow) ? undefined : matchFlow(result.flow, index, live);
    for (const seen of match?.used ?? []) used.add(seen);
    const judgement = judge({ claims: result.claims, proven: result.proven, unreachable: unreachableBecause(result.flow, reach, byId, people.get(id)?.steps ?? false), destructive: classified.destructive, verdict, sourceOnlyWeight: deps.config.source_only_weight, seen: match?.all ?? false });
    const confirmed = judgement.status === 'confirmed';
    // A gap is tagged at every scan, on top of a person's tags, so editing tags never hides it.
    const guard = index === undefined || match === undefined || match.all ? undefined : unexploredGuard(result.flow, index, roles);
    const gap = match === undefined || match.all || judgement.status === 'rejected' ? [] : [guard === undefined ? NOT_OBSERVED : ROLE_NOT_EXPLORED];
    const live_reasons = [
      ...(match === undefined || match.all ? [] : [guard === undefined ? `not observed: ${match.missing.join('; ')}` : `role not explored: no run got past ${guard.guard}`]),
      ...(match?.notes ?? []),
    ];
    const description = override.description ?? named.description ?? result.flow.description;
    const flow: Flow = FlowSchema.parse({
      ...result.flow,
      origin: confirmed ? 'both' : result.flow.origin,
      steps: confirmed ? result.flow.steps.map((step) => ({ ...step, evidence: [...step.evidence, ...(match?.evidence.get(step.id) ?? [])] })) : result.flow.steps,
      name: override.name ?? named.name ?? result.flow.name,
      ...(description === undefined ? {} : { description }),
      category: override.category ?? (own && result.flow.category !== FALLBACK_CATEGORY_ID ? result.flow.category : classified.category),
      destructive: classified.destructive,
      status: judgement.status,
      confidence: judgement.confidence,
      enabled: override.enabled ?? judgement.enabled,
      priority: override.priority ?? result.flow.priority,
      tags: [...new Set([...(override.tags ?? result.flow.tags), ...gap])],
      version: overrides[id]?.version ?? result.flow.version,
    });
    set.flows.push(flow);
    set.reasons[id] = [...(found.notes[id] ?? []), ...result.reasons, ...named.reasons, ...judgement.reasons, ...live_reasons, ...(overrides[id] === undefined ? [] : [`edited by a person (version ${flow.version})`])];
    set.decisions[id] = classified.decisions;
    record(started, 'judge', id, judgement.status, [...judgement.reasons, ...live_reasons]);
  }

  // Observed-only: what the live app showed that no source flow here matched, shown for review (PLAN.md Phase 3).
  for (const seen of live?.mine ?? []) {
    const started = performance.now();
    const { id } = seen.flow;
    if (seen.noise || used.has(id) || set.flows.some((flow) => flow.id === id)) continue;
    const verdict = human.verdicts.get(id);
    const override = overrides[id] ?? {};
    const observed = withSteps(seen.flow);
    const named = override.name !== undefined || verdict === 'wrong' || verdict === 'never' ? { reasons: [] } : await proposeName(observed, deps.llm, deps.grounding);
    const classified = await classify(seen.text, deps);
    const judgement = judgeObserved({ destructive: classified.destructive, verdict, weight: deps.config.observed_only_weight });
    const description = override.description ?? named.description;
    set.flows.push(
      FlowSchema.parse({
        ...observed,
        name: override.name ?? named.name ?? observed.name,
        ...(description === undefined ? {} : { description }),
        category: override.category ?? classified.category,
        destructive: classified.destructive,
        status: judgement.status,
        confidence: judgement.confidence,
        enabled: override.enabled ?? judgement.enabled,
        priority: override.priority ?? observed.priority,
        tags: override.tags ?? observed.tags,
        version: overrides[id]?.version ?? observed.version,
      }),
    );
    set.reasons[id] = [`seen in run ${seen.run}`, ...named.reasons, ...judgement.reasons, ...(overrides[id] === undefined ? [] : [`edited by a person (version ${overrides[id].version})`])];
    set.decisions[id] = classified.decisions;
    record(started, 'judge', id, judgement.status, judgement.reasons);
  }
  return set;
}

// A repo's flows from its graph, what people taught Flows about it (<repo>/.flows/) and the project's live runs, saved
// for `flows show` and the review page.
export async function refreshFlows(project: Project, repo: Repo, graph: Graph, deps: EngineDeps): Promise<FlowSet> {
  const dir = resolve(project.root, repo.path);
  const edits = loadEdits(dir);
  const verdicts = verdictsOf(loadRules(dir));
  const set = await buildFlows(graph, { verdicts, edits }, deps, liveFor(project, repo));
  markStale(set, graph, loadFlows(project, repo), edits, new Set([...Object.keys(edits.overrides), ...verdicts.keys()]));
  saveFlows(project, repo, set);
  return set;
}
