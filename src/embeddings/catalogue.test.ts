import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ProjectConfigSchema } from '../config/project.ts';
import { ConfigError } from '../shared/errors.ts';
import { CATALOGUE, catalogueEntry } from './catalogue.ts';

test('every catalogue model is MIT or Apache-2.0 licensed (PLAN.md §6 default list)', () => {
  for (const entry of CATALOGUE) assert.ok(['MIT', 'Apache-2.0'].includes(entry.license), `${entry.id}: ${entry.license}`);
});

test('the default embedder in config exists in the catalogue', () => {
  const config = ProjectConfigSchema.parse({ schema_version: 0, id: crypto.randomUUID(), name: 'x', repos: [] });
  assert.ok(config.embedder.provider === 'local');
  assert.equal(catalogueEntry(config.embedder.model).id, 'bge-small-en-v1.5');
});

test('an unknown model id is a ConfigError that lists the known ones', () => {
  assert.throws(() => catalogueEntry('nope'), (error: unknown) => error instanceof ConfigError && /bge-small-en-v1\.5/.test(error.message));
});
