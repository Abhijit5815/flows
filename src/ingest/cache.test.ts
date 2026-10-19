import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { cachedFacts, type SourceFile } from './cache.ts';

const tmp = mkdtempSync(join(tmpdir(), 'flows-facts-'));
after(() => rmSync(tmp, { recursive: true, force: true }));

// Stand-in for an adapter's per-file parse: the facts are the line count.
const lines = (file: SourceFile) => file.source.split('\n').length;
const run = (file: string, sources: SourceFile[], version = 'v1') => cachedFacts(file, version, z.number(), sources, lines);

test('a second scan parses nothing; editing one file parses only that file', () => {
  const file = join(tmp, 'facts.json');
  const sources = [
    { path: 'a.ts', source: 'one' },
    { path: 'b.ts', source: 'one\ntwo' },
    { path: 'c.ts', source: 'x' },
  ];
  assert.deepEqual(run(file, sources).computed, ['a.ts', 'b.ts', 'c.ts']);
  assert.deepEqual(run(file, sources).computed, []);

  sources[1] = { path: 'b.ts', source: 'one\ntwo\nthree' };
  const edited = run(file, sources);
  assert.deepEqual(edited.computed, ['b.ts']);
  assert.deepEqual([...edited.facts], [['a.ts', 1], ['b.ts', 3], ['c.ts', 1]]);
});

test('deleted files drop out, and new rules (a new version) parse everything again', () => {
  const file = join(tmp, 'versions.json');
  const sources = [
    { path: 'a.ts', source: 'one' },
    { path: 'b.ts', source: 'two' },
  ];
  run(file, sources);
  const shrunk = run(file, sources.slice(0, 1));
  assert.deepEqual([...shrunk.facts.keys()], ['a.ts']);
  assert.deepEqual(run(file, sources.slice(0, 1)).computed, []);
  assert.deepEqual(run(file, sources.slice(0, 1), 'v2').computed, ['a.ts']);
});

test('a damaged cache file is rebuilt, not trusted', () => {
  const file = join(tmp, 'damaged.json');
  writeFileSync(file, '{ "version": "v1", "files": { "a.ts": { "hash": 1 } } }');
  assert.deepEqual(run(file, [{ path: 'a.ts', source: 'one' }]).computed, ['a.ts']);
});
