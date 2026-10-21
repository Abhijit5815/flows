import type { Decider } from '../decider/decider.ts';
import { generalize } from './paths.ts';
import type { RequestRecord } from './run.ts';

// What a captured request is (PLAN.md Phase 3: the Decider filters noise: analytics, polling, assets). Rules decide
// first; only the app's own calls ("api") go on to the event-noise Decider, and only those can become API flows.
export type RequestKind = 'page' | 'api' | 'asset' | 'framework' | 'realtime' | 'external';

const ASSETS = new Set(['image', 'media', 'font', 'stylesheet', 'script', 'manifest', 'texttrack']);
const LOOPBACK = /^(localhost|127(\.\d+){3}|\[?::1\]?|.+\.localhost)$/i;
const IP = /^(\d+(\.\d+){3}|\[?[0-9a-f:]+\]?)$/i;

// The registrable domain, so app.x.com and api.x.com are one site and every loopback host is one site (an app on
// localhost:3000 calling 127.0.0.1:3001 calls itself).
// shortcut: the last two labels, wrong under public suffixes like co.uk (all of *.co.uk looks like one site); move
// to the Public Suffix List when a project needs it.
export function siteOf(hostname: string): string {
  if (LOOPBACK.test(hostname)) return 'loopback';
  if (IP.test(hostname) || !hostname.includes('.')) return hostname.toLowerCase();
  return hostname.toLowerCase().split('.').slice(-2).join('.');
}

export function kindOf(url: URL, resource: string, headers: Record<string, string>, appSite: string): RequestKind {
  if (siteOf(url.hostname) !== appSite) return 'external';
  if (resource === 'document') return 'page';
  if (ASSETS.has(resource)) return 'asset';
  if (/^\/(_next|__nextjs|__webpack)/.test(url.pathname) || url.searchParams.has('_rsc') || headers.rsc === '1') return 'framework';
  if (resource === 'websocket' || resource === 'eventsource' || /\/(socket\.io|engine\.io|sockjs)\//.test(url.pathname)) return 'realtime';
  return 'api';
}

// Polling: the same call three or more times on one page state with no action in between.
export const POLLING_REPEATS = 3;

export type NoiseDecision = { label: 'noise' | 'relevant'; by: 'rule' | 'decider'; reason: string; probs: Record<string, number> };

// The event-noise Decider on "METHOD /path"; unsure counts as relevant, so a real call is never hidden (it is shown
// for review as an observed-only flow instead).
export async function decideNoise(decider: Decider, text: string): Promise<NoiseDecision> {
  const decision = await decider.decide('event-noise', text, ['noise', 'relevant']);
  if (decision.label === 'noise') return { label: 'noise', by: 'decider', reason: `the event-noise Decider rated "${text}" noise (p=${decision.prob.toFixed(2)})`, probs: decision.all_probs };
  return { label: 'relevant', by: 'decider', reason: decision.label === 'relevant' ? `rated relevant (p=${decision.prob.toFixed(2)})` : `the Decider was unsure about "${text}", so it is kept`, probs: decision.all_probs };
}

// Labels the app's own calls that the rules (polling) haven't: one Decider call per distinct "METHOD /path".
export async function labelNoise(requests: RequestRecord[], decider: Decider): Promise<void> {
  const decided = new Map<string, NoiseDecision>();
  for (const request of requests) {
    if (request.kind !== 'api' || request.noise !== null) continue;
    const text = `${request.method} ${generalize(request.path)}`;
    if (!decided.has(text)) decided.set(text, await decideNoise(decider, text));
    request.noise = decided.get(text) ?? null;
  }
}
