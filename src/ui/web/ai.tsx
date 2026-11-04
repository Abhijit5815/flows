import { useState } from 'react';
import type { ProjectView } from '../api.ts';
import { Problem, useSend, type OnView } from './actions.tsx';
import { TaskStatus, type Task } from './task.tsx';

type Provider = ProjectView['llm']['provider'];

// Which AI names the flows, and a button to name them now. A key is never typed here: Anthropic reads its own
// credentials, and a compatible server's key is named by the environment variable that holds it.
export function AiPanel({ project, task, onView, onClose }: { project: ProjectView; task: Task; onView: OnView; onClose: () => void }) {
  const { llm } = project;
  const [provider, setProvider] = useState<Provider>(llm.provider);
  const [model, setModel] = useState(llm.model ?? '');
  const [baseUrl, setBaseUrl] = useState(llm.base_url ?? 'http://localhost:11434/v1');
  const [keyEnv, setKeyEnv] = useState(llm.api_key_env ?? '');
  const { busy, error, send } = useSend(onView);
  const body = () => {
    if (provider === 'assistant') return { provider };
    if (provider === 'anthropic') return { provider, ...(model === '' ? {} : { model }) };
    if (provider === 'gemini') return { provider, ...(model === '' ? {} : { model }), ...(keyEnv === '' ? {} : { api_key_env: keyEnv }) };
    return { provider, base_url: baseUrl, model, ...(keyEnv === '' ? {} : { api_key_env: keyEnv }) };
  };
  const [saved, setSaved] = useState(true);
  return (
    <aside className="panel" aria-label="AI naming">
      <header className="panel-head">
        <h2>AI naming</h2>
        <button type="button" className="icon" onClick={onClose} aria-label="Close">
          ×
        </button>
      </header>
      <p className="muted">The AI gives flows readable names and fills in unknown categories. Without one, names come from the code.</p>
      <label className="inline" htmlFor="ai-provider">
        Provider
        <select id="ai-provider" value={provider} onChange={(event) => { setProvider(event.target.value as Provider); setSaved(false); }}>
          <option value="assistant">My coding assistant (no key, no cost)</option>
          <option value="anthropic">Claude (Anthropic API)</option>
          <option value="gemini">Gemini (Google)</option>
          <option value="openai-compatible">Local or other model (OpenAI-compatible)</option>
        </select>
      </label>
      {provider === 'assistant' ? <p className="muted">Flows saves the naming jobs; your coding assistant answers them ("flows jobs", "flows answer"), then the next scan uses the answers.</p> : null}
      {provider === 'anthropic' ? (
        <>
          <label className="inline" htmlFor="ai-model">
            Model
            <input id="ai-model" value={model} placeholder="default" onChange={(event) => { setModel(event.target.value); setSaved(false); }} />
          </label>
          <p className="muted">Uses ANTHROPIC_API_KEY, or "ant auth login", where Flows runs. Each naming run costs tokens.</p>
        </>
      ) : null}
      {provider === 'gemini' ? (
        <>
          <label className="inline" htmlFor="ai-model">
            Model
            <input id="ai-model" value={model} placeholder="gemini-3.5-flash" onChange={(event) => { setModel(event.target.value); setSaved(false); }} />
          </label>
          <label className="inline" htmlFor="ai-key">
            Key variable
            <input id="ai-key" value={keyEnv} placeholder="GEMINI_API_KEY" onChange={(event) => { setKeyEnv(event.target.value); setSaved(false); }} />
          </label>
          <p className="muted">Put the key in that environment variable before starting Flows; it is never saved or shown here.</p>
        </>
      ) : null}
      {provider === 'openai-compatible' ? (
        <>
          <label className="inline" htmlFor="ai-url">
            Server address
            <input id="ai-url" value={baseUrl} onChange={(event) => { setBaseUrl(event.target.value); setSaved(false); }} />
          </label>
          <label className="inline" htmlFor="ai-model">
            Model
            <input id="ai-model" value={model} placeholder="llama3.2:3b" onChange={(event) => { setModel(event.target.value); setSaved(false); }} />
          </label>
          <label className="inline" htmlFor="ai-key">
            Key variable
            <input id="ai-key" value={keyEnv} placeholder="none needed for a local server" onChange={(event) => { setKeyEnv(event.target.value); setSaved(false); }} />
          </label>
        </>
      ) : null}
      <div className="button-row">
        <button type="button" disabled={busy || task.running !== null} onClick={() => send('/api/llm', body()).then((ok) => setSaved(ok))}>
          Save
        </button>
        <button type="button" disabled={busy || !saved || task.running !== null} onClick={() => task.start('/api/name')}>
          Name flows
        </button>
      </div>
      <Problem error={error} />
      <TaskStatus task={task} kind="name" />
    </aside>
  );
}
