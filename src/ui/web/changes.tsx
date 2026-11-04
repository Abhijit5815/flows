import type { ProjectView } from '../api.ts';
import { Problem, useSend, type OnView } from './actions.tsx';
import { repoKey, type Item } from './model.ts';

export const ChangeBadge = ({ item }: { item: Item }) =>
  item.change === undefined ? null : (
    <span className="badge new" title={item.replaces === undefined ? `${item.change} since the last scan` : `updated: it took over from "${item.replaces.name}", whose entry point was renamed`}>
      {item.change === 'new' ? 'new' : 'updated'}
    </span>
  );

const short = (commit: string) => commit.slice(0, 8);

// Where each repo's code stood at the last scan, and what that scan found against the one before: the flows to
// review and export. Nothing here changes a flow; "Mark as seen" only clears the new/updated marks.
export function ScanBar({ project, items, onShow, onExport, onView }: { project: ProjectView; items: Item[]; onShow: () => void; onExport: () => void; onView: OnView }) {
  const { busy, error, send } = useSend(onView);
  const marked = items.filter((item) => item.change !== undefined);
  const count = (kind: string) => marked.filter((item) => item.change === kind).length;
  const sinces = project.repos.flatMap((repo) => (repo.set?.since === undefined ? [] : [{ repo, since: repo.set.since }]));
  if (sinces.length === 0) return <p className="scanbar muted">Scan again to start tracking what changes between scans.</p>;
  const first = sinces.every(({ since }) => since.first);
  const unseen = marked.length;
  return (
    <div className="scanbar" role="region" aria-label="Since the last scan">
      <span>
        {first ? 'First scan: changes show from the next scan.' : (
          <>
            Since the last scan: <strong>{count('new')} new</strong>, <strong>{count('changed')} updated</strong>.
          </>
        )}
      </span>
      <span className="muted">
        {sinces.map(({ repo, since }) => {
          const where = since.commit === null ? 'not a git repo' : `${short(since.commit)}${since.branch === null ? '' : ` on ${since.branch}`}${since.dirty ? ' + uncommitted changes' : ''}`;
          const moved = since.previous_commit === null || since.previous_commit === since.commit ? '' : ` (was ${short(since.previous_commit)}${since.files_changed === null ? '' : `, ${since.files_changed} files changed`})`;
          return (
            <span key={repoKey(repo)} className="scan-repo" title={`scanned ${since.at}`}>
              {repo.role} {where}
              {moved}
            </span>
          );
        })}
      </span>
      {unseen > 0 ? (
        <span className="button-row">
          <button type="button" onClick={onShow}>
            Show them
          </button>
          <button type="button" onClick={onExport}>
            Export new & updated
          </button>
          <button type="button" disabled={busy} onClick={() => send('/api/seen', { flows: marked.map((item) => ({ repo: repoKey(item.repo), flow: item.flow.id })) })}>
            Mark all as seen
          </button>
        </span>
      ) : null}
      <Problem error={error} />
    </div>
  );
}
