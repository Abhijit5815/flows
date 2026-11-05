import type { Run } from './run.ts';

// What a run that was allowed to write actually changed on the app: every write the app answered with a success.
// Nothing here is a guess about what to delete; it is the record of what Flows did, for the project's own cleanup.
export type Created = { run: string; method: string; path: string; status: number; id?: string | number };

const idOf = (body: unknown): string | number | undefined => {
  const at = (value: unknown): string | number | undefined => (typeof value === 'string' || typeof value === 'number' ? value : undefined);
  if (typeof body !== 'object' || body === null) return undefined;
  const record = body as { id?: unknown; data?: { id?: unknown } | null };
  return at(record.data?.id) ?? at(record.id);
};

// A call Flows rated as the app's own noise (a token refresh) is left out, and a repeat of the same write is listed once.
export function createdIn(run: Run): Created[] {
  if (!run.notes.some((note) => note.startsWith('writes to '))) return [];
  const all = run.requests
    .filter((request) => request.kind === 'api' && request.method !== 'GET' && request.method !== 'HEAD' && request.method !== 'OPTIONS' && !request.blocked && request.noise?.label !== 'noise' && request.status !== null && request.status < 300)
    .map((request) => ({ run: run.id, method: request.method, path: request.path, status: request.status as number, ...(idOf(request.response?.body) === undefined ? {} : { id: idOf(request.response?.body) }) }));
  return all.filter((item, i) => all.findIndex((other) => other.method === item.method && other.path === item.path && other.id === item.id) === i);
}
