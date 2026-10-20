import { useEffect, useState } from 'react';
import type { Flow } from '../../model/flow.ts';
import type { ProjectView } from '../api.ts';
import type { Described, PaletteNode } from '../propose.ts';
import { Problem, useSend, type OnView } from './actions.tsx';
import { get, post } from './client.ts';
import { repoKey } from './model.ts';

// PLAN.md Phase 5 "add flow": describe it in words (matched against the code, no LLM), or draw it from the nodes
// the scan found. Either way the engine checks the new flow like any other.
export function AddFlow({ project, onView, onClose }: { project: ProjectView; onView: OnView; onClose: () => void }) {
  const repos = project.repos.filter((repo) => repo.set !== null);
  const [repo, setRepo] = useState(repos[0] === undefined ? '' : repoKey(repos[0]));
  const [mode, setMode] = useState<'describe' | 'draw'>('describe');
  const { busy, error, send } = useSend(onView);
  const [text, setText] = useState('');
  const [found, setFound] = useState<Described | undefined>();
  const [lookError, setLookError] = useState<string | undefined>();
  const [nodes, setNodes] = useState<PaletteNode[]>([]);
  const [query, setQuery] = useState('');
  const [picked, setPicked] = useState<PaletteNode[]>([]);
  const [name, setName] = useState('');

  useEffect(() => {
    setFound(undefined);
    setPicked([]);
    if (repo !== '') get<PaletteNode[]>(`/api/nodes?repo=${encodeURIComponent(repo)}`).then(setNodes, (failure: Error) => setLookError(failure.message));
  }, [repo]);

  const look = () => {
    setLookError(undefined);
    post<Described>('/api/describe', { repo, text }).then((result) => {
      setFound(result);
      setName(result.flow?.name ?? text);
    }, (failure: Error) => setLookError(failure.message));
  };
  const shown = nodes.filter((node) => `${node.kind} ${node.label}`.toLowerCase().includes(query.toLowerCase())).slice(0, 60);

  return (
    <aside className="panel" aria-label="Add a flow">
      <header className="panel-head">
        <h2>Add a flow</h2>
        <button type="button" className="icon" onClick={onClose} aria-label="Close">
          ×
        </button>
      </header>
      <label className="inline" htmlFor="add-repo">
        Repo
        <select id="add-repo" value={repo} onChange={(event) => setRepo(event.target.value)}>
          {repos.map((own) => (
            <option key={repoKey(own)} value={repoKey(own)}>
              {own.role} {own.path}
            </option>
          ))}
        </select>
      </label>
      <div className="button-row" role="tablist">
        <button type="button" role="tab" aria-selected={mode === 'describe'} aria-pressed={mode === 'describe'} onClick={() => setMode('describe')}>
          Describe it
        </button>
        <button type="button" role="tab" aria-selected={mode === 'draw'} aria-pressed={mode === 'draw'} onClick={() => setMode('draw')}>
          Draw it
        </button>
      </div>
      {mode === 'describe' ? (
        <section>
          <label className="field" htmlFor="add-text">
            What does the user do?
          </label>
          <textarea id="add-text" rows={2} placeholder="Create a new invoice" value={text} onChange={(event) => setText(event.target.value)} />
          <div className="button-row">
            <button type="button" disabled={text.trim().length < 3} onClick={look}>
              Find it in the code
            </button>
          </div>
          <Problem error={lookError} />
          {found === undefined ? null : (
            <>
              <p>{found.message}</p>
              {found.flow === undefined ? null : <Proposal flow={found.flow} />}
              <p className="muted">Closest in the code:</p>
              <ul className="notes">
                {found.closest.map((near) => (
                  <li key={near.at + near.label}>
                    {near.label} <span className="muted">({near.similarity.toFixed(2)}, {near.at})</span>
                  </li>
                ))}
              </ul>
              {found.flow === undefined ? null : (
                <div className="button-row">
                  <input aria-label="Name of the new flow" value={name} onChange={(event) => setName(event.target.value)} />
                  <button type="button" disabled={busy || name.trim() === ''} onClick={() => found.flow && send('/api/flows/add', { repo, flow: { ...found.flow, name: name.trim() } }).then((ok) => ok && setFound(undefined))}>
                    Add this flow
                  </button>
                </div>
              )}
            </>
          )}
        </section>
      ) : (
        <section>
          <label className="field" htmlFor="add-search">
            Find nodes (pages, forms, actions, API calls or routes)
          </label>
          <input id="add-search" placeholder="login" value={query} onChange={(event) => setQuery(event.target.value)} />
          <ul className="palette">
            {shown.map((node) => (
              <li key={node.id}>
                <button type="button" aria-label={`Add ${node.kind} ${node.label} as the next step`} onClick={() => setPicked([...picked, node])}>
                  +
                </button>
                <span className="step-kind">{node.kind}</span> {node.label} <span className="muted">{node.at}</span>
              </li>
            ))}
          </ul>
          <h3>Steps, in order</h3>
          {picked.length === 0 ? <p className="muted">Pick the nodes above in the order the user goes through them.</p> : null}
          <ol className="edit-steps">
            {picked.map((node, i) => (
              <li key={`${node.id}:${i}`}>
                <span className="step-kind">{node.kind}</span>
                <span>{node.label}</span>
                <button type="button" aria-label={`Remove step ${i + 1}`} onClick={() => setPicked(picked.filter((_, at) => at !== i))}>
                  ✕
                </button>
              </li>
            ))}
          </ol>
          <div className="button-row">
            <input aria-label="Name of the new flow" placeholder="Name of the new flow" value={name} onChange={(event) => setName(event.target.value)} />
            <button type="button" disabled={busy || picked.length === 0 || name.trim() === ''} onClick={() => send('/api/draw', { repo, nodes: picked.map((node) => node.id), name: name.trim() }).then((ok) => ok && (setPicked([]), setName('')))}>
              Add flow
            </button>
          </div>
        </section>
      )}
      <Problem error={error} />
    </aside>
  );
}

function Proposal({ flow }: { flow: Flow }) {
  return (
    <ol className="steps">
      {flow.steps.map((step) => (
        <li key={step.id}>
          <span className="step-kind">{step.kind}</span> {step.claim}
        </li>
      ))}
    </ol>
  );
}
