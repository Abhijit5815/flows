// Flows as a library (PLAN.md Phase 7): the few calls the CLI is made of. Everything else is internal.
export { addRepo, initProject, loadProject, type Project } from './config/project.ts';
export { refreshFlows, type EngineDeps } from './engine/engine.ts';
export { exportFlows } from './engine/export.ts';
export { loadFlows, type FlowSet } from './engine/store.ts';
export { scanRepo } from './ingest/pipeline.ts';
export { explore } from './live/explorer.ts';
export { FlowSchema, type Flow } from './model/flow.ts';
