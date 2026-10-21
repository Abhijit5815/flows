import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { addRepo, categories, type Project } from '../config/project.ts';
import type { Decider } from '../decider/decider.ts';
import type { EmbeddingProvider } from '../embeddings/provider.ts';
import { buildFlows } from '../engine/engine.ts';
import { OptionalLlm } from '../engine/llm.ts';
import { saveFlows } from '../engine/store.ts';
import { scanRepo } from '../ingest/pipeline.ts';
import { runDir, saveRun, type Run } from '../live/run.ts';
import { tempProject } from '../shared/testing/project.ts';
import { MemoryTraceSink } from '../trace/sink.ts';
import { TOKEN_HEADER, type ProjectView, type Snippet } from './api.ts';
import { startUi, type Ui } from './server.ts';

const tmp = mkdtempSync(join(tmpdir(), 'flows-ui-'));
// Writes land in the repo's .flows/, so the page works on a copy of the fixture.
const fixture = join(tmp, 'next-basic');
cpSync(fileURLToPath(new URL('../../fixtures/apps/next-basic/', import.meta.url)), fixture, { recursive: true });
let ui: Ui;
let token = '';
let project: Project;

const unsure: Decider = { decide: async () => ({ label: 'unknown', prob: 0.5, all_probs: {}, version: 'stub' }) };

// Stand-in embedder: one dimension per word below, so a description matches the nodes that share its words.
const WORDS = ['login', 'cart', 'profile', 'products', 'orders', 'invoices'];
const embedder: EmbeddingProvider = {
  version: 'words',
  embed: async (texts) =>
    texts.map((text) => {
      const vector = Float32Array.from([...WORDS.map((word) => (text.toLowerCase().includes(word) ? 1 : 0)), 0.05]);
      const norm = Math.hypot(...vector);
      return vector.map((value) => value / norm);
    }),
};

before(async () => {
  project = addRepo(tempProject(join(tmp, 'project')), fixture, 'web');
  const repo = project.config.repos[0];
  const { graph } = await scanRepo(project, repo);
  assert.ok(graph);
  const deps = { decider: unsure, grounding: unsure, llm: new OptionalLlm(undefined, join(tmp, 'llm.json'), () => {}), trace: new MemoryTraceSink(), categories: categories(project.config), categoryLabels: [], config: project.config.engine };
  saveFlows(project, repo, await buildFlows(graph, { verdicts: new Map(), edits: { schema_version: 0, overrides: {}, added: [] } }, deps));
  ui = await startUi(project, { ...deps, embedder });
  token = /name="flows-token" content="([0-9a-f]+)"/.exec(await (await fetch(ui.url)).text())?.[1] ?? '';
});
after(async () => {
  await ui.close();
  rmSync(tmp, { recursive: true, force: true });
});

const api = (path: string, withToken = true) => fetch(new URL(path, ui.url), { headers: withToken ? { [TOKEN_HEADER]: token } : {} });

test('the page carries a token and its bundled script', async () => {
  assert.match(token, /^[0-9a-f]{48}$/);
  const script = await fetch(new URL('/app.js', ui.url));
  assert.equal(script.status, 200);
  assert.ok((await script.text()).length > 100_000, 'React and React Flow are in the bundle');
});

test('the API answers only calls that carry the token', async () => {
  assert.equal((await api('/api/project', false)).status, 403);
  const view = (await (await api('/api/project')).json()) as ProjectView;
  assert.equal(view.repos[0].set?.flows.length, 13);
});

test('a request for another host name is refused (DNS rebinding)', async () => {
  const { port } = new URL(ui.url);
  const status = await new Promise<number>((done, fail) =>
    request({ host: '127.0.0.1', port, path: '/api/project', headers: { host: `evil.example:${port}`, [TOKEN_HEADER]: token } }, (res) => done(res.statusCode ?? 0)).on('error', fail).end(),
  );
  assert.equal(status, 403);
});

test("snippets come only from the repo's own files", async () => {
  const repo = encodeURIComponent(((await (await api('/api/project')).json()) as ProjectView).repos[0].path);
  const found = (await (await api(`/api/snippet?repo=${repo}&file=middleware.ts&line=4`)).json()) as Snippet;
  assert.equal(found.lines[found.line - found.start].includes('middleware'), true);
  for (const file of ['../express-basic/package.json', '/etc/hosts', 'node_modules/x.js']) {
    assert.equal((await api(`/api/snippet?repo=${repo}&file=${encodeURIComponent(file)}&line=1`)).status, 404, file);
  }
});

