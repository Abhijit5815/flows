import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Category } from '../model/category.ts';
import type { Flow } from '../model/flow.ts';
import { exportFlows } from './export.ts';
import type { FlowSet } from './store.ts';

const step = { id: 's1', kind: 'ui' as const, claim: 'Open /', evidence: [{ type: 'code' as const, node_id: 'web:page:/', ref: 'app/page.tsx:1' }], check: null, enabled: true };
const flow = (id: string, change: Partial<Flow> = {}): Flow => ({
  schema_version: 0, id, name: id, category: 'browse', kind: 'ui', origin: 'source', status: 'verified', confidence: 0.9,
  enabled: true, destructive: 'no', priority: 'medium', tags: [], version: 1, steps: [step], ...change,
});
const set = (flows: Flow[]): FlowSet => ({ flows, reasons: {}, rejected: [], decisions: {}, unreachable: [], notes: [], runs: [], roles: [] });
const browse: Category = { id: 'browse', name: 'Browse', color: '#336699', editable: true, enabled: true };

test('export: enabled flows in enabled categories, with the subflows they run even when those are off', () => {
  const login = flow('login', { enabled: false });
  const runsLogin = flow('cart', { steps: [{ ...step, id: 's0', kind: 'subflow', claim: 'Run "login"', subflow_ref: 'login' }, step] });
  const flows = [login, runsLogin, flow('off', { enabled: false }), flow('refused', { status: 'rejected', enabled: true }), flow('hidden', { category: 'admin' })];
  const admin: Category = { ...browse, id: 'admin', enabled: false };
  assert.deepEqual(exportFlows([set(flows)], [browse, admin]).flows.map((own) => own.id), ['cart', 'login']);
  assert.deepEqual(exportFlows([set(flows)], [{ ...browse, enabled: false }, admin]).flows, [], 'every chosen flow is in a switched-off category');
});
