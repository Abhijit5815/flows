import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import type { BrowserContext, Page, Request, Response } from 'playwright-core';
import { kindOf, POLLING_REPEATS } from './noise.ts';
import type { Guard } from './readonly.ts';
import { redactJson, redactPath, redactText, redactUrl, shapeOf } from './redact.ts';
import type { RequestRecord, State } from './run.ts';
import { inPage, MAX_TEXT, snapshot, type Element, type Snapshot } from './snapshot.ts';

const MAX_BODY_READ = 1 << 20; // a response bigger than this isn't read at all
const BODY_TIMEOUT = 5000; // a body that never finishes (its request cut off by a navigation) is given up on
const MAX_BODY_KEPT = 16 * 1024; // a redacted body bigger than this keeps its shape only

// Where the next request happens: the page state on screen, the action being taken (if any), and the page load.
export type Where = { state: number | null; action: number | null; visit: number | null };

// The field names of a JSON response: an object's keys, or the keys of an array's first item.
const fieldsOf = (body: unknown): string[] => {
  const item = Array.isArray(body) ? body[0] : body;
  return item !== null && typeof item === 'object' && !Array.isArray(item) ? Object.keys(item) : [];
};

// Records every request a browser context makes (PLAN.md Phase 3: the network calls each page made), redacted
// before it is kept, and tagged with the state and action it happened in. A write the read-only guard stopped
// keeps its body's shape.
export class Recorder {
  readonly requests: RequestRecord[] = [];
  readonly where: Where = { state: null, action: null, visit: null };
  // When a request new to this page load last started, for waiting until the page goes quiet. A repeat (polling)
  // doesn't count, or a polling page would never be quiet.
  lastRequestAt = 0;
  private seenInVisit = new Set<string>();
  private visitOfSeen: number | null = null;
  private readonly records = new Map<Request, RequestRecord>();
  private readonly pending = new Set<Promise<void>>();
  private readonly appSite: string;
  private readonly guard: Guard | undefined;

  constructor(context: BrowserContext, appSite: string, guard?: Guard) {
    this.appSite = appSite;
    this.guard = guard;
    context.on('request', (request) => this.started(request));
    context.on('response', (response) => this.track(this.answered(response)));
    context.on('requestfailed', (request) => this.failed(request));
  }

  // Waits for the response bodies still being read.
  async settled(): Promise<void> {
    await Promise.all([...this.pending]);
  }

  // Requests made since `from` (a request number), in the current state and action.
  since(from: number): RequestRecord[] {
    return this.requests.slice(from);
  }

  private track(work: Promise<void>): void {
    this.pending.add(work);
    void work.finally(() => this.pending.delete(work));
  }

