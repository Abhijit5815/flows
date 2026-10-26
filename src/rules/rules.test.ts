import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { addRepo, type Project } from '../config/project.ts';
import { scanRepo } from '../ingest/pipeline.ts';
import { createGateway } from '../llm/create.ts';
import type { LlmGateway } from '../llm/gateway.ts';
import { FlowsError } from '../shared/errors.ts';
import { liveSkip } from '../shared/testing/live.ts';
import { tempProject } from '../shared/testing/project.ts';
import { MemoryTraceSink } from '../trace/sink.ts';
import { checkDraft, draftRule, type Draft } from './draft.ts';
import { addRule, loadRules, now } from './learned.ts';
import { proposeRule } from './propose.ts';

const fixtures = fileURLToPath(new URL('../../fixtures/apps/', import.meta.url));
const tmp = mkdtempSync(join(tmpdir(), 'flows-rules-'));
after(() => rmSync(tmp, { recursive: true, force: true }));

// Rules are saved inside the repo, so every test works on its own copy of a fixture.
function copy(name: string, as: string): { project: Project; dir: string } {
  const dir = join(tmp, as);
  cpSync(join(fixtures, name), dir, { recursive: true });
  return { project: tempProject(join(tmp, `${as}-project`)), dir };
}

const routes = (nodes: { kind: string; id: string }[] | undefined) => (nodes ?? []).filter((node) => node.kind === 'route').map((node) => node.id);

test('"you missed this": the proposed rule finds the pointed line, and once saved it survives rescans', async () => {
  const { project, dir } = copy('express-basic', 'missed');
  const repo = addRepo(project, dir, 'api').config.repos[0];
  const proposal = await proposeRule(project, repo, { file: 'src/server.ts', line: 17 });
  assert.equal(proposal.rule.type, 'pattern');
  assert.deepEqual(proposal.rule.type === 'pattern' ? proposal.rule.rule : undefined, { id: 'route', rule: { pattern: '$R[$M]($$$ARGS)' } });
  // Everything the rule would add is shown before saving: both routes, and the handler and response they bring.
  assert.deepEqual(proposal.finds.sort(), ['api:handler:GET /ping', 'api:response:GET /ping#204', 'api:route:GET /ping', 'api:route:HEAD /ping']);
  assert.equal(loadRules(dir).length, 0, 'a proposal is not saved until the user confirms it');

  addRule(dir, proposal.rule);
  for (let scan = 0; scan < 2; scan++) {
    const { graph, coverage } = await scanRepo(project, repo);
    assert.ok(routes(graph?.nodes).includes('api:route:HEAD /ping'));
    assert.ok(!coverage.missed.some((suspect) => suspect.file === 'src/server.ts' && suspect.line === 17), 'no longer possibly missed');
  }
});

test('"you missed this" on a middleware marks it as an auth guard', async () => {
  const app = join(tmp, 'guard-app');
  mkdirSync(join(app, 'src'), { recursive: true });
  writeFileSync(join(app, 'package.json'), JSON.stringify({ dependencies: { express: '^4.19.2' } }));
  writeFileSync(
    join(app, 'src/server.ts'),
    [
      "import express from 'express';",
      'const app = express();',
      '// Lets only requests with a session cookie through; nothing in its name or body says "auth".',
      'export function hasSession(req: { headers: Record<string, string> }, res: { redirect(to: string): void }, next: () => void) {',
      "  if (!req.headers.cookie) return res.redirect('/login');",
      '  next();',
      '}',
      "app.get('/inbox', hasSession, (req, res) => res.json({ messages: [] }));",
    ].join('\n'),
  );
  const project = tempProject(join(tmp, 'guard-project'));
  const repo = addRepo(project, app, 'api').config.repos[0];
  const proposal = await proposeRule(project, repo, { file: 'src/server.ts', line: 4 });
  assert.deepEqual({ ...proposal.rule, added: 'today' }, { type: 'guard', scope: 'express', name: 'hasSession', example: 'src/server.ts:4', added: 'today' });
  assert.deepEqual(proposal.finds, ['api:guard:hasSession']);
  addRule(app, proposal.rule);
  const { graph } = await scanRepo(project, repo);
  assert.ok(graph?.edges.some((edge) => edge.from === 'api:route:GET /inbox' && edge.to === 'api:guard:hasSession' && edge.kind === 'guarded-by'));
});

