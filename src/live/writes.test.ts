import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LiveError } from '../shared/errors.ts';
import { isTestHost, requireTestHost } from './writes.ts';

test('only test hosts may be written to', () => {
  for (const host of ['localhost', '127.0.0.1', '[::1]', 'app.localhost', 'shop.test']) assert.equal(isTestHost(host, []), true, host);
  assert.equal(isTestHost('staging.example.com', []), false);
  assert.equal(isTestHost('staging.example.com', ['staging.example.com']), true);
  assert.throws(() => requireTestHost('https://www.example.com/', []), (error) => error instanceof LiveError && /not one/.test(error.message));
  assert.doesNotThrow(() => requireTestHost('http://localhost:3000/', []));
});
