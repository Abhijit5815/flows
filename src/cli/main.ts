import { existsSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { ADAPTERS, adapterFor } from '../adapters/registry.ts';
import { addRepo, findRepo, initProject, loadProject, projectDataDir, setFramework, storageDir, type Project, type Repo } from '../config/project.ts';
import { createDecider } from '../decider/create.ts';
import { loadBuiltInTasks } from '../decider/task.ts';
import { CATALOGUE } from '../embeddings/catalogue.ts';
import { modelDir } from '../embeddings/download.ts';
import type { Graph } from '../graph/schema.ts';
import { loadGraph } from '../graph/store.ts';
import { stackOf } from '../ingest/detect.ts';
import { scanRepo } from '../ingest/pipeline.ts';
import { FlowsError } from '../shared/errors.ts';
import type { TraceEvent } from '../trace/event.ts';
import { readTrace, traceFile } from '../trace/sink.ts';

const USAGE = `usage: flows <command> [--project <dir>]
  init [--name <name>]                     create .flows/config.json in the project folder
  repo add <path> --role web|api           register a repo folder under a role
  repo list
  stack                                    the framework found for each repo, and why
  stack set <path> <framework|auto> [--role web|api]   pin a repo's framework, or go back to detection
  scan                                     build each repo's graph (files are parsed again only when they change)
  show <kind> [--json]                     what the last scan found: routes, pages, handlers, guards, ...
  models list                              the embedding model catalogue
  decide <task> <text>                     run the Decider once, all of the task's labels allowed
  trace [--kind decision|llm_call] [--type <task>] [--last <n>] [--json]`;

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    project: { type: 'string', default: '.' },
    name: { type: 'string' },
    role: { type: 'string' },
    kind: { type: 'string' },
    type: { type: 'string' },
    last: { type: 'string' },
    json: { type: 'boolean', default: false },
  },
});

const root = resolve(values.project);

// Download progress on stderr, one line per tenth of each file.
function progress(): (file: string, received: number, total: number) => void {
  let shown = -1;
  return (file, received, total) => {
    const tenth = Math.floor((received / total) * 10);
    if (tenth !== shown) process.stderr.write(`downloading ${file} ${tenth * 10}%\n`);
    shown = tenth === 10 ? -1 : tenth;
  };
}

function formatEvent(event: TraceEvent): string {
  if (event.kind === 'decision') {
    return `${event.at}  decision  ${event.decision_type}  ${event.label} (${event.source}, p=${Math.max(...Object.values(event.probs)).toFixed(2)})  ${event.model_version}  ${JSON.stringify(event.input)}`;
  }
  const tokens = event.tokens ? `tokens ${event.tokens.input}/${event.tokens.output}` : 'no token count';
  return `${event.at}  llm_call  ${event.purpose}  ${event.llm_call.ok ? 'ok' : `failed: ${event.llm_call.error}`}  ${event.model_version}  ${tokens}`;
}

function showTrace(project: Project): void {
  let events = readTrace(traceFile(projectDataDir(project)));
  if (values.kind) events = events.filter((event) => event.kind === values.kind);
  if (values.type) events = events.filter((event) => event.kind === 'decision' && event.decision_type === values.type);
  if (values.last) events = events.slice(-Number(values.last));
  for (const event of events) console.log(values.json ? JSON.stringify(event) : formatEvent(event));
}

function listModels(project: Project): void {
  const models = join(storageDir(project), 'models');
  for (const entry of CATALOGUE) {
    const megabytes = Math.round(entry.files.reduce((sum, file) => sum + file.size, 0) / 1e6);
    const downloaded = entry.files.every((file) => existsSync(join(modelDir(models, entry), file.path)));
    const inUse = project.config.embedder.provider === 'local' && project.config.embedder.model === entry.id;
    console.log(`${inUse ? '*' : ' '} ${entry.id}  ${entry.license}  ${entry.dims} dims  ${megabytes} MB  ${downloaded ? 'downloaded' : 'not downloaded'}  ${entry.source}@${entry.revision.slice(0, 7)}`);
  }
}

function showStacks(project: Project, repos: readonly Repo[]): void {
  for (const repo of repos) {
    const stack = stackOf(project.root, repo);
    if (values.json) {
      console.log(JSON.stringify({ ...repo, ...stack }));
      continue;
    }
    console.log(`${repo.role}  ${repo.path}  ${stack.framework ?? 'unknown'}${stack.version ? ` ${stack.version}` : ''}  (${stack.source})`);
    for (const line of stack.evidence) console.log(`    ${line}`);
    for (const line of stack.warnings) console.log(`  ! ${line}`);
  }
}

