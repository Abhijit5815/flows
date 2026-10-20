import { useState } from 'react';
import { runClaim } from '../../engine/describe.ts';
import type { Flow } from '../../model/flow.ts';
import { Problem, useSend, type OnView } from './actions.tsx';
import { repoKey, type Item } from './model.ts';

type Step = Flow['steps'][number];

// A flow a person makes gets an id of its own kind that no scan will generate.
export const ownId = (kind: Flow['kind']): string => `${kind}-own-${crypto.getRandomValues(new Uint32Array(1))[0].toString(16).padStart(8, '0')}`;

// Flows in the same repo that run this one as a subflow.
export const dependentsOf = (item: Item, items: readonly Item[]): Item[] =>
  items.filter((other) => other.repo === item.repo && other.flow.steps.some((step) => step.subflow_ref === item.flow.id));

// A subflow step that runs `target`, citing where the target starts.
function runStep(id: string, target: Flow): Step {
  const entry = target.steps.find((step) => step.kind !== 'subflow') ?? target.steps[0];
  return { id, kind: 'subflow', claim: runClaim(target.name), subflow_ref: target.id, evidence: entry.evidence.slice(0, 1), check: null, enabled: true };
}

export const newFlow = (from: Flow, name: string, steps: Step[]): Flow => ({
  schema_version: 0,
  id: ownId(from.kind),
  name,
  category: from.category,
  kind: from.kind,
  origin: 'source',
  status: 'unverified',
  confidence: 0,
  enabled: true,
  destructive: 'unknown',
  priority: from.priority,
  tags: [],
  version: 1,
  steps: steps.map((step, i) => ({ ...step, id: `s${i + 1}` })),
});

// PLAN.md Phase 5 subflow editor: extract steps as a subflow, swap or remove a subflow step, or give this flow its
// own copy. Editing a shared subflow changes it for every flow that runs it; the Edit section warns first.
export function Subflows({ item, items, onView }: { item: Item; items: readonly Item[]; onView: OnView }) {
  const { busy, error, send } = useSend(onView);
  const [chosen, setChosen] = useState<string[]>([]);
  const [name, setName] = useState('');
  const { flow } = item;
  const repo = repoKey(item.repo);
  const others = items.filter((other) => other.repo === item.repo && other.flow.kind === flow.kind && other.key !== item.key && other.flow.status !== 'rejected');
  const users = dependentsOf(item, items);
  const editSteps = (steps: Step[]) => send('/api/flows/edit', { repo, flow: flow.id, patch: { steps } });
  const swap = (step: Step, targetId: string) => {
    const target = others.find((other) => other.flow.id === targetId);
    if (target !== undefined) editSteps(flow.steps.map((own) => (own === step ? runStep(step.id, target.flow) : own)));
  };
  const copy = async (step: Step) => {
    const target = others.find((other) => other.flow.id === step.subflow_ref);
    if (target === undefined) return;
    const twin = { ...newFlow(target.flow, `${target.flow.name} (copy for ${flow.name})`, target.flow.steps), category: target.flow.category };
    if (await send('/api/flows/add', { repo, flow: twin })) await editSteps(flow.steps.map((own) => (own === step ? runStep(step.id, twin) : own)));
  };
  const extract = async () => {
    const picked = flow.steps.filter((step) => chosen.includes(step.id));
    const sub = newFlow(flow, name.trim(), picked);
    if (!(await send('/api/flows/add', { repo, flow: sub }))) return;
    // The picked steps become one step that runs the new subflow, where the first of them was.
    const first = picked[0];
    const ok = await editSteps(flow.steps.flatMap((step) => (step === first ? [runStep(step.id, sub)] : chosen.includes(step.id) ? [] : [step])));
    if (ok) {
      setChosen([]);
      setName('');
    }
  };
  return (
    <section>
      <h3>Subflows</h3>
      {users.length === 0 ? null : (
        <p>
          Runs inside {users.length} flow{users.length === 1 ? '' : 's'}: {users.map((user) => user.flow.name).join(', ')}.
        </p>
      )}
      {flow.steps
        .filter((step) => step.kind === 'subflow')
        .map((step) => {
          const target = items.find((other) => other.repo === item.repo && other.flow.id === step.subflow_ref);
          return (
            <div key={step.id} className="subflow-row">
              <p>
                {step.id} runs <strong>{target?.flow.name ?? step.subflow_ref}</strong>
              </p>
              <div className="button-row">
                <select aria-label={`Swap what ${step.id} runs`} value="" disabled={busy} onChange={(event) => swap(step, event.target.value)}>
                  <option value="">Swap for…</option>
                  {others
                    .filter((other) => other.flow.id !== step.subflow_ref)
                    .map((other) => (
                      <option key={other.key} value={other.flow.id}>
                        {other.flow.name}
                      </option>
                    ))}
                </select>
                <button type="button" disabled={busy || target === undefined} onClick={() => copy(step)}>
                  Make a copy for this flow
                </button>
              </div>
            </div>
          );
        })}
      <p className="muted">Pick steps to turn into a subflow of their own:</p>
      <ul className="pick-steps">
        {flow.steps.map((step) => (
          <li key={step.id}>
            <label className="inline" htmlFor={`pick-${step.id}`}>
              <input id={`pick-${step.id}`} type="checkbox" checked={chosen.includes(step.id)} onChange={(event) => setChosen(event.target.checked ? [...chosen, step.id] : chosen.filter((id) => id !== step.id))} />
              {step.id} {step.claim}
            </label>
          </li>
        ))}
      </ul>
      <div className="button-row">
        <input aria-label="Name of the new subflow" placeholder="Name of the new subflow" value={name} onChange={(event) => setName(event.target.value)} />
        <button type="button" disabled={busy || chosen.length === 0 || chosen.length === flow.steps.length || name.trim() === ''} onClick={extract}>
          Extract as subflow
        </button>
      </div>
      <Problem error={error} />
    </section>
  );
}
