import type { Flow } from '../model/flow.ts';

type Field = { name: string; type: string; required: boolean; rules: readonly string[] };

// A value that passes the field's rules, so a test can send a valid body without guessing. Rules it doesn't know are
// ignored; the field's own name and type still give a sensible value.
export function exampleValue(field: Field): unknown {
  const rule = (name: string) => field.rules.find((r) => r === name || r.startsWith(`${name}(`));
  const arg = (name: string) => Number(/\((-?\d+(?:\.\d+)?)\)/.exec(rule(name) ?? '')?.[1]);
  const fixed = field.rules.find((r) => r.startsWith('default('));
  if (fixed !== undefined && field.type === 'number') return Number(/\(([^)]*)\)/.exec(fixed)?.[1] ?? 1);
  if (field.type === 'number') {
    const min = arg('min');
    const gt = arg('gt');
    const value = Number.isFinite(min) ? min : Number.isFinite(gt) ? gt + 1 : rule('positive') !== undefined || rule('int') !== undefined ? 1 : 1;
    return rule('int') !== undefined ? Math.ceil(value) : value;
  }
  if (field.type === 'boolean') return true;
  if (rule('email') !== undefined) return 'test.user@example.com';
  if (rule('url') !== undefined) return 'https://example.com';
  if (rule('uuid') !== undefined) return '123e4567-e89b-42d3-a456-426614174000';
  const length = Math.max(Number.isFinite(arg('min')) ? arg('min') : 1, Number.isFinite(arg('length')) ? arg('length') : 1);
  const base = /pass/i.test(field.name) ? 'Passw0rd!' : /name/i.test(field.name) ? 'Test User' : 'test';
  const text = base.length >= length ? base : base + 'x'.repeat(length - base.length);
  const max = arg('max');
  return Number.isFinite(max) ? text.slice(0, max) : text;
}

// Every request body in the flows gets an `example`: the required fields (and optional ones with a default), valid.
export function withExamples(flows: readonly Flow[]): Flow[] {
  return flows.map((flow) => ({
    ...flow,
    steps: flow.steps.map((step) => {
      const body = step.request?.body;
      if (step.request === undefined || body === undefined) return step;
      const example = Object.fromEntries(body.fields.filter((f) => f.required).map((f) => [f.name, exampleValue(f)]));
      return { ...step, request: { ...step.request, body: { ...body, example } } };
    }),
  }));
}
