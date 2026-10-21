import type { Locator } from 'playwright-core';
import { z } from 'zod';
import type { OptionalLlm } from '../engine/llm.ts';
import { redactText } from './redact.ts';
import type { State } from './run.ts';

type Field = State['forms'][number]['fields'][number];

const today = () => new Date().toISOString().slice(0, 10);

// A value each kind of field accepts, from its type alone (PLAN.md Phase 3: rules first). Undefined leaves the field
// as the page set it: hidden fields, choices, and anything secret. Writes never reach the app (readonly.ts), so these
// values only have to pass the browser's own checks.
export function ruleValue(field: Pick<Field, 'type' | 'options'>): string | undefined {
  switch (field.type) {
    case 'hidden':
    case 'checkbox':
    case 'radio':
    case 'file':
    case 'password':
      return undefined;
    case 'select':
      return field.options.find((option) => option !== '');
    case 'email':
      return 'explorer@example.com';
    case 'number':
    case 'range':
      return '1';
    case 'tel':
      return '5550100';
    case 'url':
      return 'https://example.com';
    case 'date':
      return today();
    case 'datetime-local':
      return `${today()}T12:00`;
    case 'time':
      return '12:00';
    case 'month':
      return today().slice(0, 7);
    case 'week':
      return `${today().slice(0, 4)}-W01`;
    case 'color':
      return '#336699';
    default:
      return 'test';
  }
}

const ValuesSchema = z.object({ values: z.record(z.string(), z.string().max(200)) });

const SYSTEM =
  'You fill in web forms for a read-only test crawler. You get the fields the browser still rejects, with their ' +
  'labels and HTML constraints. Reply with JSON only: {"values": {"<field name>": "<value>"}}, one plausible test ' +
  'value per field that meets its constraints. Never use real personal data.';

// The names of the fields the browser rejects, with what constrains them.
const invalid = (form: Locator) =>
  form.evaluate(
    (element) =>
    [...(element as HTMLFormElement).elements].flatMap((control) => {
      const input = control as HTMLInputElement;
      if (typeof input.checkValidity !== 'function' || input.checkValidity() || input.name === '') return [];
      const label = input.labels?.[0]?.textContent ?? input.placeholder ?? '';
      return [{ name: input.name, type: input.type, label: label.trim(), pattern: input.pattern ?? '', min: input.min ?? '', max: input.max ?? '', minlength: input.minLength, maxlength: input.maxLength, message: input.validationMessage }];
    }),
    undefined,
    { timeout: 5000 },
  );

const fill = async (form: Locator, name: string, type: string, value: string) => {
  const field = form.locator(`[name=${JSON.stringify(name)}]`).first();
  if (type === 'select') await field.selectOption(value, { timeout: 2000 });
  else await field.fill(value, { timeout: 2000 });
};

export type Filled = { ok: true } | { ok: false; reason: string };

// Fills the form by rule, then asks the LLM only for the fields the browser still rejects (PLAN.md Phase 3: the LLM is
// only for ambiguous forms), and keeps an answer only if the browser accepts it. With the assistant provider the
// question becomes a job, and the form is tried again on the next run.
export async function fillForm(form: Locator, fields: readonly Field[], llm: OptionalLlm): Promise<Filled> {
  for (const field of fields) {
    const value = field.visible ? ruleValue(field) : undefined;
    if (value !== undefined) await fill(form, field.name, field.type, value).catch(() => undefined);
  }
  const rejected = await invalid(form);
  if (rejected.length === 0) return { ok: true };
  const facts = rejected.map((field) => ({ ...field, label: redactText(field.label), message: redactText(field.message) }));
  const reply = await llm.ask({ purpose: 'form-values', system: SYSTEM, prompt: JSON.stringify(facts), schema: ValuesSchema });
  if (reply === undefined) return { ok: false, reason: `the browser rejects ${rejected.map((field) => field.name).join(', ')}, and no LLM answer is available${llm.pending > 0 ? ' yet (see "flows jobs")' : ''}` };
  for (const field of rejected) {
    const value = reply.values[field.name];
    if (value !== undefined) await fill(form, field.name, field.type, value).catch(() => undefined);
  }
  const still = await invalid(form);
  return still.length === 0 ? { ok: true } : { ok: false, reason: `the browser still rejects ${still.map((field) => field.name).join(', ')} after the LLM's values` };
}
