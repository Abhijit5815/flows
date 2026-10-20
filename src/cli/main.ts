import { existsSync, readFileSync } from 'node:fs';
import { basename, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { ADAPTERS, adapterFor } from '../adapters/registry.ts';
import { addRepo, findRepo, initProject, loadProject, projectDataDir, setFramework, storageDir, type Project, type Repo } from '../config/project.ts';
import { createDecider } from '../decider/create.ts';
import { loadBuiltInTasks } from '../decider/task.ts';
import { CATALOGUE } from '../embeddings/catalogue.ts';
import { createEmbeddingProvider } from '../embeddings/create.ts';
import { modelDir } from '../embeddings/download.ts';
import type { Graph } from '../graph/schema.ts';
import { loadGraph, repoFile } from '../graph/store.ts';
import { stackOf } from '../ingest/detect.ts';
import { evaluate, loadKeys, type Score } from '../ingest/eval.ts';
import { listFiles } from '../ingest/files.ts';
import { isSource } from '../ingest/match.ts';
import { CoverageSchema, scanRepo } from '../ingest/pipeline.ts';
import { createGateway } from '../llm/create.ts';
import { draftRule } from '../rules/draft.ts';
import { addRule, loadRules, rulesFile, today } from '../rules/learned.ts';
import { proposeRule } from '../rules/propose.ts';
import { FlowsError } from '../shared/errors.ts';
import { readCache } from '../shared/json-file.ts';
import type { TraceEvent } from '../trace/event.ts';
import { JsonlTraceSink, readTrace, traceFile } from '../trace/sink.ts';

const USAGE = `usage: flows <command> [--project <dir>]
  init [--name <name>]                     create .flows/config.json in the project folder
  repo add <path> --role web|api           register a repo folder under a role
  repo list
  stack                                    the framework found for each repo, and why
  stack set <path> <framework|auto> [--role web|api]   pin a repo's framework, or go back to detection
  scan                                     build each repo's graph (files are parsed again only when they change)
  show <kind> [--json]                     what the last scan found: routes, pages, handlers, guards, ... or missed
  rule missed <path:line> [--save]         propose a rule that finds what the scan missed there (kept with --save)
  rule exclude <node-id>                   leave a node out of every scan ("not a flow")
  rule draft --example <path:line>... [--save]   for code no adapter reads: the LLM drafts a rule, kept only if it
                                           reproduces the examples exactly
  rule list                                the rules each repo has learned (<repo>/.flows/rules.json)
  eval [--keys <dir>] [--samples <dir>]    recall and precision against hand-written answer keys (default: the
                                           sample apps); exits 1 on any miss or extra
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
    save: { type: 'boolean', default: false },
    example: { type: 'string', multiple: true },
    keys: { type: 'string' },
    samples: { type: 'string' },
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
  if (event.kind === 'verdict') return `${event.at}  verdict  ${event.stage}  ${event.subject}  ${event.outcome}${event.reasons.length > 0 ? `  ${event.reasons.join('; ')}` : ''}`;
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
  const embedder = createEmbeddingProvider(project.config.embedder, join(storageDir(project), 'models'), progress());
  const { min_similarity: minSimilarity, limit } = project.config.possibly_missed;
  for (const repo of project.config.repos) {
    const { stack, graph, coverage, ms } = await scanRepo(project, repo, { embedder, possiblyMissed: { minSimilarity, limit } });
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
    if (coverage.missed.length > 0) console.log(`  possibly missed: ${coverage.missed.length}; see "flows show missed" (listed for review, never added to the graph)`);
  }
}

function showMissed(project: Project): void {
  for (const repo of project.config.repos) {
    const coverage = readCache(repoFile(project, 'coverage', repo), CoverageSchema);
    if (coverage === undefined) {
      console.log(`${repo.role}  ${repo.path}: not scanned yet; run "flows scan"`);
      continue;
    }
    for (const suspect of coverage.missed) console.log(values.json ? JSON.stringify({ repo: repo.path, ...suspect }) : `${repo.role}  ${repo.path}  ${suspect.file}:${suspect.line}  ${suspect.reason}`);
  }
}

function describe(graph: Graph, node: Graph['nodes'][number]): string {
  const linked = (kind: string) => graph.edges.filter((edge) => edge.from === node.id && edge.kind === kind).map((edge) => edge.to.split(':').slice(2).join(':'));
  const extra = node.kind === 'route' ? `  -> ${linked('handled-by').join(', ') || 'no handler'}${linked('guarded-by').length > 0 ? `  guarded by ${linked('guarded-by').join(', ')}` : ''}` : '';
  return `${node.id}  ${node.file}:${node.line}${extra}`;
}

function show(project: Project, what: string): void {
  if (what === 'missed') return showMissed(project);
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

// A place the user points at ("apps/api/src/server.ts:17", from the project root) -> its repo and repo-relative file.
function locate(project: Project, place: string): { repo: Repo; file: string; line: number } {
  const match = /^(.+):([1-9]\d*)$/.exec(place);
  if (match === null) throw new FlowsError(`"${place}" should look like path/to/file.ts:17`);
  const absolute = resolve(project.root, match[1]);
  const inside = project.config.repos
    .map((repo) => ({ repo, file: relative(resolve(project.root, repo.path), absolute) }))
    .filter(({ repo, file }) => !file.startsWith('..') && (values.role === undefined || repo.role === values.role))
    .sort((a, b) => a.file.length - b.file.length);
  if (inside.length === 0) throw new FlowsError(`${match[1]} is not inside a registered repo`);
  if (inside.length > 1 && inside[0].file === inside[1].file) throw new FlowsError(`${match[1]} is in a repo registered as both web and api; add --role`);
  return { ...inside[0], line: Number(match[2]) };
}

function saveOrHint(repoDir: string, rule: Parameters<typeof addRule>[1]): void {
  if (!values.save) {
    console.log('not saved: run the same command with --save to keep it');
    return;
  }
  addRule(repoDir, rule);
  console.log(`saved to ${rulesFile(repoDir)}; run "flows scan" to use it`);
}

async function rule(project: Project, action: string | undefined, args: string[]): Promise<void> {
  switch (action) {
    case 'missed': {
      if (!args[0]) throw new FlowsError('usage: flows rule missed <path:line> [--save]');
      const { repo, file, line } = locate(project, args[0]);
      const proposal = await proposeRule(project, repo, { file, line });
      console.log(`proposed rule: ${JSON.stringify(proposal.rule)}`);
      console.log(`it adds ${proposal.finds.length} node(s):`);
      for (const id of proposal.finds) console.log(`  ${id}`);
      return saveOrHint(resolve(project.root, repo.path), proposal.rule);
    }
    case 'exclude': {
      if (!args[0]) throw new FlowsError('usage: flows rule exclude <node-id>');
      const owners = project.config.repos.filter((repo) => loadGraph(project, repo)?.nodes.some((node) => node.id === args[0]) && (values.role === undefined || repo.role === values.role));
      if (owners.length !== 1) throw new FlowsError(owners.length === 0 ? `no scanned graph has ${args[0]}; run "flows scan" or check the id with "flows show"` : `${args[0]} is in more than one repo; add --role`);
      addRule(resolve(project.root, owners[0].path), { type: 'exclude', node: args[0], added: today() });
      console.log(`${args[0]} will be left out of every scan of ${owners[0].path}; run "flows scan"`);
      return;
    }
    case 'draft': {
      const examples = (values.example ?? []).map((place) => locate(project, place));
      if (examples.length === 0) throw new FlowsError('usage: flows rule draft --example <path:line> [--example <path:line> ...] [--save]');
      const repo = examples[0].repo;
      if (examples.some((example) => example.repo !== repo)) throw new FlowsError('all examples must be in the same repo');
      const dir = resolve(project.root, repo.path);
      const sources = new Map(listFiles(dir).filter(isSource).map((path) => [path, readFileSync(join(dir, path), 'utf8')]));
      const gateway = createGateway(project.config.llm, new JsonlTraceSink(traceFile(projectDataDir(project))));
      const result = await draftRule(gateway, repo.role === 'api' ? 'route' : 'page', examples.map(({ file, line }) => `${file}:${line}`), sources);
      if (!result.accepted) throw new FlowsError(`the drafted rule was rejected: ${result.reason}`);
      console.log(`drafted rule (reproduces all ${examples.length} example(s)): ${JSON.stringify(result.rule)}`);
      return saveOrHint(dir, result.rule);
    }
    case 'list':
      for (const repo of project.config.repos) {
        for (const learned of loadRules(resolve(project.root, repo.path))) console.log(`${repo.role}  ${repo.path}  ${JSON.stringify(learned)}`);
      }
      return;
    default:
      throw new FlowsError('usage: flows rule missed|exclude|draft|list ...');
  }
}

async function evalAll(): Promise<void> {
  const keys = values.keys ?? fileURLToPath(new URL('../../ground-truth/', import.meta.url));
  const samples = values.samples ?? fileURLToPath(new URL('../../fixtures/samples/', import.meta.url));
  const cell = (found: Score | undefined) =>
    found === undefined ? '-' : `${found.matched}/${found.expected}  recall ${(found.recall * 100).toFixed(0)}%  precision ${(found.precision * 100).toFixed(0)}%`;
  let clean = true;
  console.log(`${'app'.padEnd(28)}${'endpoints'.padEnd(40)}pages`);
  for (const key of loadKeys(keys)) {
    const result = await evaluate(key, join(samples, key.app));
    console.log(`${key.app.padEnd(28)}${cell(result.endpoints).padEnd(40)}${cell(result.pages)}`);
    for (const [what, found] of [['endpoint', result.endpoints], ['page', result.pages]] as const) {
      for (const missed of found?.missed ?? []) console.log(`    missed ${what}: ${missed}`);
      for (const extra of found?.extra ?? []) console.log(`    extra ${what}: ${extra}`);
      if ((found?.missed.length ?? 0) + (found?.extra.length ?? 0) > 0) clean = false;
    }
    for (const [role, coverage] of Object.entries(result.coverage)) {
      console.log(`    ${role}: ${coverage.unrecognised.length} unrecognised, ${coverage.missed.length} possibly missed (pattern search), ${coverage.parseErrors.length} files with parse errors  (${result.ms.toFixed(0)} ms)`);
    }
  }
  if (!clean) process.exitCode = 1;
}

async function run(): Promise<void> {
  const [command, sub, ...rest] = positionals;
  if (command === 'rule') return rule(loadProject(root), sub, rest);
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
    case 'eval':
      return await evalAll();
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