  private started(request: Request): void {
    let url: URL;
    try {
      url = new URL(request.url());
    } catch {
      return;
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return; // data: and blob: URLs aren't network calls
    const headers = request.headers();
    const record: RequestRecord = {
      n: this.requests.length,
      state: this.where.state,
      action: this.where.action,
      visit: this.where.visit,
      method: request.method(),
      url: redactUrl(url.href),
      origin: url.origin,
      path: redactPath(url.pathname),
      resource: request.resourceType(),
      kind: kindOf(url, request.resourceType(), headers, this.appSite),
      server_action: headers['next-action'] !== undefined,
      status: null,
      blocked: false,
      failed: null,
      response: null,
      noise: null,
    };
    this.requests.push(record);
    this.records.set(request, record);
    if (this.visitOfSeen !== this.where.visit) {
      this.visitOfSeen = this.where.visit;
      this.seenInVisit = new Set();
    }
    const call = `${record.method} ${record.url}`;
    if (record.kind !== 'realtime' && record.kind !== 'external' && !this.seenInVisit.has(call)) {
      this.seenInVisit.add(call);
      this.lastRequestAt = Date.now();
    }
  }

  private async answered(response: Response): Promise<void> {
    const record = this.records.get(response.request());
    if (record === undefined) return;
    record.status = response.status();
    const type = (response.headers()['content-type'] ?? '').split(';')[0].trim();
    record.response = { type, fields: [], body: null };
    if (record.kind !== 'api' || !type.includes('json') || Number(response.headers()['content-length'] ?? 0) > MAX_BODY_READ) return;
    let body: unknown;
    try {
      const stop = new AbortController();
      const text = await Promise.race([response.text(), delay(BODY_TIMEOUT, undefined, { signal: stop.signal }).catch(() => undefined)]).finally(() => stop.abort());
      if (text === undefined || text.length > MAX_BODY_READ) return;
      body = JSON.parse(text);
    } catch {
      return; // no body (a redirect, a 204) or not JSON after all
    }
    const redacted = redactJson(body);
    record.response = { type, fields: fieldsOf(body), body: JSON.stringify(redacted).length <= MAX_BODY_KEPT ? redacted : { shape: shapeOf(body) } };
  }

  private failed(request: Request): void {
    const record = this.records.get(request);
    if (record === undefined) return;
    const blocked = this.guard?.of(request);
    record.blocked = blocked !== undefined;
    record.failed = request.failure()?.errorText ?? 'failed';
    if (blocked !== undefined) record.shape = blocked.shape;
  }
}

// Polling (PLAN.md Phase 3 noise): a call repeated within one page load with no action in between. It is the call
// that polls, so every request to it is noise, including those in loads too short to show the repeats.
export function markPolling(requests: RequestRecord[]): void {
  const counts = new Map<string, number>();
  for (const request of requests) {
    if (request.kind !== 'api' || request.action !== null || request.visit === null) continue;
    const key = `${request.visit} ${request.method} ${request.path}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const polled = new Map<string, number>();
  for (const [key, count] of counts) {
    if (count < POLLING_REPEATS) continue;
    const call = key.slice(key.indexOf(' ') + 1);
    polled.set(call, Math.max(count, polled.get(call) ?? 0));
  }
  for (const request of requests) {
    const count = polled.get(`${request.method} ${request.path}`);
    if (request.kind === 'api' && count !== undefined) request.noise = { label: 'noise', by: 'rule', reason: `polling: called ${count} times in one page load with no action`, probs: { noise: 1 } };
  }
}

// A selector that carried personal data is masked, and so no longer stable.
const redactElement = (element: Element): Element => {
  const selector = redactText(element.selector);
  return { text: redactText(element.text), selector, stable: element.stable && selector === element.selector };
};

export const look = (page: Page): Promise<Snapshot> => page.evaluate(inPage(snapshot, MAX_TEXT)) as Promise<Snapshot>;

// What the page shows now, redacted, with a screenshot in the run folder. A screenshot can't be redacted, so it
// stays in the local cache (PLAN.md Phase 3) and never reaches .flows/ or the export.
export async function captureState(page: Page, dir: string, n: number, from: State['from'], requested: string | null, seen?: Snapshot): Promise<State & { password: boolean }> {
  seen ??= await look(page);
  const shot = `s${n}.jpg`;
  const saved = await page.screenshot({ path: join(dir, shot), type: 'jpeg', quality: 70 }).then(
    () => true,
    () => false,
  );
  return {
    n,
    url: redactUrl(seen.url),
    path: redactPath(new URL(seen.url).pathname),
    title: redactText(seen.title),
    text: redactText(seen.text),
    links: seen.links.map((link) => ({ ...redactElement(link), href: redactUrl(link.href) })),
    buttons: seen.buttons.map((button) => ({ ...redactElement(button), role: button.role, form: button.form, group: button.group, list: button.list })),
    forms: seen.forms.map((form) => ({
      ...redactElement(form),
      method: form.method,
      action: redactUrl(form.action),
      fields: form.fields.map((field) => ({ ...field, label: redactText(field.label), selector: redactText(field.selector), options: field.options.map(redactText) })),
      submit: form.submit === null ? null : redactElement(form.submit),
    })),
    shot: saved ? shot : null,
    from,
    requested,
    password: seen.password,
  };
}
