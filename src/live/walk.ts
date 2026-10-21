import { existsSync } from 'node:fs';
import { LoginNameSchema, type Project, type Repo } from '../config/project.ts';
import { refreshFlows, type EngineDeps } from '../engine/engine.ts';
import { loadFlows, type FlowSet } from '../engine/store.ts';
import { loadGraph } from '../graph/store.ts';
import { LiveError } from '../shared/errors.ts';
import { inspect, type Walk } from './inspector.ts';
import { guidedSteps, knowing } from './know.ts';
import { sessionFile } from './login.ts';
import { indexOf } from './match.ts';
import { loadRuns, runDir, saveRun } from './run.ts';

// One inspector walk for a project, as `flows inspect` and the review page's "Walk this in the inspector" start it:
// at the URL given, else where the newest explorer run started; signed in with the session given, else that run's
// (when it was saved); guided by one flow, or free. After the walk the run is saved and every repo's flows are built
// again, so the cross-check sees what the person did.
export type WalkRequest = { url?: string; as?: string; flow?: { repo: Repo; id: string } };

export type WalkResult = Walk & { steps: number; sets: { repo: Repo; set: FlowSet }[] };

export async function walkInInspector(
  project: Project,
  request: WalkRequest,
  deps: EngineDeps,
  log: (line: string) => void,
  // The review page runs the saving part in its write queue; the walk itself can take as long as the person likes.
  serial: <T>(work: () => Promise<T>) => Promise<T> = (work) => work(),
): Promise<WalkResult> {
  const newest = loadRuns(project)
    .filter((run) => run.kind === 'explorer' && (request.url === undefined || run.origin === new URL(request.url).origin))
    .at(-1);
  const url = request.url ?? newest?.url;
  if (url === undefined) throw new LiveError('no URL to open: give one, or run "flows explore <url>" first');
  if (request.as !== undefined && !LoginNameSchema.safeParse(request.as).success) throw new LiveError(`"${request.as}" is not a login name`);
  const name = request.as ?? newest?.session ?? null;
  const saved = name === null ? undefined : sessionFile(project, name);
  if (request.as !== undefined && (saved === undefined || !existsSync(saved))) throw new LiveError(`no saved session "${request.as}": run "flows login ${url} --as ${request.as}" first`);
  const storageState = saved !== undefined && existsSync(saved) ? saved : undefined;

  const graphs = project.config.repos.flatMap((repo) => {
    const graph = loadGraph(project, repo);
    return graph === undefined ? [] : [{ repo, graph }];
  });
  let guided: { flow: string; steps: ReturnType<typeof guidedSteps> } | undefined;
  if (request.flow !== undefined) {
    const { repo, id } = request.flow;
    const flow = loadFlows(project, repo)?.flows.find((candidate) => candidate.id === id);
    const graph = graphs.find((candidate) => candidate.repo === repo)?.graph;
    if (flow === undefined || graph === undefined) throw new LiveError(`no flow ${id} in ${repo.role} ${repo.path}; run "flows scan"`);
    guided = { flow: flow.id, steps: guidedSteps(flow, indexOf(graph)) };
  }

  const walk = await inspect(
    { url, session: storageState === undefined ? null : name, storageState, guided, headless: false },
    {
      decider: deps.decider,
      config: project.config.explorer,
      pages: graphs.flatMap(({ graph }) => graph.nodes.flatMap((node) => (node.kind === 'page' ? [node.attrs.path] : []))),
      knowing: knowing(project, graphs),
      runDir: (id) => runDir(project, id),
      log,
    },
  );
  return serial(async () => {
    saveRun(project, walk.run);
    const sets: { repo: Repo; set: FlowSet }[] = [];
    for (const { repo, graph } of graphs) sets.push({ repo, set: await refreshFlows(project, repo, graph, deps) });
    return { ...walk, steps: guided?.steps.length ?? 0, sets };
  });
}