const post = (path: string, body: unknown, withToken = true) =>
  fetch(new URL(path, ui.url), { method: 'POST', headers: { 'content-type': 'application/json', ...(withToken ? { [TOKEN_HEADER]: token } : {}) }, body: JSON.stringify(body) });

test('writes need the token, and a bad body is refused before anything is written', async () => {
  const repo = `web:${((await (await api('/api/project')).json()) as ProjectView).repos[0].path}`;
  assert.equal((await post('/api/feedback', { repo, flow: 'ui-e45ebcf5', kind: 'correct' }, false)).status, 403);
  assert.equal((await post('/api/feedback', { repo, flow: 'ui-e45ebcf5', kind: 'maybe' })).status, 400);
  assert.equal((await post('/api/flows/edit', { repo, flow: 'ui-e45ebcf5', patch: { enabled: 'yes' } })).status, 400);
  assert.equal(existsSync(join(fixture, '.flows')), false);
});

test("feedback, edits and bulk changes land in the repo's .flows/ and come back from the engine", async () => {
  const repo = `web:${((await (await api('/api/project')).json()) as ProjectView).repos[0].path}`;
  const flowOf = (view: ProjectView, id: string) => view.repos[0].set?.flows.find((flow) => flow.id === id);
  let view = (await (await post('/api/feedback', { repo, flow: 'ui-e45ebcf5', kind: 'wrong', comment: 'not a flow' })).json()) as ProjectView;
  assert.deepEqual([flowOf(view, 'ui-e45ebcf5')?.status, view.repos[0].verdicts['ui-e45ebcf5']], ['rejected', 'wrong']);
  view = (await (await post('/api/flows/edit', { repo, flow: 'ui-9076652b', patch: { name: 'See the login page', disabled_steps: ['s1'] } })).json()) as ProjectView;
  assert.deepEqual([flowOf(view, 'ui-9076652b')?.name, flowOf(view, 'ui-9076652b')?.version, flowOf(view, 'ui-9076652b')?.steps[0].enabled], ['See the login page', 2, false]);
  view = (await (await post('/api/bulk', { flows: [{ repo, flow: 'ui-e68b64da' }, { repo, flow: 'ui-19a7cdd3' }], patch: { enabled: false } })).json()) as ProjectView;
  assert.deepEqual([flowOf(view, 'ui-e68b64da')?.enabled, flowOf(view, 'ui-19a7cdd3')?.enabled], [false, false]);
  const saved = JSON.parse(readFileSync(join(fixture, '.flows', 'flows.json'), 'utf8'));
  assert.deepEqual(Object.keys(saved.overrides).sort(), ['ui-19a7cdd3', 'ui-9076652b', 'ui-e68b64da']);
  assert.match(readFileSync(join(fixture, '.flows', 'rules.json'), 'utf8'), /"kind": "wrong"/);
});

test('categories: rename, switch off and merge, with the fallback kept as it is', async () => {
  const view = (await (await api('/api/project')).json()) as ProjectView;
  const [first, second] = view.categories;
  const renamed = view.categories.filter((category) => category.id !== second.id).map((category) => (category.id === first.id ? { ...category, name: 'Accounts', enabled: false } : category));
  const after = (await (await post('/api/categories', { categories: renamed, merges: [{ from: second.id, to: first.id }] })).json()) as ProjectView;
  assert.deepEqual([after.categories[0].name, after.categories[0].enabled, after.categories.some((category) => category.id === second.id)], ['Accounts', false, false]);
  const fallbackless = renamed.filter((category) => category.id !== 'uncategorized');
  assert.equal((await post('/api/categories', { categories: fallbackless })).status, 400);
});

