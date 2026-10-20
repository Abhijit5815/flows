import type { Flow } from '../model/flow.ts';

// One line per step, in the shape of the fixtures' expected-flows.json and of `flows show flows`.
export function stepLine(step: Flow['steps'][number]): string {
  const check = step.check === null ? '' : ` | check ${step.check.kind === 'api' ? [step.check.status, ...(step.check.fields ?? [])].filter((part) => part !== undefined).join(' ') : (step.check.page ?? step.check.element)}`;
  return `${step.kind}: ${step.claim}${step.subflow_ref === undefined ? '' : ` -> ${step.subflow_ref}`}${check}`;
}

export const flowViews = (flows: readonly Flow[]) => flows.map((flow) => ({ id: flow.id, name: flow.name, steps: flow.steps.map(stepLine) }));
