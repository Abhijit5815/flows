import { z } from 'zod';
import type { Flow } from '../model/flow.ts';
import type { Evidence } from '../model/evidence.ts';
import { sha256 } from '../shared/hash.ts';
import { filesChanged, type GitState } from '../ingest/gitstate.ts';
import type { FlowSet } from './store.ts';

// What changed since the scan before, kept with the flows so a person can review only that: which flows are new or
// changed (until someone marks them seen), which one replaced a flow whose entry point was renamed, and where the
// code stood (the commit) at this scan and the one before.
export const SinceSchema = z.object({
  at: z.string(),
  commit: z.string().nullable(),
  branch: z.string().nullable(),
  dirty: z.boolean(),
  previous_commit: z.string().nullable(),
  files_changed: z.number().nullable(),
  first: z.boolean(), // no scan came before: nothing is "new" yet
  changes: z.record(z.string(), z.enum(['new', 'changed'])),
  replaces: z.record(z.string(), z.object({ id: z.string(), name: z.string() })),
  prints: z.record(z.string(), z.string()),
});
export type Since = z.infer<typeof SinceSchema>;

const codeNodes = (list: readonly Evidence[]): string[] => list.flatMap((evidence) => (evidence.type === 'code' ? [evidence.node_id] : []));
const nodesOf = (flow: Flow): Set<string> => new Set(flow.steps.flatMap((step) => [...codeNodes(step.evidence), ...codeNodes(step.check?.evidence ?? [])]));

// What the code says about a flow, and nothing a person or a live run added: a changed line number or a new name
// is not a change to the flow, a different claim, request, check or error is.
export function fingerprint(flow: Flow): string {
  const steps = flow.steps.map((step) => [
    step.kind,
    step.claim,
    step.request === undefined ? null : [step.request.method, step.request.path, step.request.body?.schema, step.request.body?.fields],
    step.action,
    step.params?.map((param) => [param.name, param.type]),
    codeNodes(step.evidence),
    step.check === null ? null : [step.check.kind, step.check.kind === 'ui' ? [step.check.page, step.check.element, step.check.text] : [step.check.status, step.check.fields]],
    step.errors?.map((error) => [error.kind, error.message, error.when, 'status' in error ? error.status : null]),
    step.subflow_ref,
  ]);
  return sha256(JSON.stringify([flow.kind, steps]));
}

// A flow whose entry point (route path, page) was renamed gets a new id, so it shows up as one gone and one new. Pair
// them by the code they share, each with its best match only, so it reads as one updated flow, not a duplicate.
function renames(gone: readonly Flow[], added: readonly Flow[]): Map<string, Flow> {
  const share = (a: Flow, b: Flow): number => {
    const left = nodesOf(a);
    const right = nodesOf(b);
    if (left.size === 0 || right.size === 0) return 0;
    return [...left].filter((node) => right.has(node)).length / Math.min(left.size, right.size);
  };
  const best = <T extends Flow>(from: Flow, among: readonly T[]): T | undefined => among.map((own) => [own, share(from, own)] as const).filter(([, score]) => score >= 0.6).sort((a, b) => b[1] - a[1])[0]?.[0];
  const pairs = new Map<string, Flow>();
  for (const old of gone) {
    const candidate = best(old, added);
    if (candidate !== undefined && best(candidate, gone) === old) pairs.set(candidate.id, old);
  }
  return pairs;
}

// At a scan: compare with the previous scan's flows. Anything new or changed stays marked until it is seen, however
// many scans pass.
export function sinceScan(set: FlowSet, previous: FlowSet | undefined, git: GitState | undefined, dir: string, at: string): Since {
  const prints = Object.fromEntries(set.flows.map((flow) => [flow.id, fingerprint(flow)]));
  const before = previous?.since;
  const baseline = before?.prints ?? Object.fromEntries((previous?.flows ?? []).map((flow) => [flow.id, fingerprint(flow)]));
  const changes: Since['changes'] = {};
  for (const [id, kind] of Object.entries(before?.changes ?? {})) if (prints[id] !== undefined) changes[id] = kind;
  const replaces: Since['replaces'] = {};
  for (const [id, old] of Object.entries(before?.replaces ?? {})) if (prints[id] !== undefined) replaces[id] = old;
  const first = previous === undefined;
  if (!first) {
    for (const flow of set.flows) {
      const old = baseline[flow.id];
      if (old === undefined) changes[flow.id] = 'new';
      else if (old !== prints[flow.id] && changes[flow.id] !== 'new') changes[flow.id] = 'changed';
    }
    const goneFlows = (previous?.flows ?? []).filter((flow) => flow.origin !== 'observed' && prints[flow.id] === undefined);
    const addedFlows = set.flows.filter((flow) => baseline[flow.id] === undefined);
    for (const [id, old] of renames(goneFlows, addedFlows)) {
      changes[id] = 'changed';
      replaces[id] = { id: old.id, name: old.name };
      set.gone = set.gone.filter((gone) => gone.id !== old.id);
    }
  }
  const was = before?.commit ?? null;
  return {
    at,
    commit: git?.commit ?? null,
    branch: git?.branch ?? null,
    dirty: git?.dirty ?? false,
    previous_commit: was,
    files_changed: git === undefined || was === null || was === git.commit ? null : (filesChanged(dir, was, git.commit) ?? null),
    first,
    changes,
    replaces,
    prints,
  };
}

// Not a scan (a person's edit, a live run): the marks stay as they were, for the flows still there.
export function carrySince(set: FlowSet, previous: FlowSet | undefined): Since | undefined {
  const before = previous?.since;
  if (before === undefined) return undefined;
  const present = new Set(set.flows.map((flow) => flow.id));
  const keep = <T>(record: Record<string, T>): Record<string, T> => Object.fromEntries(Object.entries(record).filter(([id]) => present.has(id)));
  return { ...before, changes: keep(before.changes), replaces: keep(before.replaces) };
}
