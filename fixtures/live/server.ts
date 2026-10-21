// A small live site for the explorer's tests (PLAN.md Phase 3). Its pages follow fixtures/apps/next-basic and its API
// follows fixtures/apps/express-basic, so the cross-check can be tested against those graphs. It also plants what
// the explorer must handle:
// - writes: add to cart, a profile form, a newsletter form, a beacon, a destructive "Delete account" button;
// - a GET that signs the visitor out;
// - polling, a WebSocket, a service worker and a pixel from another site (".invalid" is reserved and never
//   resolves, so the request fails without reaching anyone);
// - a login form in a modal (with a Close button) and on /login, and a search form that navigates (GET);
// - a page (/about) and an API route (/api/v1/reviews) that aren't in source;
// - canaries (an email, a token, a JWT-like string) that must never reach a run file.
// It counts every write and WebSocket that reaches it, so a test can prove the explorer is read-only.
import { randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

export type FixtureOptions = { email: string; password: string; secret: string };

export type LiveFixture = {
  url: string; // the site, at http://127.0.0.1:<port>
  writes: string[]; // "POST /api/track": every request other than GET, HEAD or OPTIONS that reached the server
  sockets: number; // WebSocket upgrades that reached it
  logouts: number; // GETs of /logout, which signs the visitor out
  session(): string; // a valid session cookie value, for tests that start signed in
  close(): Promise<void>;
};

export const JWT_CANARY = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1MSJ9.c2lnbmF0dXJlLWNhbmFyeQ';

const PRODUCTS = [
  { id: '1', name: 'Lamp', price: 20 },
  { id: '2', name: 'Chair', price: 45 },
];

// Runs on every page: a beacon, polling, a WebSocket, a service worker, and the login forms.
const COMMON = `
const send = (url, method, body) => fetch(url, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) }).catch(() => null);
navigator.sendBeacon('/api/track', JSON.stringify({ page: location.pathname }));
setInterval(() => fetch('/api/notifications').catch(() => null), 400);
try { new WebSocket('ws://' + location.host + '/ws'); } catch {}
if (navigator.serviceWorker) navigator.serviceWorker.register('/sw.js').catch(() => null);
for (const form of document.querySelectorAll('form.sign-in')) {
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const res = await send('/api/auth/login', 'POST', Object.fromEntries(new FormData(form)));
    if (res && res.ok) location.href = '/account';
    else form.insertAdjacentHTML('beforeend', '<p role="alert">Wrong email or password</p>');
  });
}
document.getElementById('open-login')?.addEventListener('click', () => document.getElementById('login-dialog').showModal());
document.getElementById('close-login')?.addEventListener('click', () => document.getElementById('login-dialog').close());
`;

const SIGN_IN_FIELDS = '<label>Email <input name="email" type="email" required></label><label>Password <input name="password" type="password" required></label><button type="submit">Sign in</button>';

const page = (title: string, signedIn: boolean, body: string, script = '') => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>${title} · Shop</title></head><body>
<header><nav>
<a href="/">Home</a> <a href="/products">Products</a> <a href="/cart">Cart</a> <a href="/account">Account</a> <a href="/about">About</a>
<a href="https://example.org/help">Help</a> <a href="mailto:help@example.org">Email us</a> <a href="/logout">Sign out</a>
</nav>
${signedIn ? '<form method="post" action="/api/auth/logout"><button>Log out</button></form>' : '<button id="open-login" type="button">Log in</button>'}
</header>
<dialog id="login-dialog"><form class="sign-in">${SIGN_IN_FIELDS}</form><button type="button" id="close-login">Close</button></dialog>
<main><h1>${title}</h1>${body}</main>
<img src="http://pixel.invalid/pixel.gif" alt="" width="1" height="1">
<script>${COMMON}${script}</script>
</body></html>`;

type Context = { signedIn: boolean; options: FixtureOptions };

// Pages by path pattern; a page that needs a session sends the visitor to /login without one.
const PAGES: { path: RegExp; guarded?: true; render(match: RegExpMatchArray, context: Context): string }[] = [
  { path: /^\/$/, render: (_, c) => page('Home', c.signedIn, '<p>New this week</p><a href="/products/1">See the lamp</a>', "fetch('/health');") },
  {
    path: /^\/products$/,
    render: (_, c) =>
      page(
        'Products',
        c.signedIn,
        '<form role="search" action="/products"><input name="q" type="search" placeholder="Search"><button>Search</button></form><ul id="list"></ul>',
        `fetch('/api/v1/products');
fetch('/api/products').then((r) => r.json()).then((items) => {
  document.getElementById('list').innerHTML = items.map((p) => '<li><a href="/products/' + p.id + '">' + p.name + '</a> <button type="button" data-testid="add-' + p.id + '">Add to cart</button></li>').join('');
  for (const p of items) document.querySelector('[data-testid="add-' + p.id + '"]').addEventListener('click', () => send('/api/cart/items', 'POST', { productId: p.id }));
});`,
      ),
  },
  {
    path: /^\/products\/([^/]+)$/,
    render: ([, id], c) =>
      page(
        'Product',
        c.signedIn,
        '<h2 id="name"></h2><button type="button" id="add">Add to cart</button>',
        `fetch('/api/products/${id}').then((r) => r.json()).then((p) => { document.getElementById('name').textContent = p.name; });
fetch('/api/v1/products/${id}');
fetch('/api/v1/reviews?product=${id}');
document.getElementById('add').addEventListener('click', () => send('/api/cart/items', 'POST', { productId: '${id}' }));`,
      ),
  },
  { path: /^\/login$/, render: (_, c) => page('Sign in', c.signedIn, `<form class="sign-in" id="login">${SIGN_IN_FIELDS}</form>`) },
  { path: /^\/cart$/, guarded: true, render: (_, c) => page('Cart', c.signedIn, '<p>Your cart</p>', "fetch('/api/cart');") },
  {
    path: /^\/account$/,
    guarded: true,
    render: (_, c) =>
      page(
        'Account',
        c.signedIn,
        `<p>Signed in as ${c.options.email}</p>
<form id="profile"><input name="name" placeholder="Name"><input name="email" type="email" placeholder="Email"><input name="street" placeholder="Street"><input name="city" placeholder="City"><button type="submit">Save</button></form>
<button type="button" id="delete-account">Delete account</button>
<a href="/account/orders">Orders</a>`,
        `fetch('/api/v1/users/me');
document.getElementById('profile').addEventListener('submit', (event) => { event.preventDefault(); send('/api/me', 'PATCH', Object.fromEntries(new FormData(event.target))); });
document.getElementById('delete-account').addEventListener('click', () => send('/api/me', 'DELETE'));`,
      ),
  },
  {
    path: /^\/account\/orders$/,
    guarded: true,
    render: (_, c) =>
      page(
        'Orders',
        c.signedIn,
        '<p>Order 7</p><form id="cancel"><button type="submit">Cancel order</button></form>',
        `fetch('/api/orders'); fetch('/api/v1/orders');
document.getElementById('cancel').addEventListener('submit', (event) => { event.preventDefault(); send('/api/orders/7', 'DELETE'); });`,
      ),
  },
  {
    path: /^\/about$/,
    render: (_, c) => page('About', c.signedIn, '<p>We sell lamps and chairs.</p><form method="post" action="/subscribe"><label>Newsletter <input name="newsletter" type="email" required></label><button>Subscribe</button></form>'),
  },
  { path: /^\/docs\/(.+)$/, render: ([, slug], c) => page('Docs', c.signedIn, `<p>${slug}</p>`) },
];

const json = (res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) => {
  res.writeHead(status, { 'content-type': 'application/json', ...headers });
  res.end(JSON.stringify(body));
};

const cookie = (req: IncomingMessage, name: string): string | undefined =>
  req.headers.cookie
    ?.split(';')
    .map((part) => part.trim().split('='))
    .find(([key]) => key === name)?.[1];

async function readBody(req: IncomingMessage): Promise<string> {
  let body = '';
  for await (const chunk of req) {
    body += chunk;
    if (body.length > 10_000) break;
  }
  return body;
}

export async function startLiveFixture(options: FixtureOptions): Promise<LiveFixture> {
  const sessions = new Set<string>();
  const newSession = () => {
    const id = randomBytes(12).toString('hex');
    sessions.add(id);
    return id;
  };
  let base = '';
  const fixture: LiveFixture = { url: '', writes: [], sockets: 0, logouts: 0, session: newSession, close: async () => {} };

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', base);
    const method = req.method ?? 'GET';
    const signedIn = sessions.has(cookie(req, 'session') ?? '');
    if (method !== 'GET' && method !== 'HEAD' && method !== 'OPTIONS') {
      fixture.writes.push(`${method} ${url.pathname}`);
      if (method === 'POST' && url.pathname === '/api/auth/login') {
        const body = await readBody(req);
        let sent: { email?: unknown; password?: unknown } = {};
        try {
          sent = JSON.parse(body) as typeof sent;
        } catch {
          // not JSON: a failed login
        }
        if (sent.email === options.email && sent.password === options.password) return json(res, 200, { ok: true }, { 'set-cookie': `session=${newSession()}; Path=/; HttpOnly` });
        return json(res, 401, { error: 'wrong email or password' });
      }
      // A form post goes back to its page (post, redirect, get); a script's write gets no content.
      if ((req.headers.accept ?? '').includes('text/html')) res.writeHead(303, { location: req.headers.referer ?? '/' }).end();
      else res.writeHead(204).end();
      return;
    }
    const path = url.pathname;
    const api: Record<string, () => void> = {
      '/health': () => json(res, 200, { status: 'ok' }),
      '/api/products': () => json(res, 200, PRODUCTS),
      '/api/v1/products': () => json(res, 200, { resource: 'products', items: PRODUCTS }),
      '/api/v1/reviews': () => json(res, 200, { items: [] }),
      '/api/notifications': () => json(res, 200, { count: 0 }),
      '/api/cart': () => (signedIn ? json(res, 200, { items: [] }) : json(res, 401, { error: 'sign in' })),
      '/api/orders': () => (signedIn ? json(res, 200, [{ id: '7' }]) : json(res, 401, { error: 'sign in' })),
      '/api/v1/orders': () => (signedIn ? json(res, 200, { success: true, data: [{ id: '7' }], error: null, timestamp: Date.now() }) : json(res, 401, { error: 'sign in' })),
      '/api/v1/users/me': () =>
        signedIn ? json(res, 200, { success: true, data: { id: 'u1', email: options.email, apiToken: options.secret, note: JWT_CANARY }, error: null, timestamp: Date.now() }) : json(res, 401, { error: 'sign in' }),
      '/sw.js': () => {
        res.writeHead(200, { 'content-type': 'text/javascript' });
        res.end("self.addEventListener('fetch', () => {});");
      },
      '/logout': () => {
        fixture.logouts++;
        res.writeHead(302, { location: '/', 'set-cookie': 'session=; Path=/; Max-Age=0' });
        res.end();
      },
    };
    if (api[path] !== undefined) return api[path]();
    const product = /^\/api(?:\/v1)?\/products\/([^/]+)$/.exec(path);
    if (product !== null) {
      const found = PRODUCTS.find((item) => item.id === product[1]);
      if (found === undefined) return json(res, 404, { error: 'no such product' });
      return json(res, 200, path.startsWith('/api/v1/') ? { resource: 'product', id: found.id } : found);
    }
    for (const candidate of PAGES) {
      const match = candidate.path.exec(path);
      if (match === null) continue;
      if (candidate.guarded && !signedIn) {
        res.writeHead(302, { location: '/login' }).end();
        return;
      }
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(candidate.render(match, { signedIn, options }));
      return;
    }
    res.writeHead(404, { 'content-type': 'text/plain' }).end('not found');
  });
  server.on('upgrade', (_req, socket) => {
    fixture.sockets++;
    socket.destroy();
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const { port } = server.address() as AddressInfo; // safe: a TCP server
  base = `http://127.0.0.1:${port}`;
  fixture.url = base;
  fixture.close = () =>
    new Promise<void>((done) => {
      server.closeAllConnections();
      server.close(() => done());
    });
  return fixture;
}
