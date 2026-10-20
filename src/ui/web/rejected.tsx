import type { ReactNode } from 'react';
import type { ProjectView, RepoView } from '../api.ts';
import { repoKey } from './model.ts';

type Rejected = NonNullable<ProjectView['repos'][number]['set']>['rejected'][number];

// PLAN.md Phase 4/5: candidates the engine did not keep, and flows reviewers rejected, each with its reasons.
export function RejectedList({ project, onClose, action, problem }: { project: ProjectView; onClose: () => void; action?: (repo: RepoView, rejected: Rejected) => ReactNode; problem?: ReactNode }) {
  return (
    <aside className="panel" aria-label="Rejected candidates">
      <header className="panel-head">
        <h2>Rejected</h2>
        <button type="button" className="icon" onClick={onClose} aria-label="Close the rejected list">
          ×
        </button>
      </header>
      {problem}
      {project.repos.map((repo) => {
        const set = repo.set;
        if (set === null) return null;
        const refused = set.flows.filter((flow) => flow.status === 'rejected');
        if (refused.length + set.rejected.length === 0) return null;
        return (
          <section key={repoKey(repo)}>
            <h3>
              {repo.role} {repo.path}
            </h3>
            <ul className="rejected">
              {refused.map((flow) => (
                <li key={flow.id}>
                  <strong>{flow.name}</strong> <span className="muted">{flow.id}</span>
                  <p className="muted">{(set.reasons[flow.id] ?? []).join('; ')}</p>
                </li>
              ))}
              {set.rejected.map((rejected) => (
                <li key={rejected.subject}>
                  <strong>{rejected.name}</strong> <span className="muted">{rejected.subject}</span>
                  <p className="muted">{rejected.reasons.join('; ')}</p>
                  {action?.(repo, rejected)}
                </li>
              ))}
            </ul>
          </section>
        );
      })}
    </aside>
  );
}
