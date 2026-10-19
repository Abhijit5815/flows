import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { ChecksumError, ProviderError } from '../shared/errors.ts';
import { sha256 } from '../shared/hash.ts';
import { startFakeServer } from '../shared/testing/fake-server.ts';
import type { CatalogueEntry } from './catalogue.ts';
import { ensureModelFiles, modelDir } from './download.ts';

const content = 'weights '.repeat(1000);
const server = await startFakeServer((request, response) => {
  if (request.url.endsWith('/cut-off.bin')) {
    response.writeHead(200, { 'content-length': '100000' });
    response.write(content.slice(0, 100));
    response.socket?.destroy();
  } else if (request.url.endsWith('/missing.bin')) {
    response.writeHead(404).end();
  } else {
    response.end(content);
  }
});
const tmp = mkdtempSync(join(tmpdir(), 'flows-download-'));
after(async () => {
  await server.close();
  rmSync(tmp, { recursive: true, force: true });
});

const entry = (file: string, hash = sha256(content)): CatalogueEntry => ({
  id: 'test-model',
  source: `${server.url}/owner/model`,
  revision: 'a'.repeat(40),
  license: 'MIT',
  dtype: 'fp32',
  pooling: 'cls',
  dims: 4,
  max_tokens: 8,
  files: [{ path: `onnx/${file}`, size: content.length, sha256: hash }],
});

const leftovers = (dir: string) => (existsSync(dir) ? readdirSync(dir) : []);

test('a file whose sha256 matches is kept, under owner/name/revision, and not downloaded twice', async () => {
  const models = join(tmp, 'ok');
  const progress: number[] = [];
  const dir = await ensureModelFiles(entry('model.onnx'), models, (_file, received) => progress.push(received));
  assert.equal(dir, join(models, 'owner', 'model', 'a'.repeat(40)));
  assert.equal(readFileSync(join(dir, 'onnx', 'model.onnx'), 'utf8'), content);
  assert.equal(progress.at(-1), content.length);

  const before = server.requests.length;
  await ensureModelFiles(entry('model.onnx'), models);
  assert.equal(server.requests.length, before);
});

test('a file whose sha256 does not match is a ChecksumError and nothing is kept', async () => {
  const models = join(tmp, 'bad-hash');
  const bad = entry('model.onnx', 'b'.repeat(64));
  await assert.rejects(ensureModelFiles(bad, models), ChecksumError);
  assert.deepEqual(leftovers(join(modelDir(models, bad), 'onnx')), []);
});

test('a cut-off download is a ProviderError and nothing is kept', async () => {
  const models = join(tmp, 'cut');
  const cut = entry('cut-off.bin');
  await assert.rejects(ensureModelFiles(cut, models), ProviderError);
  assert.deepEqual(leftovers(dirname(join(modelDir(models, cut), cut.files[0].path))), []);
});

test('a missing file is a ProviderError with the HTTP status', async () => {
  await assert.rejects(ensureModelFiles(entry('missing.bin'), join(tmp, 'missing')), (error: unknown) => error instanceof ProviderError && error.status === 404);
});
