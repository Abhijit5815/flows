import type { Category } from '../model/category.ts';
import type { Flow } from '../model/flow.ts';
import { annotate, type Checks } from '../live/locators.ts';
import type { Run } from '../live/run.ts';
import type { FlowSet } from './store.ts';

export type FlowExport = { schema_version: 0; exported: string; base_url: string | null; live_runs: number; flows: Flow[] };

// PLAN.md Phase 5: the reviewed flows as JSON (the flow schema) for a separate test tool. Every enabled flow in an
// enabled category, plus the subflows those flows run (enabled or not), so the file stands on its own.
// shortcut: two repos of the same role can share a flow id ("Open /"); ids would repeat in the file. Prefix ids
// with the repo if a project ever registers two web or two api repos.
// onlyChanged: just the flows the last scan found new or changed (and not yet marked seen), with their subflows.
export function exportFlows(sets: readonly FlowSet[], categories: readonly Category[], onlyChanged = false, live?: { runs: readonly Run[]; checks: Checks; baseUrl?: string }): FlowExport {
  const off = new Set(categories.filter((category) => !category.enabled).map((category) => category.id));
  const flows = sets.flatMap((set) => {
    const byId = new Map(set.flows.map((flow) => [flow.id, flow]));
    const chosen = new Map(set.flows.filter((flow) => flow.enabled && flow.status !== 'rejected' && !off.has(flow.category) && (!onlyChanged || set.since?.changes[flow.id] !== undefined)).map((flow) => [flow.id, flow]));
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
  const runs = live?.runs ?? [];
  return { schema_version: 0, exported: new Date().toISOString(), base_url: live?.baseUrl ?? runs.at(-1)?.origin ?? null, live_runs: runs.length, flows: annotate(flows, runs, live?.checks) };
}
