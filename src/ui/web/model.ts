import type { FlowSet } from '../../engine/store.ts';
import type { Flow } from '../../model/flow.ts';
import type { ProjectView, RepoView } from '../api.ts';

export { NOT_OBSERVED, ROLE_NOT_EXPLORED, STALE } from '../../model/tags.ts';

// An observed step whose element has only an XPath to find it by (src/live/snapshot.ts): "no stable selector".
export const unstable = (step: Flow['steps'][number]): boolean => step.evidence.some((evidence) => evidence.type === 'dom' && / xpath:/.test(evidence.ref));

// One flow on the page, with the repo it came from and the engine's notes on it.
export type Item = { key: string; repo: RepoView; flow: Flow; reasons: string[]; decisions: FlowSet['decisions'][string] | undefined };

export const repoKey = (repo: Pick<RepoView, 'role' | 'path'>): string => `${repo.role}:${repo.path}`;

export const itemsOf = (project: ProjectView): Item[] =>
  project.repos.flatMap((repo) =>
    (repo.set?.flows ?? []).map((flow) => ({ key: `${repoKey(repo)}:${flow.id}`, repo, flow, reasons: repo.set?.reasons[flow.id] ?? [], decisions: repo.set?.decisions[flow.id] })),
  );

export type Filters = { category: string; status: string; repo: string; kind: string };
export const ANY = '';
export const NO_FILTERS: Filters = { category: ANY, status: ANY, repo: ANY, kind: ANY };

export const matches = (item: Item, filters: Filters): boolean =>
  (filters.category === ANY || item.flow.category === filters.category) &&
  (filters.status === ANY || item.flow.status === filters.status) &&
  (filters.repo === ANY || repoKey(item.repo) === filters.repo) &&
  (filters.kind === ANY || item.flow.kind === filters.kind);

// A flow a reviewer said never to suggest again stays off the canvas; the rejected list still shows it.
export const hidden = (item: Item): boolean => item.repo.verdicts[item.flow.id] === 'never';

// "path/to/file.ts:42" -> its file and line.
export function place(ref: string): { file: string; line: number } {
  const at = ref.lastIndexOf(':');
  return { file: ref.slice(0, at), line: Number(ref.slice(at + 1)) };
}