async function scanAll(project: Project): Promise<void> {
  for (const repo of project.config.repos) {
    const { stack, graph, coverage, ms } = await scanRepo(project, repo);
    console.log(`${repo.role}  ${repo.path}  ${stack.framework ?? 'unknown framework'}${stack.version ? ` ${stack.version}` : ''}  (${ms.toFixed(0)} ms)`);
    if (graph === undefined) {
      console.log('  no adapter fits this repo, so there is no graph; see "flows stack"');
      continue;
    }
    const counts = new Map<string, number>();
    for (const node of graph.nodes) counts.set(node.kind, (counts.get(node.kind) ?? 0) + 1);
    console.log(`  found: ${[...counts].map(([kind, n]) => `${n} ${kind}`).join(', ') || 'nothing'}`);
    const cached = coverage.sources - coverage.parsed.length;
    console.log(`  files: ${coverage.files} listed, ${coverage.sources} source (${coverage.parsed.length} parsed now, ${cached} unchanged), ${coverage.parseErrors.length} with parse errors`);
    for (const { file, errors } of coverage.parseErrors) console.log(`    ${file}: ${errors} parse error(s); matches elsewhere in the file are still used`);
    if (coverage.unrecognised.length > 0) console.log(`  unrecognised (${coverage.unrecognised.length}):`);
    for (const note of coverage.unrecognised) console.log(`    ${note.file}:${note.line}  ${note.reason}`);
  }
}

function describe(graph: Graph, node: Graph['nodes'][number]): string {
  const linked = (kind: string) => graph.edges.filter((edge) => edge.from === node.id && edge.kind === kind).map((edge) => edge.to.split(':').slice(2).join(':'));
  const extra = node.kind === 'route' ? `  -> ${linked('handled-by').join(', ') || 'no handler'}${linked('guarded-by').length > 0 ? `  guarded by ${linked('guarded-by').join(', ')}` : ''}` : '';
  return `${node.id}  ${node.file}:${node.line}${extra}`;
}

function show(project: Project, what: string): void {
  const kind = what.replace(/s$/, '');
  for (const repo of project.config.repos) {
    const graph = loadGraph(project, repo);
    if (graph === undefined) {
      console.log(`${repo.role}  ${repo.path}: not scanned yet; run "flows scan"`);
      continue;
    }
    for (const node of graph.nodes.filter((candidate) => candidate.kind === kind)) console.log(values.json ? JSON.stringify(node) : describe(graph, node));
  }
}

async function run(): Promise<void> {
  const [command, sub, ...rest] = positionals;
  switch (`${command ?? ''} ${command === 'repo' || command === 'models' || command === 'stack' ? (sub ?? '') : ''}`.trim()) {
    case 'init': {
      const project = initProject(root, values.name ?? basename(root));
      console.log(`created ${join(root, '.flows', 'config.json')} (project ${project.config.id})`);
      return;
    }
    case 'repo add': {
      const [path] = rest;
      if (!path || !values.role) throw new FlowsError('usage: flows repo add <path> --role web|api');
      const project = addRepo(loadProject(root), path, values.role);
      console.log(`registered ${project.config.repos.at(-1)?.path} as ${values.role}`);
      return;
    }
    case 'repo list':
      for (const repo of loadProject(root).config.repos) console.log(`${repo.role}  ${repo.path}`);
      return;
    case 'stack': {
      const project = loadProject(root);
      return showStacks(project, project.config.repos);
    }
    case 'stack set': {
      const [path, name] = rest;
      if (!path || !name) throw new FlowsError('usage: flows stack set <path> <framework|auto> [--role web|api]');
      const project = loadProject(root);
      const framework = name === 'auto' ? undefined : name;
      // The framework says which role it reads, so --role is only needed for "auto" on a folder with both roles.
      const repo = findRepo(project, path, values.role ?? ADAPTERS.find((adapter) => adapter.id === framework)?.role);
      if (framework !== undefined) adapterFor(framework, repo.role);
      return showStacks(setFramework(project, repo, framework), [{ ...repo, framework }]);
    }
    case 'scan':
      return await scanAll(loadProject(root));
    case 'show':
      if (!sub) throw new FlowsError('usage: flows show <kind> [--json], e.g. flows show routes');
      return show(loadProject(root), sub);
    case 'models list':
      return listModels(loadProject(root));
    case 'decide': {
      const text = [sub, ...rest].slice(1).join(' ');
      const task = loadBuiltInTasks().find((candidate) => candidate.task === sub);
      if (!sub || !text) throw new FlowsError('usage: flows decide <task> <text>');
      const decision = await createDecider(loadProject(root), progress()).decide(sub, text, task?.labels ?? []);
      console.log(JSON.stringify(decision, null, 2));
      return;
    }
    case 'trace':
      return showTrace(loadProject(root));
    default:
      console.log(USAGE);
      if (command !== undefined && command !== 'help') process.exitCode = 1;
  }
}

try {
  await run();
} catch (error) {
  // Expected failures get a one-line message; anything else is a bug and keeps its stack.
  if (!(error instanceof FlowsError)) throw error;
  console.error(`flows: ${error.message}`);
  process.exitCode = 1;
}
