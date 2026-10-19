import { existsSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { addRepo, initProject, loadProject, projectDataDir, storageDir, type Project } from '../config/project.ts';
import { createDecider } from '../decider/create.ts';
import { loadBuiltInTasks } from '../decider/task.ts';
import { CATALOGUE } from '../embeddings/catalogue.ts';
import { modelDir } from '../embeddings/download.ts';
import { FlowsError } from '../shared/errors.ts';
import type { TraceEvent } from '../trace/event.ts';
import { readTrace, traceFile } from '../trace/sink.ts';

const USAGE = `usage: flows <command> [--project <dir>]
  init [--name <name>]                     create .flows/config.json in the project folder
  repo add <path> --role web|api           register a repo folder under a role
  repo list
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

async function run(): Promise<void> {
  const [command, sub, ...rest] = positionals;
  switch (`${command ?? ''} ${command === 'repo' || command === 'models' ? (sub ?? '') : ''}`.trim()) {
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
