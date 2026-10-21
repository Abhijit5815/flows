import type { Graph } from '../graph/schema.ts';
import { STALE } from '../model/tags.ts';
import type { Edits } from './edits.ts';
import type { FlowSet } from './store.ts';

// PLAN.md Phase 7 staleness: on a code change, flag the flows that lost their evidence. A flow a person made or
// rewrote keeps their steps whatever the code does, so when a node it cites is gone it is tagged stale, with the
// node named; nothing is deleted. A generated flow that disappeared since the last scan is listed, and marked when a
// person had edited or judged it, so their work isn't lost without a word.
export function markStale(set: FlowSet, graph: Graph, previous: FlowSet | undefined, edits: Edits, touched: ReadonlySet<string>): FlowSet {
  const nodes = new Set(graph.nodes.map((node) => node.id));
  const own = new Set([...edits.added.map((flow) => flow.id), ...Object.entries(edits.overrides).flatMap(([id, override]) => (override.steps === undefined ? [] : [id]))]);
  for (const flow of set.flows) {
    if (!own.has(flow.id)) continue;
    const missing = [...new Set(flow.steps.flatMap((step) => [...step.evidence, ...(step.check?.evidence ?? [])]).flatMap((evidence) => (evidence.type === 'code' && !nodes.has(evidence.node_id) ? [evidence.node_id] : [])))];
    if (missing.length === 0) continue;
    if (!flow.tags.includes(STALE)) flow.tags.push(STALE);
    set.reasons[flow.id] = [...(set.reasons[flow.id] ?? []), `stale: it cites ${missing.join(', ')}, which the code no longer has`];
  }
  const now = new Set(set.flows.map((flow) => flow.id));
  set.gone = (previous?.flows ?? [])
    .filter((flow) => flow.origin !== 'observed' && !now.has(flow.id))
    .map((flow) => ({ id: flow.id, name: flow.name, reason: touched.has(flow.id) ? 'gone from the code; a person had edited or judged it, and their entry in .flows/ is kept' : 'gone from the code' }));
  return set;
}
