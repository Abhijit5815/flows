import { useState } from 'react';
import type { ProjectView } from '../api.ts';
import type { Inspector } from './inspect.tsx';
import { TaskStatus, type Task } from './task.tsx';

// Run Flows against a running app by its address. "Open and record" is for what a script can't pass (SSO, zero trust,
// a CDN's sign-in): the person signs in and uses the app in a browser window, and everything they do is cross-checked
// with source. "Explore" visits the app by itself, read-only.
export function LivePanel({ project, inspector, task, onClose }: { project: ProjectView; inspector: Inspector; task: Task; onClose: () => void }) {
  const [url, setUrl] = useState('');
  const [as, setAs] = useState('');
  const [headed, setHeaded] = useState(false);
  const busy = inspector.running || task.running !== null;
  const login = as === '' ? {} : { as };
  const valid = /^https?:\/\/\S+$/.test(url);
  return (
    <aside className="panel" aria-label="Live app">
      <header className="panel-head">
        <h2>Live app</h2>
        <button type="button" className="icon" onClick={onClose} aria-label="Close">
          ×
        </button>
      </header>
      <label className="inline" htmlFor="live-url">
        Address
        <input id="live-url" inputMode="url" value={url} placeholder="https://your-app.example.com" onChange={(event) => setUrl(event.target.value)} />
      </label>
      <section>
        <h3>Open and record</h3>
        <p className="muted">Opens the app in a browser window. Sign in yourself (SSO, zero trust, a CDN login) and use it; press Done in the window when finished. Nothing is blocked, and what you do is cross-checked with the code.</p>
        <button type="button" disabled={busy || !valid} onClick={() => inspector.start({ url, ...login })}>
          Open in a browser
        </button>
      </section>
      <section>
        <h3>Explore automatically</h3>
        <p className="muted">Visits the app by itself and only reads: every write is blocked. For a signed-in app, pick a login saved with "flows login".</p>
        <label className="inline" htmlFor="live-as">
          Sign in as
          <select id="live-as" value={as} onChange={(event) => setAs(event.target.value)}>
            <option value="">nobody (signed out)</option>
            {project.sessions.map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </select>
        </label>
        <label className="inline" htmlFor="live-headed">
          <input id="live-headed" type="checkbox" checked={headed} onChange={(event) => setHeaded(event.target.checked)} />
          Show the browser window
        </label>
        <button type="button" disabled={busy || !valid} onClick={() => task.start('/api/explore', { url, ...login, headed })}>
          Explore
        </button>
        <TaskStatus task={task} kind="explore" />
      </section>
    </aside>
  );
}
