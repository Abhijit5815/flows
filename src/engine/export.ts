import type { Category } from '../model/category.ts';
import type { Flow } from '../model/flow.ts';
import type { FlowSet } from './store.ts';

export type FlowExport = { schema_version: 0; exported: string; flows: Flow[] };

// PLAN.md Phase 5: the reviewed flows as JSON (the flow schema) for a separate test tool. Every enabled flow in an
// enabled category, plus the subflows those flows run (enabled or not), so the file stands on its own.
// shortcut: two repos of the same role can share a flow id ("Open /"); ids would repeat in the file. Prefix ids
// with the repo if a project ever registers two web or two api repos.
export function exportFlows(sets: readonly FlowSet[], categories: readonly Category[]): FlowExport {
  const off = new Set(categories.filter((category) => !category.enabled).map((category) => category.id));
  const flows = sets.flatMap((set) => {
    const byId = new Map(set.flows.map((flow) => [flow.id, flow]));
    const chosen = new Map(set.flows.filter((flow) => flow.enabled && flow.status !== 'rejected' && !off.has(flow.category)).map((flow) => [flow.id, flow]));
    for (const queue = [...chosen.values()]; queue.length > 0; ) {
      for (const step of (queue.shift() as Flow).steps) {
        const target = step.subflow_ref === undefined ? undefined : byId.get(step.subflow_ref);
        if (target !== undefined && !chosen.has(target.id)) {
          chosen.set(target.id, target);
          queue.push(target);
        }
      }
    }
    return [...chosen.values()];
  });
  return { schema_version: 0, exported: new Date().toISOString(), flows };
}
