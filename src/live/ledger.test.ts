import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createdIn } from './ledger.ts';
import { ruleValue } from './forms.ts';
import type { Run } from './run.ts';

const run = (notes: string[]) =>
  ({
    id: 'r1',
    notes,
    requests: [
      { kind: 'api', method: 'GET', path: '/api/ideas', blocked: false, status: 200 },
      { kind: 'api', method: 'POST', path: '/api/ideas', blocked: false, status: 201, response: { body: { data: { id: 'abc' } } } },
      { kind: 'api', method: 'POST', path: '/api/blocked', blocked: true, status: null },
      { kind: 'api', method: 'DELETE', path: '/api/ideas/x', blocked: false, status: 500 },
    ],
  }) as unknown as Run;

test('the ledger lists only writes the app answered, and only for a run that was allowed to write', () => {
  assert.deepEqual(createdIn(run(['writes to test hosts were allowed'])), [{ run: 'r1', method: 'POST', path: '/api/ideas', status: 201, id: 'abc' }]);
  assert.deepEqual(createdIn(run([])), []);
});

test('typed text carries the marker, other kinds of value do not', () => {
  assert.equal(ruleValue({ type: 'text', options: [] }, 'Test Flows '), 'Test Flows test');
  assert.equal(ruleValue({ type: 'email', options: [] }, 'Test Flows '), 'explorer@example.com');
  assert.equal(ruleValue({ type: 'text', options: [] }), 'test');
});
