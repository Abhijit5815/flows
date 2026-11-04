import { useEffect, useState } from 'react';
import type { TaskView } from '../api.ts';
import { get, post } from './client.ts';

// A run the server does in the background (an explorer run, naming flows): the page starts it, polls until it ends,
// then reloads the flows, which it has changed.
export function useTask(onDone: () => void) {
  const [state, setState] = useState<TaskView | undefined>();
  const [error, setError] = useState<string | undefined>();
  const running = state?.running ?? null;
  useEffect(() => {
    if (running === null) return;
    const timer = setInterval(() => {
      get<TaskView>('/api/task').then((next) => {
        setState(next);
        if (next.running === null) onDone();
      }, (failure: Error) => setError(failure.message));
    }, 2000);
    return () => clearInterval(timer);
  }, [running, onDone]);
  const start = (path: string, body: object = {}) => {
    setError(undefined);
    post<TaskView>(path, body).then(setState, (failure: Error) => setError(failure.message));
  };
  return { state, error, running, start };
}

export type Task = ReturnType<typeof useTask>;

// What the last run said, for the one kind of task this panel starts.
export function TaskStatus({ task, kind }: { task: Task; kind: 'explore' | 'name' | 'qa' }) {
  const { state, error } = task;
  if (error !== undefined) return <p role="alert" className="problem">{error}</p>;
  if (state?.running === kind) return <p role="status" className="muted">{kind === 'explore' ? 'Exploring the live app (read-only)…' : kind === 'qa' ? 'The AI is checking the flows…' : 'Naming flows…'} The flows reload when it finishes.</p>;
  const last = state?.last;
  if (last == null || last.task !== kind) return null;
  if (last.error !== null) return <p role="alert" className="problem">{last.error}</p>;
  if (kind !== 'explore' && last.off !== null) return <p role="alert" className="problem">The AI could not be used{kind === 'name' ? ', so names came from source' : ''}: {last.off}</p>;
  if (kind !== 'explore' && last.pending > 0) return <p role="status">{last.pending} job(s) wait for your coding assistant. Ask it to run "flows jobs" and answer them, then press the button again.</p>;
  return <p role="status">Done: {last.message}.</p>;
}
