// Next.js route handlers (app/**/route.ts) read as the app's API: one route per exported method, with what it answers
// and the body it parses.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { addRepo } from '../../config/project.ts';
import { candidates } from '../../engine/candidates.ts';
import { stepDetails } from '../../engine/views.ts';
import { scanRepo } from '../../ingest/pipeline.ts';
import { tempProject } from '../../shared/testing/project.ts';

const tmp = mkdtempSync(join(tmpdir(), 'flows-next-api-'));
after(() => rmSync(tmp, { recursive: true, force: true }));

test('each exported method of a route file is a route, with its responses and the body it parses', async () => {
  const dir = join(tmp, 'app');
  const write = (file: string, text: string) => {
    mkdirSync(join(dir, file, '..'), { recursive: true });
    writeFileSync(join(dir, file), text);
  };
  write('package.json', JSON.stringify({ dependencies: { next: '^14.2.5', zod: '^3.23.0', 'next-auth': '^4.24.0' } }));
  write('tsconfig.json', JSON.stringify({ compilerOptions: { strict: true } }));
  write(
    'app/api/items/route.ts',
    "import { NextResponse } from 'next/server';\nimport { z } from 'zod';\nconst itemSchema = z.object({ name: z.string().min(1) });\nexport async function GET() {\n  return NextResponse.json({ items: [] });\n}\nexport async function POST(req: Request) {\n  const signedIn = req.headers.has('cookie');\n  if (!signedIn) return new Response('Unauthorized', { status: 401 });\n  const body = itemSchema.parse(await req.json());\n  return NextResponse.json({ id: 1, name: body.name }, { status: 201 });\n}\n",
  );
  write(
    'app/api/items/[id]/route.ts',
    "import { z } from 'zod';\nconst routeContextSchema = z.object({ params: z.object({ id: z.string() }) });\nexport async function DELETE(req: Request, context: unknown) {\n  routeContextSchema.parse(context);\n  return new Response(null, { status: 204 });\n}\n",
  );
  write('app/api/auth/[...nextauth]/route.ts', "import NextAuth from 'next-auth';\nconst handler = NextAuth({ providers: [] });\nexport { handler as GET, handler as POST };\n");
  write('app/_internal/route.ts', 'export function GET() {\n  return Response.json({});\n}\n');
  write('app/api/items/route.test.ts', 'export function GET() {\n  return Response.json({});\n}\n');

  const project = tempProject(join(tmp, 'project'));
  const { graph, coverage } = await scanRepo(project, addRepo(project, dir, 'api').config.repos[0]);
  assert.ok(graph);
  assert.equal(graph.framework, 'nextjs-api');
  const routes = graph.nodes.flatMap((node) => (node.kind === 'route' ? [`${node.attrs.method} ${node.attrs.path}`] : [])).sort();
  assert.deepEqual(routes, ['DELETE /api/items/:id', 'GET /api/auth/*', 'GET /api/items', 'POST /api/auth/*', 'POST /api/items'], 'private folders and tests are not routes');
  assert.ok(coverage.unrecognised.some((note) => note.reason.startsWith('GET /api/auth/*: its handler is library code')));

  const details = (name: string) => {
    const flow = candidates(graph).flows.find((candidate) => candidate.name === name);
    return flow?.steps.flatMap((step) => [`check ${step.check?.kind === 'api' ? step.check.status : '-'}`, ...stepDetails(step)]);
  };
  assert.deepEqual(details('POST /api/items'), ['check 201', 'body itemSchema { name: string min(1) }', 'error 401 from the handler: Unauthorized (when if (!signedIn))']);
  assert.deepEqual(details('DELETE /api/items/:id'), ['check 204'], "a schema for the route's params is not a body");
});

// proxy.ts (Next.js 16's middleware) guards the API routes its matcher selects, minus the prefixes it lets through,
// and a response built by the app's own helper counts as the handler's.
test('the proxy guards API routes but not the ones it lets through; helper responses count', async () => {
  const dir = join(tmp, 'guarded');
  const write = (file: string, text: string) => {
    mkdirSync(join(dir, file, '..'), { recursive: true });
    writeFileSync(join(dir, file), text);
  };
  write('package.json', JSON.stringify({ dependencies: { next: '^16.0.0' } }));
  write('tsconfig.json', JSON.stringify({ compilerOptions: { strict: true } }));
  write(
    'proxy.ts',
    "import { NextResponse, type NextRequest } from 'next/server';\nexport function proxy(request: NextRequest) {\n  if (request.nextUrl.pathname.startsWith('/api/auth')) return NextResponse.next();\n  if (!request.cookies.has('session')) return NextResponse.json({ error: 'Sign in first' }, { status: 401 });\n  return NextResponse.next();\n}\nexport const config = { matcher: ['/api/:path*'] };\n",
  );
  write('lib/errors.ts', "export const forbidden = () => Response.json({ error: 'Not yours' }, { status: 403 });\n");
  write('app/api/notes/route.ts', "import { forbidden } from '../../../lib/errors';\nexport function GET(request: Request) {\n  if (!request.headers.has('x-owner')) return forbidden();\n  return Response.json({ notes: [] });\n}\n");
  write('app/api/auth/session/route.ts', 'export function GET() {\n  return Response.json({ user: null });\n}\n');
  const project = tempProject(join(tmp, 'guarded-project'));
  const { graph } = await scanRepo(project, addRepo(project, dir, 'api').config.repos[0]);
  assert.ok(graph);
  const guards = (path: string) => graph.edges.filter((edge) => edge.from === `api:route:GET ${path}` && edge.kind === 'guarded-by').length;
  assert.deepEqual([guards('/api/notes'), guards('/api/auth/session')], [1, 0]);
  const details = candidates(graph).flows.find((flow) => flow.name === 'GET /api/notes')?.steps.flatMap(stepDetails);
  assert.deepEqual(details, ['error 401 from middleware: Sign in first (when without a valid session)', 'error 403 from the handler: Not yours']);
});
