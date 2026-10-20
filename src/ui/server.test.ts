import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { cpSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { addRepo, categories } from '../config/project.ts';
import type { Decider } from '../decider/decider.ts';
import { buildFlows } from '../engine/engine.ts';
import { OptionalLlm } from '../engine/llm.ts';
import { saveFlows } from '../engine/store.ts';
import { scanRepo } from '../ingest/pipeline.ts';
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

const unsure: Decider = { decide: async () => ({ label: 'unknown', prob: 0.5, all_probs: {}, version: 'stub' }) };

before(async () => {
  const project = addRepo(tempProject(join(tmp, 'project')), fixture, 'web');
  const repo = project.config.repos[0];
  const { graph } = await scanRepo(project, repo);
  assert.ok(graph);
  const deps = { decider: unsure, grounding: unsure, llm: new OptionalLlm(undefined, join(tmp, 'llm.json'), () => {}), trace: new MemoryTraceSink(), categories: categories(project.config), categoryLabels: [], config: project.config.engine };
  saveFlows(project, repo, await buildFlows(graph, { verdicts: new Map(), edits: { schema_version: 0, overrides: {}, added: [] } }, deps));
  ui = await startUi(project);
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

