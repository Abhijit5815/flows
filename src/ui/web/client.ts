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
