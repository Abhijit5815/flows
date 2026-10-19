import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { addRepo } from '../config/project.ts';
import { createEmbeddingProvider } from '../embeddings/create.ts';
import type { EmbeddingProvider } from '../embeddings/provider.ts';
import { liveModelsDir, liveSkip } from '../shared/testing/live.ts';
import { tempProject } from '../shared/testing/project.ts';
import { scanRepo } from './pipeline.ts';

const tmp = mkdtempSync(join(tmpdir(), 'flows-missed-'));
after(() => rmSync(tmp, { recursive: true, force: true }));

// Deterministic stand-in for the model: code that takes (req, res) points one way, everything else the other.
function fakeEmbedder(): EmbeddingProvider & { embedded: number } {
  return {
    version: 'fake-1',
    embedded: 0,
    async embed(texts) {
      this.embedded += texts.length;
      return texts.map((text) => Float32Array.from(/\(req\b/.test(text) ? [1, 0] : [0, 1]));
    },
  };
}

test('embedding search lists handler-like entry points only: not graph code, not code the app calls', async () => {
  const app = join(tmp, 'app');
  mkdirSync(join(app, 'src'), { recursive: true });
  writeFileSync(join(app, 'package.json'), JSON.stringify({ dependencies: { express: '^4.19.2' } }));
  writeFileSync(
    join(app, 'src/server.ts'),
    [
      "import express from 'express';",
      'const app = express();',
      'export const list = (req: unknown, res: { json(body: unknown): void }) => { audit(req, res); res.json({ rows: [] }); };',
      "app.get('/rows', list);",
      '// Called by list: supporting code, even though it looks like a handler.',
      'export function audit(req: unknown, res: unknown) { return [req, res]; }',
      '// Nothing calls or routes it: a possible missed handler.',
      'export function exportAll(req: unknown, res: { send(body: string): void }) { res.send(""); }',
      '// Not like a handler at all.',
      'export const formatRow = (row: string) => row.trim();',
    ].join('\n'),
  );
  const project = tempProject(join(tmp, 'project'));
  const repo = addRepo(project, app, 'api').config.repos[0];
  const embedder = fakeEmbedder();
  const { graph, coverage } = await scanRepo(project, repo, { embedder, possiblyMissed: { minSimilarity: 0.5, limit: 10 } });
  const byEmbedding = coverage.missed.filter((suspect) => suspect.similarity !== undefined).map((suspect) => `${suspect.file}:${suspect.line}`);
  assert.deepEqual(byEmbedding, ['src/server.ts:8']);
  assert.ok(coverage.embeddingSearch);
  assert.ok(!graph?.nodes.some((node) => node.line === 8), 'a possibly missed handler must never enter the graph');

  // The vectors are cached per function: a second scan embeds nothing.
  const before = embedder.embedded;
  await scanRepo(project, repo, { embedder, possiblyMissed: { minSimilarity: 0.5, limit: 10 } });
  assert.equal(embedder.embedded, before);
});

const fixture = fileURLToPath(new URL('../../fixtures/apps/express-basic/', import.meta.url));

test('live: with bge-small, the unrouted exportCsv handler is listed by the embedding search', { skip: liveSkip }, async (t) => {
  const project = tempProject(join(tmp, 'live'));
  const embedder = createEmbeddingProvider({ provider: 'local', model: 'bge-small-en-v1.5' }, liveModelsDir);
  const { coverage } = await scanRepo(project, addRepo(project, fixture, 'api').config.repos[0], { embedder });
  const exportCsv = coverage.missed.find((suspect) => suspect.file === 'src/controllers/users.controller.ts' && suspect.line === 33);
  assert.ok(exportCsv?.similarity !== undefined, JSON.stringify(coverage.missed));
  t.diagnostic(coverage.missed.map((suspect) => `${suspect.file}:${suspect.line} ${suspect.similarity?.toFixed(3) ?? 'pattern'}`).join(' | '));
});
