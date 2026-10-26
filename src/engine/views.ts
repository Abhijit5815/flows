import type { Flow } from '../model/flow.ts';

// One line per step, in the shape of the fixtures' expected-flows.json and of `flows show flows`.
export function stepLine(step: Flow['steps'][number]): string {
  const check = step.check === null ? '' : ` | check ${step.check.kind === 'api' ? [step.check.status, ...(step.check.fields ?? [])].filter((part) => part !== undefined).join(' ') : (step.check.page ?? step.check.element)}`;
  return `${step.kind}: ${step.claim}${step.subflow_ref === undefined ? '' : ` -> ${step.subflow_ref}`}${check}`;
}

// The request body and the errors under a step, a line each: what negative and edge-case tests are written from.
export function stepDetails(step: Flow['steps'][number]): string[] {
  const body = step.request?.body;
  const fields = body?.fields.map((field) => `${field.name}${field.required ? '' : '?'}: ${[field.type, ...field.rules].join(' ')}`) ?? [];
  return [
    ...(body === undefined ? [] : [`body ${body.schema} { ${fields.join(', ')} }`]),
    ...(step.errors ?? []).map((error) => (error.kind === 'api' ? `error ${error.status} from ${error.by}${error.message === undefined ? '' : `: ${error.message}`}` : `error: ${error.message}`)),
  ];
}

export const flowViews = (flows: readonly Flow[]) =>
  flows.map((flow) => ({ id: flow.id, name: flow.name, steps: flow.steps.flatMap((step) => [stepLine(step), ...stepDetails(step).map((line) => `  ${line}`)]) }));
