import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { GroundTruthSchema } from './schema.ts';

const keysDir = fileURLToPath(new URL('./', import.meta.url));
const samplesDir = fileURLToPath(new URL('../fixtures/samples/', import.meta.url));
const keyFiles = readdirSync(keysDir).filter((file) => file.endsWith('.json'));
const PAGE_FILE = /^page\.(tsx|ts|jsx|js)$/;

const duplicates = (keys: string[]) => keys.filter((key, i) => keys.indexOf(key) !== i);

test('answer keys exist', () => {
  assert.ok(keyFiles.length > 0, `no answer keys in ${keysDir}`);
});

for (const keyFile of keyFiles) {
  test(keyFile, async (t) => {
    const parsed = GroundTruthSchema.safeParse(JSON.parse(readFileSync(join(keysDir, keyFile), 'utf8')));
    assert.ok(parsed.success, parsed.success ? '' : z.prettifyError(parsed.error));
    const key = parsed.data;
    const checkout = join(samplesDir, key.app);

    await t.test('has no duplicate pages or endpoints', () => {
      assert.deepEqual(duplicates(key.pages.map((page) => page.path)), []);
      assert.deepEqual(duplicates(key.endpoints.map((endpoint) => `${endpoint.method} ${endpoint.path}`)), []);
    });

    await t.test('the sample is checked out at the pinned commit', () => {
      assert.ok(existsSync(checkout), `missing ${checkout}: run git submodule update --init`);
      const head = execFileSync('git', ['-C', checkout, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
      assert.equal(head, key.source.commit);
    });

    await t.test('every endpoint cites a line that registers that method', () => {
      for (const { method, path, file, line } of key.endpoints) {
        assert.ok(key.roles.api !== undefined && file.startsWith(`${key.roles.api}/`), `${file} is outside the api role`);
        const fullPath = join(checkout, file);
        assert.ok(existsSync(fullPath), `${file} does not exist`);
        const lines = readFileSync(fullPath, 'utf8').split('\n');
        assert.ok(line <= lines.length, `${file}:${line} is past the end of the file`);
        assert.ok(lines[line - 1].toLowerCase().includes(`.${method.toLowerCase()}(`), `${file}:${line} does not register ${method} ${path}`);
      }
    });

    await t.test('lists every page file of the web role, and nothing else', () => {
      const web = key.roles.web;
      if (web === undefined) {
        assert.deepEqual(key.pages, [], 'pages listed but there is no web role');
        return;
      }
      const appDir = [join(web, 'src', 'app'), join(web, 'app')].find((dir) => existsSync(join(checkout, dir)));
      assert.ok(appDir, `no app/ directory under ${web}`);
      const found = readdirSync(join(checkout, appDir), { recursive: true, encoding: 'utf8' })
        .filter((relative) => PAGE_FILE.test(basename(relative)))
        .map((relative) => join(appDir, relative))
        .sort();
      assert.deepEqual(key.pages.map((page) => page.file).sort(), found);
    });
  });
}
