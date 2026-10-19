import { ProviderError } from './errors.ts';

export type PostOptions = { apiKey?: string; timeoutMs: number };

export const joinUrl = (base: string, path: string): string =>
  new URL(path, base.endsWith('/') ? base : `${base}/`).toString();

// POST JSON and return the parsed reply. Every failure becomes a ProviderError naming the URL, never the key.
export async function postJson(url: string, body: unknown, { apiKey, timeoutMs }: PostOptions): Promise<unknown> {
  let status: number | undefined;
  let text: string;
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}) },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    status = response.status;
    text = await response.text();
    if (!response.ok) throw new ProviderError(`POST ${url} returned ${status}: ${text.slice(0, 500)}`, status);
  } catch (error) {
    if (error instanceof ProviderError) throw error;
    throw new ProviderError(`POST ${url} failed: ${error instanceof Error ? error.message : String(error)}`, status, { cause: error });
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new ProviderError(`POST ${url} returned a body that is not JSON`, status, { cause: error });
  }
}
