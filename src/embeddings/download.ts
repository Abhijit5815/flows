import { createHash } from 'node:crypto';
import { createWriteStream, existsSync, mkdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ReadableStream } from 'node:stream/web';
import { ChecksumError, FlowsError, ProviderError } from '../shared/errors.ts';
import type { CatalogueEntry } from './catalogue.ts';

export type Progress = (file: string, received: number, total: number) => void;

// What a download needs; embedding models and the entailment model both have it.
export type ModelFiles = Pick<CatalogueEntry, 'source' | 'revision' | 'files'>;

type ExpectedFile = ModelFiles['files'][number];

// <models>/<owner>/<name>/<revision>, so different revisions never share files.
export const modelDir = (modelsDir: string, entry: ModelFiles): string =>
  join(modelsDir, new URL(entry.source).pathname.slice(1), entry.revision);

// Fetches missing files from the publisher at the pinned revision; a file is kept only if its sha256 matches.
export async function ensureModelFiles(entry: ModelFiles, modelsDir: string, onProgress?: Progress): Promise<string> {
  const dir = modelDir(modelsDir, entry);
  for (const file of entry.files) {
    const target = join(dir, file.path);
    // shortcut: files on disk were hash-checked when written, so only their size is checked here; add a re-hash command if tampering becomes a concern.
    if (existsSync(target) && statSync(target).size === file.size) continue;
    await downloadVerified(`${entry.source}/resolve/${entry.revision}/${file.path}`, target, file, onProgress);
  }
  return dir;
}

async function downloadVerified(url: string, target: string, expected: ExpectedFile, onProgress?: Progress): Promise<void> {
  mkdirSync(dirname(target), { recursive: true });
  const partial = `${target}.partial`;
  try {
    const hash = createHash('sha256');
    let received = 0;
    try {
      const response = await fetch(url);
      if (!response.ok || response.body === null) throw new ProviderError(`GET ${url} returned ${response.status}`, response.status);
      const measure = new Transform({
        transform(chunk: Buffer, _encoding, done) {
          hash.update(chunk);
          received += chunk.length;
          onProgress?.(expected.path, received, expected.size);
          done(null, chunk);
        },
      });
      await pipeline(Readable.fromWeb(response.body as ReadableStream<Uint8Array>), measure, createWriteStream(partial));
    } catch (error) {
      if (error instanceof FlowsError) throw error;
      throw new ProviderError(`GET ${url} failed: ${error instanceof Error ? error.message : String(error)}`, undefined, { cause: error });
    }
    const digest = hash.digest('hex');
    if (received !== expected.size || digest !== expected.sha256) {
      throw new ChecksumError(`${url}: expected ${expected.size} bytes with sha256 ${expected.sha256}, got ${received} bytes with sha256 ${digest}`);
    }
    renameSync(partial, target);
  } finally {
    rmSync(partial, { force: true });
  }
}
