import type { FlowSet } from '../engine/store.ts';
import { NOT_OBSERVED, ROLE_NOT_EXPLORED } from './crosscheck.ts';
import type { Run } from './run.ts';

// The explorer's own summary: what it saw, what it did, what it refused and what the guard stopped.
export function runLines(run: Run): string[] {
  if (run.kind === 'inspector') return [`  ${run.states.length} page states, ${run.actions.length} things done by hand (${run.id})`];
  const taken = run.actions.filter((action) => action.taken && action.decision.label !== 'login');
  const skipped = run.actions.filter((action) => !action.taken);
  const count = (keep: (action: Run['actions'][number]) => boolean) => skipped.filter(keep).length;
  const lines = [
    `  ${run.states.length} page states, ${taken.length} actions taken (${run.id})`,
    `  skipped: ${count((action) => action.decision.label === 'destructive')} rated destructive, ${count((action) => action.decision.by === 'decider' && action.decision.label !== 'destructive')} unsure, ${count((action) => action.decision.by === 'rule')} by rule (other sites, sign-out, passwords, files)`,
    `  blocked: ${run.requests.filter((request) => request.blocked).length} writes and ${run.sockets.length} WebSockets never reached the app`,
  ];
  return [...lines, ...run.notes.map((note) => `  note: ${note}`)];
}

const list = (names: readonly string[]) => (names.length === 0 ? '' : `: ${names.join('; ')}`);

// PLAN.md Phase 3 exit: the cross-check reports matches, source-only and observed-only flows (and the roles no run
// covered).
export function crossCheckLines(set: FlowSet): string[] {
  if (set.runs.length === 0) return ['  no live runs yet; run "flows explore <url>"'];
  const named = (keep: (flow: FlowSet['flows'][number]) => boolean) => set.flows.filter(keep).map((flow) => flow.name);
  const confirmed = named((flow) => flow.status === 'confirmed');
  const notObserved = named((flow) => flow.tags.includes(NOT_OBSERVED));
  const unexplored = named((flow) => flow.tags.includes(ROLE_NOT_EXPLORED));
  const observedOnly = named((flow) => flow.status === 'observed-only');
  return [
    `  confirmed ${confirmed.length}${list(confirmed)}`,
    `  not observed (source only) ${notObserved.length}${list(notObserved)}`,
    `  role not explored ${unexplored.length}${list(unexplored)}`,
    `  observed-only (no source match, for review) ${observedOnly.length}${list(observedOnly)}`,
    `  roles: ${set.roles.length === 0 ? 'no guards in source' : set.roles.map((role) => `${role.guard} ${role.covered ? 'covered' : 'NOT explored'}`).join(', ')}`,
  ];
}