test('extracting steps as a subflow: the new flow and the flow that now runs it both pass', async () => {
  const view = (await (await api('/api/project')).json()) as ProjectView;
  const repo = `web:${view.repos[0].path}`;
  const cart = view.repos[0].set?.flows.find((flow) => flow.id === 'ui-3cb127a8');
  assert.ok(cart);
  const [login, ...rest] = cart.steps;
  const sub = { ...cart, id: 'ui-own-0000beef', name: 'See the cart', version: 1, steps: rest.map((step, i) => ({ ...step, id: `s${i + 1}` })) };
  assert.equal((await post('/api/flows/add', { repo, flow: sub })).status, 200);
  const run = { id: rest[0].id, kind: 'subflow', claim: 'Run "See the cart"', subflow_ref: sub.id, evidence: rest[0].evidence.slice(0, 1), check: null, enabled: true };
  const after = (await (await post('/api/flows/edit', { repo, flow: cart.id, patch: { steps: [login, run] } })).json()) as ProjectView;
  const flows = after.repos[0].set?.flows ?? [];
  assert.deepEqual(
    [flows.find((flow) => flow.id === sub.id)?.status, flows.find((flow) => flow.id === cart.id)?.status, flows.find((flow) => flow.id === cart.id)?.steps.map((step) => step.subflow_ref)],
    ['verified', 'verified', ['ui-082b51bb', 'ui-own-0000beef']],
  );
});

test('the palette, drawing a flow from picked nodes, and describing one in words', async () => {
  const view = (await (await api('/api/project')).json()) as ProjectView;
  const repo = `web:${view.repos[0].path}`;
  const nodes = (await (await api(`/api/nodes?repo=${encodeURIComponent(repo)}`)).json()) as { id: string; kind: string }[];
  assert.deepEqual([...new Set(nodes.map((node) => node.kind))].sort(), ['action', 'api-call', 'form', 'page']);
  const drawn = (await (await post('/api/draw', { repo, nodes: ['web:page:/account', 'web:form:ProfileForm#form', 'web:api-call:PATCH /api/me'], name: 'Update my profile' })).json()) as ProjectView;
  const made = drawn.repos[0].set?.flows.find((flow) => flow.name === 'Update my profile');
  assert.deepEqual([made?.status, made?.steps.map((step) => step.kind)], ['verified', ['subflow', 'ui', 'ui', 'api']]);
  assert.equal((await post('/api/draw', { repo, nodes: ['web:page:/nowhere'], name: 'x' })).status, 400);
  const described = (await (await post('/api/describe', { repo, text: 'add products to the cart' })).json()) as { flow?: { steps: { claim: string }[] }; message: string };
  assert.ok(described.flow, described.message);
  const nothing = (await (await post('/api/describe', { repo, text: 'export invoices as a spreadsheet' })).json()) as { flow?: unknown; closest: unknown[] };
  assert.deepEqual([nothing.flow, nothing.closest.length], [undefined, 5]);
});

test('observed evidence comes from the run index by id: a request as JSON, a screenshot as an image, never by path', async () => {
  const id = 'explorer-20261020t120000z-test';
  const run: Run = {
    schema_version: 0, id, kind: 'explorer', url: 'http://127.0.0.1:3000/', origin: 'http://127.0.0.1:3000', session: null, started: '2026-10-20T12:00:00Z', finished: '2026-10-20T12:01:00Z', browser: 'stub',
    states: [{ n: 0, url: 'http://127.0.0.1:3000/', path: '/', title: 'Home', text: '', links: [], buttons: [], forms: [], shot: 's0.jpg', from: null, requested: null }],
    actions: [],
    requests: [{ n: 0, state: 0, action: null, visit: 0, method: 'GET', url: 'http://127.0.0.1:3000/api/products', origin: 'http://127.0.0.1:3000', path: '/api/products', resource: 'fetch', kind: 'api', server_action: false, status: 200, blocked: false, failed: null, response: { type: 'application/json', fields: ['id'], body: [{ id: '1' }] }, noise: null }],
    sockets: [],
    notes: [],
  };
  mkdirSync(runDir(project, id), { recursive: true });
  writeFileSync(join(runDir(project, id), 's0.jpg'), Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
  saveRun(project, run);
  const at = (ref: string, withToken = true) => api(`/api/observed?ref=${encodeURIComponent(ref)}`, withToken);
  assert.equal((await at(`${id}#r0`, false)).status, 403);
  assert.deepEqual(((await (await at(`${id}#r0`)).json()) as { path: string }).path, '/api/products');
  const shot = await at(`${id}#s0.jpg`);
  assert.equal(shot.headers.get('content-type'), 'image/jpeg');
  assert.deepEqual(Buffer.from(await shot.arrayBuffer()), Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
  assert.equal((await at('../../etc/passwd#s0.jpg')).status, 400);
  assert.equal((await at(`${id}#r0.jpg`)).status, 400);
  assert.equal((await at('explorer-gone#s0')).status, 404);
  assert.equal((await at(`${id}#r9`)).status, 404);
});
