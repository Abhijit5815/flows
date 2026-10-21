import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { LiveKeySchema } from './schema.ts';

const dir = fileURLToPath(new URL('./live/', import.meta.url));

for (const file of readdirSync(dir).filter((name) => name.endsWith('.json'))) {
  test(`live answer key ${file} is valid, with unique ids`, () => {
    const parsed = LiveKeySchema.safeParse(JSON.parse(readFileSync(join(dir, file), 'utf8')));
    assert.ok(parsed.success, parsed.success ? '' : z.prettifyError(parsed.error));
    const ids = parsed.data.flows.map((flow) => flow.id);
    assert.deepEqual(ids.filter((id, i) => ids.indexOf(id) !== i), []);
  });
}
