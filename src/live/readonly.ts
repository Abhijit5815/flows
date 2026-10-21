import type { BrowserContext, Request } from 'playwright-core';
import { bodyShape, redactUrl } from './redact.ts';

// RFC 9110's safe methods: they never change data. Every other request is a write.
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

// What a write would have sent, kept for the cross-check: method, redacted URL, and the body's shape without values.
export type BlockedWrite = { method: string; url: string; resource: string; shape: unknown; at: number };

export type Guard = {
  blocked: BlockedWrite[];
  of(request: Request): BlockedWrite | undefined; // the record of a request it blocked
  sockets: string[]; // redacted URLs of the WebSockets the page tried to open
  // The login submit with env credentials: while `during` runs, a write whose body carries `password` gets through.
  // Nothing else does, not even a beacon the page sends at the same moment.
  allowLogin<T>(password: string, during: () => Promise<T>): Promise<T>;
};

// The password as a body may carry it: raw, JSON-escaped, or form-encoded.
const encodings = (password: string): string[] => [password, JSON.stringify(password).slice(1, -1), encodeURIComponent(password), new URLSearchParams({ p: password }).toString().slice(2)];

// PLAN.md Phase 3: the explorer is read-only, and that is enforced at the network, so a wrong Decider call still
// can't write. Writes are aborted and recorded; WebSockets are routed and never connected (Playwright connects a
// routed socket only when asked to). Service workers must be blocked on the context too (browser.ts), because
// route() can't see the requests they handle. The one write let through is the login submit with env credentials.
export async function guardReadOnly(context: BrowserContext): Promise<Guard> {
  let login: string[] = [];
  const records = new WeakMap<Request, BlockedWrite>();
  const guard: Guard = {
    blocked: [],
    of: (request) => records.get(request),
    sockets: [],
    async allowLogin(password, during) {
      login = encodings(password);
      try {
        return await during();
      } finally {
        login = [];
      }
    },
  };
  const isLogin = (body: string | null) => body !== null && login.some((form) => form !== '' && body.includes(form));
  await context.route('**/*', async (route) => {
    const request = route.request();
    if (SAFE_METHODS.has(request.method()) || isLogin(request.postData())) return route.continue();
    const write = { method: request.method(), url: redactUrl(request.url()), resource: request.resourceType(), shape: bodyShape(request.postData(), request.headers()['content-type']), at: Date.now() };
    guard.blocked.push(write);
    records.set(request, write);
    return route.abort('blockedbyclient');
  });
  await context.routeWebSocket(
    () => true,
    (socket) => {
      guard.sockets.push(redactUrl(socket.url()));
    },
  );
  return guard;
}
