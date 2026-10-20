import '@xyflow/react/dist/style.css';
import './styles.css';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { ProjectView } from '../api.ts';
import { Canvas } from './canvas.tsx';
import { get } from './client.ts';
import { hidden, itemsOf, matches, NO_FILTERS, repoKey, type Filters } from './model.ts';
import { Panel } from './panel.tsx';
import { RejectedList } from './rejected.tsx';

const STATUSES = ['verified', 'unverified', 'unreachable', 'rejected'];

// A file the browser saves; the page is served locally, so a plain download link works.
function save(name: string, text: string): void {
  const link = document.createElement('a');
  link.href = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
  link.download = name;
  link.click();
  URL.revokeObjectURL(link.href);
}

function App() {
  const [project, setProject] = useState<ProjectView | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [filters, setFilters] = useState<Filters>(NO_FILTERS);
  const [selected, setSelected] = useState<string | undefined>();
  const [side, setSide] = useState<'flow' | 'rejected'>('flow');

  const load = useCallback(() => get<ProjectView>('/api/project').then(setProject, (failure: Error) => setError(failure.message)), []);
  useEffect(() => {
    load();
  }, [load]);

  const items = useMemo(() => (project === undefined ? [] : itemsOf(project)), [project]);
  const shown = useMemo(() => items.filter((item) => !hidden(item) && matches(item, filters)), [items, filters]);
  const current = items.find((item) => item.key === selected);
  const toggle = (panel: 'rejected') => setSide(side === panel ? 'flow' : panel);
  const select = (key: string) => {
    setSelected(key);
    setSide('flow');
  };
  const rejectedCount = project?.repos.reduce((sum, repo) => sum + (repo.set?.rejected.length ?? 0) + (repo.set?.flows.filter((flow) => flow.status === 'rejected').length ?? 0), 0) ?? 0;

  if (error !== undefined) return <p role="alert" className="page-message">Could not load the flows: {error}</p>;
  if (project === undefined) return <p className="page-message">Loading flows…</p>;
  if (project.repos.every((repo) => repo.set === null)) return <p className="page-message">No flows yet. Run "flows scan", then reload this page.</p>;

  const filter = (key: keyof Filters, label: string, options: [string, string][]) => (
    <label className="filter">
      <span>{label}</span>
      <select id={`filter-${key}`} value={filters[key]} onChange={(event) => setFilters({ ...filters, [key]: event.target.value })}>
        <option value="">All</option>
        {options.map(([value, text]) => (
          <option key={value} value={value}>
            {text}
          </option>
        ))}
      </select>
    </label>
  );

  return (
    <div className="app">
      <header className="topbar">
        <h1>{project.name}</h1>
        <div className="filters">
          {filter('category', 'Category', project.categories.map((category) => [category.id, category.name]))}
          {filter('status', 'Status', STATUSES.map((status) => [status, status]))}
          {filter('repo', 'Repo', project.repos.map((repo) => [repoKey(repo), `${repo.role} ${repo.path}`]))}
          {filter('kind', 'Kind', [['ui', 'UI'], ['api', 'API']])}
        </div>
        <span className="count">
          {shown.length} of {items.length} flows
        </span>
        <div className="actions">
          <button type="button" onClick={() => toggle('rejected')} aria-pressed={side === 'rejected'}>
            Rejected ({rejectedCount})
          </button>
          <button type="button" onClick={() => get<unknown>('/api/export').then((data) => save('flows.json', JSON.stringify(data, null, 2)), (failure: Error) => setError(failure.message))}>
            Export
          </button>
        </div>
      </header>
      <main className={`workspace${(side === 'flow' && current !== undefined) || side !== 'flow' ? ' with-panel' : ''}`}>
        <div className="canvas">
          {shown.length === 0 ? <p className="page-message">No flow matches these filters.</p> : <Canvas items={shown} categories={project.categories} selected={selected} onSelect={select} />}
        </div>
        {side === 'rejected' ? <RejectedList project={project} onClose={() => setSide('flow')} /> : null}
        {side === 'flow' && current !== undefined ? (
          <Panel item={current} onClose={() => setSelected(undefined)} />
        ) : null}
      </main>
    </div>
  );
}

createRoot(document.getElementById('root') as HTMLElement).render(<App />);
