import { useEffect, useState } from 'react';
import type { OverridePatch } from '../../engine/edits.ts';
import type { Category } from '../../model/category.ts';
import type { Flow } from '../../model/flow.ts';
import type { ProjectView } from '../api.ts';
import { post } from './client.ts';
import { repoKey, type Item } from './model.ts';

type Step = Flow['steps'][number];
export type OnView = (view: ProjectView) => void;

// Sends one change, shows its error if it fails, and hands the engine's new view of the project back.
export function useSend(onView: OnView) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const send = async (path: string, body: unknown): Promise<boolean> => {
    setBusy(true);
    setError(undefined);
    try {
      onView(await post<ProjectView>(path, body));
      return true;
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
      return false;
    } finally {
      setBusy(false);
    }
  };
  return { busy, error, send };
}

export const Problem = ({ error }: { error: string | undefined }) =>
  error === undefined ? null : (
    <p role="alert" className="problem">
      {error}
    </p>
  );

// PLAN.md Phase 5 feedback controls: correct, wrong, never suggest again, missing step, comment.
export function Review({ item, onView }: { item: Item; onView: OnView }) {
  const { busy, error, send } = useSend(onView);
  const [note, setNote] = useState('');
  const [where, setWhere] = useState('');
  const repo = repoKey(item.repo);
  const verdict = item.repo.verdicts[item.flow.id];
  const notes = item.repo.feedback.filter((feedback) => feedback.flow === item.flow.id && (feedback.kind === 'comment' || feedback.kind === 'missing-step'));
  const give = (kind: string, extra: object = {}) => send('/api/feedback', { repo, flow: item.flow.id, kind, ...extra });
  return (
    <section>
      <h3>Review</h3>
      <div className="button-row" role="group" aria-label="Verdict">
        {(['correct', 'wrong', 'never'] as const).map((kind) => (
          <button key={kind} type="button" disabled={busy} aria-pressed={verdict === kind} onClick={() => give(kind)}>
            {kind === 'correct' ? 'Correct' : kind === 'wrong' ? 'Wrong' : 'Never suggest again'}
          </button>
        ))}
      </div>
      <label className="field" htmlFor="review-note">
        Comment or missing step
      </label>
      <textarea id="review-note" rows={2} value={note} onChange={(event) => setNote(event.target.value)} />
      <label className="field" htmlFor="review-place">
        Where the missing step is, if you know (path:line)
      </label>
      <input id="review-place" value={where} placeholder="src/routes/orders.ts:42" onChange={(event) => setWhere(event.target.value)} />
      <div className="button-row">
        <button type="button" disabled={busy || note.trim() === ''} onClick={() => give('comment', { comment: note.trim() }).then((ok) => ok && setNote(''))}>
          Add comment
        </button>
        <button
          type="button"
          disabled={busy || note.trim() === ''}
          onClick={() => give('missing-step', { comment: note.trim(), ...(where.trim() === '' ? {} : { place: where.trim() }) }).then((ok) => ok && (setNote(''), setWhere('')))}
        >
          Report a missing step
        </button>
      </div>
      <Problem error={error} />
      {notes.length === 0 ? null : (
        <ul className="notes">
          {notes.map((feedback, i) => (
            <li key={`${feedback.added}:${i}`}>
              <span className="muted">
                {feedback.kind === 'missing-step' ? 'Missing step' : 'Comment'}, {feedback.added.slice(0, 10)}
                {feedback.place === undefined ? '' : ` at ${feedback.place}`}:
              </span>{' '}
              {feedback.comment}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

// PLAN.md Phase 5 editing: name, category, priority, enabled, and the steps (switch off, reorder, remove, reword).
// Whatever is saved here wins over every later scan.
export function Edit({ item, categories, users, onView }: { item: Item; categories: readonly Category[]; users: readonly Item[]; onView: OnView }) {
  const { busy, error, send } = useSend(onView);
  const { flow } = item;
  const [name, setName] = useState(flow.name);
  const [steps, setSteps] = useState<Step[]>(flow.steps);
  const [pending, setPending] = useState<OverridePatch | undefined>();
  useEffect(() => {
    setName(flow.name);
    setSteps(flow.steps);
    setPending(undefined);
  }, [flow]);
  const commit = (patch: OverridePatch) => send('/api/flows/edit', { repo: repoKey(item.repo), flow: flow.id, patch }).then(() => setPending(undefined));
  // A flow other flows run as a subflow changes for all of them, so saving it asks first.
  const save = (patch: OverridePatch) => (users.length > 0 ? setPending(patch) : commit(patch));
  const stepsChanged = JSON.stringify(steps) !== JSON.stringify(flow.steps);
  const move = (i: number, by: number) => {
    const next = [...steps];
    [next[i], next[i + by]] = [next[i + by], next[i]];
    setSteps(next);
  };
  return (
    <section>
      <h3>Edit</h3>
      <label className="field" htmlFor="edit-name">
        Name
      </label>
      <div className="button-row">
        <input id="edit-name" value={name} onChange={(event) => setName(event.target.value)} />
        <button type="button" disabled={busy || name.trim() === '' || name === flow.name} onClick={() => save({ name: name.trim() })}>
          Rename
        </button>
      </div>
      <div className="button-row">
        <label className="inline" htmlFor="edit-category">
          Category
          <select id="edit-category" value={flow.category} disabled={busy} onChange={(event) => save({ category: event.target.value })}>
            {categories.map((category) => (
              <option key={category.id} value={category.id}>
                {category.name}
              </option>
            ))}
          </select>
        </label>
        <label className="inline" htmlFor="edit-priority">
          Priority
          <select id="edit-priority" value={flow.priority} disabled={busy} onChange={(event) => save({ priority: event.target.value as Flow['priority'] })}>
            <option value="high">high</option>
            <option value="medium">medium</option>
            <option value="low">low</option>
          </select>
        </label>
        <label className="inline" htmlFor="edit-enabled">
          <input id="edit-enabled" type="checkbox" checked={flow.enabled} disabled={busy} onChange={(event) => save({ enabled: event.target.checked })} />
          Enabled
        </label>
      </div>
      <ol className="edit-steps">
        {steps.map((step, i) => (
          <li key={step.id}>
            <label className="inline" htmlFor={`step-on-${step.id}`}>
              <input id={`step-on-${step.id}`} type="checkbox" aria-label={`Use step ${i + 1}`} checked={step.enabled} disabled={busy} onChange={(event) => setSteps(steps.map((own) => (own === step ? { ...own, enabled: event.target.checked } : own)))} />
              <span className="step-kind">{step.kind}</span>
            </label>
            <input aria-label={`Claim of step ${i + 1}`} value={step.claim} onChange={(event) => setSteps(steps.map((own) => (own === step ? { ...own, claim: event.target.value } : own)))} />
            <span className="button-row tight">
              <button type="button" aria-label={`Move step ${i + 1} up`} disabled={i === 0} onClick={() => move(i, -1)}>
                ↑
              </button>
              <button type="button" aria-label={`Move step ${i + 1} down`} disabled={i === steps.length - 1} onClick={() => move(i, 1)}>
                ↓
              </button>
              <button type="button" aria-label={`Remove step ${i + 1}`} disabled={steps.length === 1} onClick={() => setSteps(steps.filter((own) => own !== step))}>
                ✕
              </button>
            </span>
          </li>
        ))}
      </ol>
      <div className="button-row">
        <button
          type="button"
          disabled={busy || !stepsChanged}
          onClick={() => {
            // Only switched-off steps changed: keep the steps generated, so later scans can still update them.
            const onlyToggled = steps.length === flow.steps.length && steps.every((step, i) => JSON.stringify({ ...step, enabled: true }) === JSON.stringify({ ...flow.steps[i], enabled: true }));
            save(onlyToggled ? { disabled_steps: steps.filter((step) => !step.enabled).map((step) => step.id) } : { steps });
          }}
        >
          Save steps
        </button>
        <button type="button" disabled={busy || !stepsChanged} onClick={() => setSteps(flow.steps)}>
          Undo
        </button>
      </div>
      {pending === undefined ? null : (
        <div role="alert" className="warning">
          <p>
            {users.length} flow{users.length === 1 ? ' runs' : 's run'} this one as a subflow: {users.map((user) => user.flow.name).join(', ')}. Saving changes it for {users.length === 1 ? 'it' : 'all of them'}.
          </p>
          <div className="button-row">
            <button type="button" disabled={busy} onClick={() => commit(pending)}>
              Save anyway
            </button>
            <button type="button" onClick={() => setPending(undefined)}>
              Cancel
            </button>
          </div>
        </div>
      )}
      <Problem error={error} />
    </section>
  );
}
