import { TOKEN_HEADER } from '../api.ts';

// This run's token, which the server put in the page; every API call sends it.
const token = document.querySelector<HTMLMetaElement>('meta[name="flows-token"]')?.content ?? '';

async function call<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
  const response = await fetch(path, {
    method,
    headers: { [TOKEN_HEADER]: token, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const data = (await response.json()) as T & { error?: string };
  if (!response.ok) throw new Error(data.error ?? `${method} ${path} returned ${response.status}`);
  return data;
}

export const get = <T>(path: string): Promise<T> => call<T>('GET', path);
export const post = <T>(path: string, body: unknown): Promise<T> => call<T>('POST', path, body);

// A binary answer (a screenshot), as a blob: URL the page can show; the token travels in the header as for any call.
export async function blobUrl(path: string): Promise<string> {
  const response = await fetch(path, { headers: { [TOKEN_HEADER]: token } });
  if (!response.ok) throw new Error(((await response.json()) as { error?: string }).error ?? `GET ${path} returned ${response.status}`);
  return URL.createObjectURL(await response.blob());
}
