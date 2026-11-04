import '@xyflow/react/dist/style.css';
import './styles.css';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { ProjectView } from '../api.ts';
import { Edit, Problem, Review, useSend } from './actions.tsx';
import { AddFlow } from './add.tsx';
import { AiPanel } from './ai.tsx';
import { Bulk } from './bulk.tsx';
import { Canvas } from './canvas.tsx';
import { ScanBar } from './changes.tsx';
import { CategoryEditor } from './categories.tsx';
import { get } from './client.ts';
import { InspectorStatus, useInspector, WalkButton } from './inspect.tsx';
import { LivePanel } from './live.tsx';
import { hidden, itemsOf, matches, NO_FILTERS, repoKey, type Filters } from './model.ts';
import { Panel } from './panel.tsx';
import { QaBar, QaSection } from './qa.tsx';
import { RejectedList } from './rejected.tsx';
import { FlowTable } from './table.tsx';
import { dependentsOf, Subflows } from './subflows.tsx';
import { useTask } from './task.tsx';

const STATUSES = ['confirmed', 'verified', 'observed-only', 'unverified', 'unreachable', 'rejected'];

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
  const [side, setSide] = useState<'flow' | 'rejected' | 'categories' | 'add' | 'live' | 'ai'>('flow');
  const [view, setView] = useState<'canvas' | 'table' | undefined>();
  const promoting = useSend((view) => setProject(view));

  const load = useCallback(() => get<ProjectView>('/api/project').then(setProject, (failure: Error) => setError(failure.message)), []);
  const inspector = useInspector(load);
  const task = useTask(load);
  useEffect(() => {
    load();
  }, [load]);

  const items = useMemo(() => (project === undefined ? [] : itemsOf(project)), [project]);
  const shown = useMemo(() => items.filter((item) => !hidden(item) && matches(item, filters)), [items, filters]);
  const current = items.find((item) => item.key === selected);
  // A long list is easier in a table: the canvas lays out every flow and step, so it is the default only for a short one.
  const mode = view ?? (items.length > 150 ? 'table' : 'canvas');
  const toggle = (panel: 'rejected' | 'categories' | 'add' | 'live' | 'ai') => setSide(side === panel ? 'flow' : panel);
  const select = (key: string) => {
    setSelected(key);
    setSide('flow');
  };
  // Phase 3: source guards no live run got past, as roles to explore.
  const unexplored = project?.repos.flatMap((repo) => (repo.set?.roles ?? []).filter((role) => !role.covered).map((role) => `${role.guard} (${repo.role} ${repo.path})`)) ?? [];
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
          {filter('kind', 'Kind', [['ui', 'UI'], ['api', 'API'], ['journey', 'Journeys (across pages)']])}
          {filter('qa', 'AI check', [['ready', 'Ready'], ['needs-work', 'Needs work'], ['not-testable', 'Not testable'], ['none', 'Not checked']])}
          {filter('change', 'Since last scan', [['pending', 'New or updated'], ['new', 'New'], ['changed', 'Updated']])}
        </div>
        <span className="count">
          {shown.length} of {items.length} flows
        </span>
        <div className="actions">
          <span className="view-toggle" role="group" aria-label="View">
            <button type="button" aria-pressed={mode === 'canvas'} onClick={() => setView('canvas')}>
              Canvas
            </button>
            <button type="button" aria-pressed={mode === 'table'} onClick={() => setView('table')}>
              Table
            </button>
          </span>
          <button type="button" onClick={() => toggle('live')} aria-pressed={side === 'live'}>
            Live app
          </button>
          <button type="button" onClick={() => toggle('ai')} aria-pressed={side === 'ai'}>
            AI naming
          </button>
          <button type="button" onClick={() => toggle('add')} aria-pressed={side === 'add'}>
            Add flow
          </button>
          <button type="button" onClick={() => toggle('categories')} aria-pressed={side === 'categories'}>
            Categories
          </button>
          <button type="button" onClick={() => toggle('rejected')} aria-pressed={side === 'rejected'}>
            Rejected ({rejectedCount})
          </button>
          <button type="button" onClick={() => get<unknown>('/api/export').then((data) => save('flows.json', JSON.stringify(data, null, 2)), (failure: Error) => setError(failure.message))}>
            Export
          </button>
        </div>
        <ScanBar
          project={project}
          items={items}
          onShow={() => setFilters({ ...NO_FILTERS, change: 'pending' })}
          onExport={() => get<unknown>('/api/export?changed=1').then((data) => save('flows-changed.json', JSON.stringify(data, null, 2)), (failure: Error) => setError(failure.message))}
          onView={setProject}
        />
        <QaBar items={shown} task={task} />
        <Bulk items={shown} categories={project.categories} onView={setProject} />
        {unexplored.length > 0 ? (
          <p className="roles" role="note">
            Roles not explored: {unexplored.join(', ')}. No live run got past these guards, so their flows can't be confirmed yet.{' '}
            <button type="button" disabled={inspector.running} onClick={() => inspector.start({})}>
              Walk it in the inspector
            </button>
          </p>
        ) : null}
        <InspectorStatus inspector={inspector} />
      </header>
      <main className={`workspace${(side === 'flow' && current !== undefined) || side !== 'flow' ? ' with-panel' : ''}`}>
        <div className="canvas">
          {shown.length === 0 ? <p className="page-message">No flow matches these filters.</p> : mode === 'table' ? <FlowTable items={shown} categories={project.categories} selected={selected} onSelect={select} /> : <Canvas items={shown} categories={project.categories} selected={selected} onSelect={select} />}
        </div>
        {side === 'rejected' ? (
          <RejectedList
            project={project}
            onClose={() => setSide('flow')}
            problem={<Problem error={promoting.error} />}
            action={(repo, rejected) =>
              rejected.flow === undefined ? null : (
                <button type="button" disabled={promoting.busy} onClick={() => promoting.send('/api/flows/add', { repo: repoKey(repo), flow: rejected.flow })}>
                  Promote to a flow
                </button>
              )
            }
          />
        ) : null}
        {side === 'live' ? <LivePanel project={project} inspector={inspector} task={task} onClose={() => setSide('flow')} /> : null}
        {side === 'ai' ? <AiPanel project={project} task={task} onView={setProject} onClose={() => setSide('flow')} /> : null}
        {side === 'add' ? <AddFlow project={project} onView={setProject} onClose={() => setSide('flow')} /> : null}
        {side === 'categories' ? <CategoryEditor project={project} onView={setProject} onClose={() => setSide('flow')} /> : null}
        {side === 'flow' && current !== undefined ? (
          <Panel item={current} onClose={() => setSelected(undefined)}>
            <WalkButton item={current} inspector={inspector} />
            <QaSection item={current} task={task} />
            <Review item={current} onView={setProject} />
            <Edit item={current} categories={project.categories} users={dependentsOf(current, items)} onView={setProject} />
            <Subflows item={current} items={items} onView={setProject} />
          </Panel>
        ) : null}
      </main>
    </div>
  );
}

createRoot(document.getElementById('root') as HTMLElement).render(<App />);
