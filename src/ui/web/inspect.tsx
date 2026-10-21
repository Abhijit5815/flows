import { useEffect, useState } from 'react';
import type { InspectorView } from '../api.ts';
import { get, post } from './client.ts';
import { NOT_OBSERVED, repoKey, ROLE_NOT_EXPLORED, type Item } from './model.ts';

// PLAN.md Phase 3 "Walk this in the inspector": the server opens the inspector in a browser window; the page waits
// for the person to press Done there, then reloads the flows, which the cross-check has updated.
export function useInspector(onDone: () => void) {
  const [state, setState] = useState<InspectorView | undefined>();
  const [error, setError] = useState<string | undefined>();
  const running = state?.running === true;
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => {
      get<InspectorView>('/api/inspect').then((next) => {
        setState(next);
        if (!next.running) onDone();
      }, (failure: Error) => setError(failure.message));
    }, 2000);
    return () => clearInterval(timer);
  }, [running, onDone]);
  const start = (body: { repo?: string; flow?: string }) => {
    setError(undefined);
    post<InspectorView>('/api/inspect', body).then(setState, (failure: Error) => setError(failure.message));
  };
  return { state, error, start, running };
}

export type Inspector = ReturnType<typeof useInspector>;

export function InspectorStatus({ inspector }: { inspector: Inspector }) {
  const { state, error } = inspector;
  if (error !== undefined) return <p role="alert" className="roles">Couldn't open the inspector: {error}</p>;
  if (state?.running) return <p role="status" className="roles">The inspector is open in a browser window: use the app, then press Done there. The flows reload when it closes.</p>;
  const last = state?.last;
  if (last == null) return null;
  if (last.error !== null) return <p role="alert" className="roles">The inspector stopped: {last.error}</p>;
  return <p role="status" className="roles">Walk saved{last.flow === null ? '' : `: ${last.ticked} of ${last.steps} steps ticked`}. The cross-check now includes it.</p>;
}

// On a flow the live runs didn't confirm: walk it by hand, step by step.
export function WalkButton({ item, inspector }: { item: Item; inspector: Inspector }) {
  if (!item.flow.tags.includes(NOT_OBSERVED) && !item.flow.tags.includes(ROLE_NOT_EXPLORED)) return null;
  return (
    <section>
      <h3>Not seen on the live app</h3>
      <p className="muted">Walk it by hand: the inspector opens at the app, lists this flow's steps and ticks each one you do.</p>
      <button type="button" disabled={inspector.running} onClick={() => inspector.start({ repo: repoKey(item.repo), flow: item.flow.id })}>
        Walk this in the inspector
      </button>
    </section>
  );
}
