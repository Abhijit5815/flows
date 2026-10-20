import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { categories, type Project } from '../config/project.ts';
import type { EmbeddingProvider } from '../embeddings/provider.ts';
import { verdictsOf, type EngineDeps } from '../engine/engine.ts';
import { exportFlows } from '../engine/export.ts';
import { loadFlows } from '../engine/store.ts';
import { repoFile } from '../graph/store.ts';
import { listFiles } from '../ingest/files.ts';
import { loadRules } from '../rules/learned.ts';
import { parseOrThrow } from '../shared/validate.ts';
import { TOKEN_HEADER, type ProjectView, type Snippet } from './api.ts';
import { describeFlow, palette } from './propose.ts';
import { BadRequest, DescribeBody, writes } from './writes.ts';

const CONTEXT_LINES = 6; // shown above and below a cited line
const MAX_BODY = 1 << 20;

export type Ui = { url: string; close(): Promise<void> };

class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

// The page's script and styles, bundled in memory at start so they always match the source.
async function bundle(): Promise<{ js: string; css: string }> {
  const result = await build({
    entryPoints: [fileURLToPath(new URL('./web/app.tsx', import.meta.url))],
    bundle: true,
    write: false,
    outdir: 'ui',
    format: 'esm',
    jsx: 'automatic',
    target: 'es2022',
    logLevel: 'silent',
    define: { 'process.env.NODE_ENV': '"production"' },
  });
  const output = (ending: string) => result.outputFiles.find((file) => file.path.endsWith(ending))?.text ?? '';
  return { js: output('.js'), css: output('.css') };
}

const escapeHtml = (text: string) => text.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);

const page = (name: string, token: string) =>
  '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">' +
  `<meta name="flows-token" content="${token}"><title>Flows · ${escapeHtml(name)}</title><link rel="stylesheet" href="/app.css"></head>` +
  '<body><div id="root"></div><script type="module" src="/app.js"></script></body></html>';

function send(res: ServerResponse, status: number, body: string, type: string): void {
  res.writeHead(status, {
    'content-type': type,
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    // React Flow positions nodes with inline styles; nothing else may load from anywhere but this server.
    'content-security-policy': "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:",
  });
  res.end(body);
}
const json = (res: ServerResponse, status: number, value: unknown) => send(res, status, JSON.stringify(value), 'application/json');

async function body(req: IncomingMessage): Promise<unknown> {
  if (!(req.headers['content-type'] ?? '').startsWith('application/json')) throw new HttpError(415, 'send JSON');
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > MAX_BODY) throw new HttpError(413, 'request body too large');
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new HttpError(400, 'the request body is not JSON');
  }
}