test('a place already in the graph, or with nothing to find, gets no rule', async () => {
  const { project, dir } = copy('express-basic', 'nothing');
  const repo = addRepo(project, dir, 'api').config.repos[0];
  await assert.rejects(proposeRule(project, repo, { file: 'src/server.ts', line: 8 }), (error) => error instanceof FlowsError && /already in the graph: api:route:GET \/health/.test(error.message));
  await assert.rejects(proposeRule(project, repo, { file: 'src/config.ts', line: 1 }), (error) => error instanceof FlowsError && /no rule Flows can build/.test(error.message));
});

test('"not a flow": an excluded node stays out of every scan', async () => {
  const { project, dir } = copy('express-basic', 'exclude');
  const repo = addRepo(project, dir, 'api').config.repos[0];
  addRule(dir, { type: 'exclude', node: 'api:route:GET /health', added: now() });
  for (let scan = 0; scan < 2; scan++) {
    const { graph, coverage } = await scanRepo(project, repo);
    assert.ok(!routes(graph?.nodes).includes('api:route:GET /health'));
    assert.ok(!graph?.edges.some((edge) => edge.from === 'api:route:GET /health'));
    // The route's own inline handler and its response go with it.
    assert.deepEqual(coverage.excluded.sort(), ['api:handler:GET /health', 'api:response:GET /health#200', 'api:route:GET /health']);
    assert.ok(!graph?.nodes.some((node) => node.id.includes('/health')));
  }
});

// The unknown-framework fixture: three Hono routes on lines 5, 6 and 7 of src/index.ts.
const hono = new Map([['src/index.ts', readFileSync(join(fixtures, 'unknown-hono/src/index.ts'), 'utf8')]]);
const all = ['src/index.ts:5', 'src/index.ts:6', 'src/index.ts:7'];
const good: Draft = { pattern: 'app.$METHOD($PATH, $$$HANDLERS)', path: '$PATH', method: '$METHOD' };

const drafts: { name: string; draft: Draft; examples: string[]; reason: RegExp }[] = [
  { name: 'misses an example', draft: { pattern: 'app.get($PATH, $$$HANDLERS)', path: '$PATH', method: 'GET' }, examples: all, reason: /does not match src\/index\.ts:7/ },
  { name: 'matches lines that are not examples', draft: good, examples: all.slice(0, 2), reason: /also matches src\/index\.ts:7/ },
  { name: 'cannot read the path', draft: { pattern: 'app.$METHOD($$$ARGS)', path: '$PATH', method: '$METHOD' }, examples: all, reason: /can't read a fixed path/ },
  { name: 'has no method for a route', draft: { pattern: 'app.$METHOD($PATH, $$$HANDLERS)', path: '$PATH' }, examples: all, reason: /needs a method/ },
];

for (const { name, draft, examples, reason } of drafts) {
  test(`a drafted rule that ${name} is rejected`, () => {
    const result = checkDraft(draft, 'route', examples, hono);
    assert.equal(result.accepted, false);
    assert.match(result.accepted ? '' : result.reason, reason);
  });
}

test('a drafted rule that reproduces the examples is kept, and builds a graph for a framework with no adapter', async () => {
  const answered: string[] = [];
  const gateway: LlmGateway = {
    model: 'fake',
    async completeJson(request) {
      answered.push(request.prompt);
      return request.schema.parse(good);
    },
  };
  const result = await draftRule(gateway, 'route', all, hono);
  assert.ok(result.accepted, result.accepted ? '' : result.reason);
  assert.match(answered[0], /src\/index\.ts:6:\napp\.get\('\/users\/:id'/);

  const { project, dir } = copy('unknown-hono', 'hono');
  const repo = addRepo(project, dir, 'api').config.repos[0];
  assert.equal((await scanRepo(project, repo)).graph, undefined, 'no adapter and no rules: no graph');
  addRule(dir, result.rule);
  const { graph } = await scanRepo(project, repo);
  assert.equal(graph?.framework, 'learned');
  assert.deepEqual(routes(graph?.nodes).sort(), ['api:route:GET /health', 'api:route:GET /users/:id', 'api:route:POST /users']);
});

test('live: the local model drafts a rule for the Hono routes; it is kept only if it reproduces them', { skip: liveSkip }, async (t) => {
  const gateway = createGateway({ provider: 'openai-compatible', base_url: 'http://localhost:11434/v1', model: 'llama3.2:3b', timeout_ms: 120_000 }, new MemoryTraceSink());
  const result = await draftRule(gateway, 'route', all, hono);
  t.diagnostic(result.accepted ? `accepted: ${JSON.stringify(result.rule.rule.rule)}` : `rejected: ${result.reason}`);
  if (result.accepted) assert.deepEqual(checkDraft({ pattern: String(result.rule.rule.rule.pattern), path: result.rule.path, method: result.rule.method }, 'route', all, hono), result);
});
