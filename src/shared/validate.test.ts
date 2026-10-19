import { test } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { ConfigError } from './errors.ts';
import { parseOrThrow } from './validate.ts';

const Schema = z.object({ name: z.string().min(1) });

test('parseOrThrow returns typed data when it matches', () => {
  assert.deepEqual(parseOrThrow(Schema, { name: 'x' }, 'thing', ConfigError), { name: 'x' });
});

test('parseOrThrow throws the given error type, naming what failed and where', () => {
  assert.throws(
    () => parseOrThrow(Schema, { name: '' }, 'config.json', ConfigError),
    (error: unknown) => error instanceof ConfigError && /config\.json is invalid/.test(error.message) && /name/.test(error.message),
  );
});