// PLAN.md Phase 5: the review page, a local web page the CLI opens. It listens on 127.0.0.1 only. Every API call
// carries this run's random token, which only the page itself can read, and the Host header must be this server's,
// so other websites can neither call the API nor reach it by DNS rebinding.
export async function startUi(start: Project, deps: EngineDeps & { embedder: EmbeddingProvider }, port = 0): Promise<Ui> {
  const token = randomBytes(24).toString('hex');
  const assets = await bundle();
  const listed = new Map<string, Set<string>>();
  const changes = writes(start, deps);
  let project = start;
  let hosts = new Set<string>();
  // One write at a time: each rebuilds flows and rewrites files that the next one reads.
  let queue: Promise<unknown> = Promise.resolve();
  const serial = <T>(work: () => Promise<T>): Promise<T> => {
    const next = queue.then(work, work);
    queue = next.catch(() => {});
    return next;
  };
  const WRITES: Record<string, (input: unknown) => Promise<void>> = {
    '/api/feedback': changes.feedback,
    '/api/flows/edit': changes.edit,
    '/api/flows/add': changes.add,
    '/api/bulk': changes.bulk,
    '/api/categories': changes.categories,
    '/api/draw': changes.draw,
  };

  const view = (): ProjectView => ({
    name: project.config.name,
    categories: [...categories(project.config)],
    repos: project.config.repos.map((repo) => ({
      path: repo.path,
      role: repo.role,
      framework: repo.framework,
      set: loadFlows(project, repo) ?? null,
      verdicts: Object.fromEntries(verdictsOf(loadRules(resolve(project.root, repo.path)))),
      feedback: loadRules(resolve(project.root, repo.path)).flatMap((rule) => (rule.type === 'feedback' ? [rule] : [])),
    })),
  });

  // Only files the repo's own listing has (git's, so .gitignore'd files and anything outside the repo never are).
  const snippet = (params: URLSearchParams): Snippet => {
    const repo = project.config.repos.find((candidate) => candidate.path === params.get('repo'));
    const file = params.get('file') ?? '';
    const line = Number(params.get('line'));
    if (repo === undefined || !Number.isInteger(line) || line < 1) throw new HttpError(400, 'snippet needs repo, file and line');
    const dir = resolve(project.root, repo.path);
    if (!listed.has(dir)) listed.set(dir, new Set(listFiles(dir)));
    if (!listed.get(dir)?.has(file)) throw new HttpError(404, `${file} is not a file of ${repo.path}`);
    const lines = readFileSync(join(dir, file), 'utf8').split('\n');
    const start = Math.max(1, line - CONTEXT_LINES);
    return { file, line, start, lines: lines.slice(start - 1, Math.min(lines.length, line + CONTEXT_LINES)) };
  };

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    if (!hosts.has(req.headers.host ?? '')) throw new HttpError(403, 'unknown host');
    const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
    if (req.method === 'GET' && url.pathname === '/') return send(res, 200, page(project.config.name, token), 'text/html; charset=utf-8');
    if (req.method === 'GET' && url.pathname === '/app.js') return send(res, 200, assets.js, 'text/javascript; charset=utf-8');
    if (req.method === 'GET' && url.pathname === '/app.css') return send(res, 200, assets.css, 'text/css; charset=utf-8');
    if (!url.pathname.startsWith('/api/')) throw new HttpError(404, `no page at ${url.pathname}`);
    if (req.headers[TOKEN_HEADER] !== token) throw new HttpError(403, 'missing or wrong token');
    if (req.method === 'GET' && url.pathname === '/api/project') return json(res, 200, view());
    if (req.method === 'GET' && url.pathname === '/api/snippet') return json(res, 200, snippet(url.searchParams));
    if (req.method === 'GET' && url.pathname === '/api/export') return json(res, 200, exportFlows(project.config.repos.flatMap((repo) => loadFlows(project, repo) ?? []), categories(project.config)));
    if (req.method === 'GET' && url.pathname === '/api/nodes') return json(res, 200, palette(changes.graphOf(url.searchParams.get('repo') ?? '').graph));
    if (req.method === 'POST' && url.pathname === '/api/describe') {
      const { repo: key, text } = parseOrThrow(DescribeBody, await body(req), 'description', BadRequest);
      const { repo, graph } = changes.graphOf(key);
      // Serial too: the node vectors are cached on disk.
      const flows = loadFlows(project, repo)?.flows ?? [];
      return json(res, 200, await serial(() => describeFlow(graph, text, flows, deps.embedder, repoFile(project, 'describe-vectors', repo), project.config.engine.describe_min_similarity)));
    }
    const write = WRITES[url.pathname];
    if (req.method === 'POST' && write !== undefined) {
      const input = await body(req);
      await serial(() => write(input));
      project = changes.project();
      return json(res, 200, view());
    }
    throw new HttpError(404, `no API at ${req.method} ${url.pathname}`);
  };

  const server = createServer((req, res) => {
    handle(req, res).catch((error: unknown) => {
      const status = error instanceof HttpError ? error.status : error instanceof BadRequest ? 400 : 500;
      json(res, status, { error: error instanceof Error ? error.message : String(error) });
    });
  });
  await new Promise<void>((listening) => server.listen(port, '127.0.0.1', listening));
  const bound = (server.address() as AddressInfo).port; // safe: listening on a TCP port
  hosts = new Set([`127.0.0.1:${bound}`, `localhost:${bound}`]);
  return {
    url: `http://127.0.0.1:${bound}/`,
    close: () => new Promise((closed) => server.close(() => closed())),
  };
}
