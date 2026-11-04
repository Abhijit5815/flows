// The gap tags the cross-check puts on source flows (PLAN.md Phase 3), shared by the engine and the review page.
export const NOT_OBSERVED = 'not observed';
export const ROLE_NOT_EXPLORED = 'role not explored';
// A flow a person made or rewrote that cites code the repo no longer has (PLAN.md Phase 7 staleness).
export const STALE = 'stale';
// A UI flow that calls the API at a path no route of the project's API repos answers.
export const NO_ROUTE = 'no backend route';
// A flow that crosses pages: open one, follow a link or submit a form, land on the next, and carry on.
export const JOURNEY = 'journey';
