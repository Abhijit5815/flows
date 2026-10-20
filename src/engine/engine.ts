import type { ProjectConfig } from '../config/project.ts';
import type { Decider } from '../decider/decider.ts';
import { lookup } from '../graph/lookup.ts';
import type { Graph } from '../graph/schema.ts';
import type { Category } from '../model/category.ts';
import { FlowSchema, type Flow } from '../model/flow.ts';
import { eventBase, type TraceEvent } from '../trace/event.ts';
import type { TraceSink } from '../trace/sink.ts';
import { candidates } from './candidates.ts';
import { classify } from './classify.ts';
import { deciderText } from './describe.ts';
import { judge, type Verdict } from './judge.ts';
import type { OptionalLlm } from './llm.ts';
import { proposeName } from './name.ts';
import { reachability, unreachableBecause } from './reach.ts';
import type { FlowSet } from './store.ts';
import { addLoginSubflows } from './subflows.ts';
import { verifyFlows, type Verified } from './verify.ts';

export type EngineDeps = {
  decider: Decider; // destructive-risk and flow-category
  grounding: Decider; // claim-vs-evidence
  llm: OptionalLlm;
  trace: TraceSink;
  categories: readonly Category[];
  categoryLabels: readonly string[]; // the flow-category task's labels
  config: ProjectConfig['engine'];
};

// PLAN.md Phase 4 flow engine, for one repo's graph: candidates, Login subflows, verifier, reachability, classify,
// names, judge. Every skipped candidate, verification and judgement goes to the trace as a verdict event.
export async function buildFlows(graph: Graph, verdicts: ReadonlyMap<string, Verdict>, deps: EngineDeps): Promise<FlowSet> {
  const nodes = lookup(graph);
  const record = (started: number, stage: Extract<TraceEvent, { kind: 'verdict' }>['stage'], subject: string, outcome: string, reasons: string[]) =>
    deps.trace.record({ ...eventBase(started), kind: 'verdict', stage, subject, outcome, reasons });

  const found = candidates(graph);
  const { flows, notes } = addLoginSubflows(found.flows, nodes);
  // A flow a reviewer marked wrong is rejected as it stands, and nothing can use it as a subflow.
  const wrong = flows.filter((flow) => verdicts.get(flow.id) === 'wrong');
  const results = await verifyFlows(
    flows.filter((flow) => !wrong.includes(flow)),
    { graph, nodes, grounding: deps.grounding, maxDepth: deps.config.max_subflow_depth },
  );
  const reach = reachability(graph, nodes);
  const set: FlowSet = { flows: [], reasons: {}, rejected: [], unreachable: reach.unreachable, notes };
  for (const skip of found.skipped) {
    set.rejected.push({ subject: skip.node, name: skip.name, reasons: [skip.reason] });
    record(performance.now(), 'candidates', skip.node, 'skipped', [skip.reason]);
  }

  const judged: Verified[] = wrong.map((flow) => ({ ok: true, flow, claims: 1, proven: 1, reasons: [] }));
  for (const result of results) {
    if (result.ok) judged.push(result);
    else {
      set.rejected.push({ subject: result.id, name: result.name, reasons: result.reasons });
      record(performance.now(), 'verifier', result.id, 'rejected', result.reasons);
    }
  }
  for (const result of judged) {
    const started = performance.now();
    const verdict = verdicts.get(result.flow.id);
    if (verdict !== 'wrong') record(started, 'verifier', result.flow.id, result.reasons.length === 0 ? 'kept' : 'kept with changes', result.reasons);
    const named = verdict === 'wrong' ? { reasons: [] } : await proposeName(result.flow, deps.llm, deps.grounding);
    const { category, destructive } = await classify(deciderText(result.flow, nodes), deps);
    const judgement = judge({
      claims: result.claims,
      proven: result.proven,
      unreachable: unreachableBecause(result.flow, reach),
      destructive,
      verdict,
      sourceOnlyWeight: deps.config.source_only_weight,
    });
    const flow: Flow = FlowSchema.parse({
      ...result.flow,
      ...(named.name === undefined ? {} : { name: named.name }),
      ...(named.description === undefined ? {} : { description: named.description }),
      category,
      destructive,
      status: judgement.status,
      confidence: judgement.confidence,
      enabled: judgement.enabled,
    });
    set.flows.push(flow);
    set.reasons[flow.id] = [...(found.notes[flow.id] ?? []), ...result.reasons, ...named.reasons, ...judgement.reasons];
    record(started, 'judge', flow.id, judgement.status, judgement.reasons);
  }
  return set;
}
