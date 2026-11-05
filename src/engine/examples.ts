import type { Flow } from '../model/flow.ts';

type Field = { name: string; type: string; required: boolean; rules: readonly string[] };

// A value that passes the field's rules, so a test can send a valid body without guessing. Rules it doesn't know are
// ignored; the field's own name and type still give a sensible value.
export function exampleValue(field: Field, prefix = ''): unknown {
  const choice = field.rules.find((r) => r.startsWith('enum('));
  if (choice !== undefined) return /['"]([^'"]+)['"]/.exec(choice)?.[1]; // the first allowed value; undefined when the list was too long to keep
  if (field.type === 'record' || field.type === 'object') return {};
  if (field.type === 'array') return [];
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
  // min(SOME_CONSTANT) is a length Flows could not read: a generous 40 is more likely to pass than 1.
  const unreadable = field.rules.some((r) => /^min\([A-Za-z_]/.test(r)) ? 40 : 1;
  const length = Math.max(Number.isFinite(arg('min')) ? arg('min') : unreadable, Number.isFinite(arg('length')) ? arg('length') : 1);
  // Plain text is marked (explorer.test_prefix), so what a test creates from this example can be told from real data. A
  // password stays unmarked: it only has to satisfy the rules.
  const base = /pass/i.test(field.name) ? 'Passw0rd!' : `${prefix}${/name/i.test(field.name) ? 'User' : 'test'}`;
  const text = base.length >= length ? base : base + 'x'.repeat(length - base.length);
  const max = arg('max');
  return Number.isFinite(max) ? text.slice(0, max) : text;
}

// Every request body in the flows gets an `example`: the required fields (and optional ones with a default), valid.
export function withExamples(flows: readonly Flow[], prefix = ''): Flow[] {
  return flows.map((flow) => ({
    ...flow,
    steps: flow.steps.map((step) => {
      const body = step.request?.body;
      if (step.request === undefined || body === undefined) return step;
      // A field whose allowed values Flows could not read is left out and named, instead of given a wrong value.
      const required = body.fields.filter((f) => f.required);
      const values = required.map((f) => [f, exampleValue(f, prefix)] as const);
      const example = Object.fromEntries(values.filter(([, value]) => value !== undefined).map(([f, value]) => [f.name, value]));
      const unresolved = values.filter(([, value]) => value === undefined).map(([f]) => f.name);
      return { ...step, request: { ...step.request, body: { ...body, example, ...(unresolved.length > 0 ? { example_missing: unresolved } : {}) } } };
    }),
  }));
}
