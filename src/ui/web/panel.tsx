import { useEffect, useState, type ReactNode } from 'react';
import type { DecisionView } from '../../engine/classify.ts';
import type { Flow } from '../../model/flow.ts';
import type { Snippet } from '../api.ts';
import { get } from './client.ts';
import { place, type Item } from './model.ts';

// The code at one cited place, with the lines around it; only the selected flow's places are fetched.
function Code({ repo, at }: { repo: string; at: string }) {
  const [snippet, setSnippet] = useState<Snippet | string | undefined>();
  useEffect(() => {
    const { file, line } = place(at);
    setSnippet(undefined);
    get<Snippet>(`/api/snippet?repo=${encodeURIComponent(repo)}&file=${encodeURIComponent(file)}&line=${line}`).then(setSnippet, (error: Error) => setSnippet(error.message));
  }, [repo, at]);
  return (
    <figure className="code">
      <figcaption>{at}</figcaption>
      {snippet === undefined ? <p className="muted">Loading the code…</p> : null}
      {typeof snippet === 'string' ? <p className="muted">Can't show this code: {snippet}</p> : null}
      {typeof snippet === 'object' ? (
        <pre>
          {snippet.lines.map((text, i) => {
            const number = snippet.start + i;
            return (
              <span key={number} className={number === snippet.line ? 'cited' : undefined}>
                <span className="ln">{number}</span>
                {text}
                {'\n'}
              </span>
            );
          })}
        </pre>
      ) : null}
    </figure>
  );
}

function expectation(check: Flow['steps'][number]['check']): string | undefined {
  if (check === null) return undefined;
  if (check.kind === 'api') return [check.status === undefined ? undefined : `status ${check.status}`, check.fields === undefined ? undefined : `fields ${check.fields.join(', ')}`].filter(Boolean).join(', ');
  return check.page !== undefined ? `page ${check.page}` : `element ${check.element}`;
}

function Probabilities({ title, view }: { title: string; view: DecisionView }) {
  const rows = Object.entries(view.probs).sort((a, b) => b[1] - a[1]);
  const by = view.by === 'decider' ? 'the Decider' : view.by === 'llm' ? 'the LLM (the Decider was unsure)' : 'nobody: the Decider was unsure and no LLM answered';
  return (
    <div className="decision">
      <p>
        <strong>{title}:</strong> {view.label}, decided by {by}
      </p>
      {rows.length > 0 ? (
        <ul className="bars">
          {rows.map(([label, p]) => (
            <li key={label}>
              <span className="bar-label">{label}</span>
              <span className="bar" style={{ width: `${Math.round(p * 100)}%` }} />
              <span className="bar-value">{p.toFixed(2)}</span>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

// PLAN.md Phase 5 side panel: the evidence for each step (its code), and why the flow is here.
export function Panel({ item, onClose, children }: { item: Item; onClose: () => void; children?: ReactNode }) {
  const { flow } = item;
  return (
    <aside className="panel" aria-label="Flow details">
      <header className="panel-head">
        <div>
          <h2>{flow.name}</h2>
          <p className="muted">
            {flow.id} · {item.repo.role} {item.repo.path} · version {flow.version}
          </p>
        </div>
        <button type="button" className="icon" onClick={onClose} aria-label="Close the details">
          ×
        </button>
      </header>
      <div className="flow-badges">
        <span className={`pill status-${flow.status}`}>{flow.status}</span>
        <span className="badge">{flow.kind.toUpperCase()}</span>
        <span className="badge">confidence {flow.confidence.toFixed(2)}</span>
        <span className="badge">{flow.category}</span>
        {flow.destructive === 'no' ? null : <span className="badge warn">destructive: {flow.destructive}</span>}
        <span className="badge">{flow.enabled ? 'enabled' : 'disabled'}</span>
      </div>
      {flow.description === undefined ? null : <p>{flow.description}</p>}
      {children}
      <section>
        <h3>Steps</h3>
        <ol className="steps">
          {flow.steps.map((step) => (
            <li key={step.id} className={step.enabled ? undefined : 'is-off'}>
              <p className="step-line">
                <span className="step-kind">{step.kind}</span> {step.claim}
                {step.enabled ? '' : ' (switched off)'}
              </p>
              {step.request === undefined ? null : (
                <p className="muted">
                  Request: {step.request.method} {step.request.path}
                </p>
              )}
              {expectation(step.check) === undefined ? (step.kind === 'subflow' ? null : <p className="muted">No check: source doesn't say what to expect.</p>) : <p>Expect: {expectation(step.check)}</p>}
              {step.evidence.map((evidence) => (evidence.type === 'code' ? <Code key={`${step.id}:${evidence.ref}`} repo={item.repo.path} at={evidence.ref} /> : <p key={evidence.ref}>{evidence.ref}</p>))}
            </li>
          ))}
        </ol>
      </section>
      <section>
        <h3>Why this flow</h3>
        {item.reasons.length === 0 ? <p className="muted">Every claim is backed by source, and nothing held it back.</p> : null}
        <ul className="reasons">
          {item.reasons.map((reason) => (
            <li key={reason}>{reason}</li>
          ))}
        </ul>
        {item.decisions === undefined ? null : (
          <>
            <Probabilities title="Destructive" view={item.decisions.destructive} />
            <Probabilities title="Category" view={item.decisions.category} />
          </>
        )}
      </section>
    </aside>
  );
}
