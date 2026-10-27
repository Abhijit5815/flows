import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { addRepo } from '../../config/project.ts';
import { scanRepo } from '../../ingest/pipeline.ts';
import { candidates } from '../../engine/candidates.ts';
import { pageTitle, pressing } from '../../engine/describe.ts';
import { addLoginSubflows } from '../../engine/subflows.ts';
import { lookup } from '../../graph/lookup.ts';
import { tempProject } from '../../shared/testing/project.ts';
import { matcherRegex, nextAppAdapter, routePath } from './nextjs.ts';
import { uiViews } from './views.ts';

const fixture = fileURLToPath(new URL('../../../fixtures/apps/next-basic/', import.meta.url));
const expected = JSON.parse(readFileSync(join(fixture, 'expected.json'), 'utf8'));
const tmp = mkdtempSync(join(tmpdir(), 'flows-next-'));
after(() => rmSync(tmp, { recursive: true, force: true }));

async function scanFixture(name: string, adapters = [nextAppAdapter]) {
  const project = tempProject(join(tmp, name));
  return scanRepo(project, addRepo(project, fixture, 'web').config.repos[0], { adapters });
}

const byKey = <T extends Record<string, unknown>>(key: keyof T, views: T[]) => [...views].sort((a, b) => String(a[key]).localeCompare(String(b[key])));

test('next fixture: every page and layout, with layouts, guards, components, forms, actions and API calls', async () => {
  const { graph, coverage } = await scanFixture('fixture');
  assert.ok(graph);
  const { pages, layouts } = uiViews(graph);
  assert.deepEqual(byKey('page', pages), byKey('page', expected.pages));
  assert.deepEqual(byKey('layout', layouts), byKey('layout', expected.layouts));
  assert.deepEqual(coverage.unrecognised.map((note) => `${note.file}:${note.line}`).sort(), expected.unrecognised);
  // Pattern search (no embedding model here): listed for review, and none of it is in the graph.
  assert.deepEqual(coverage.missed.map((suspect) => `${suspect.file}:${suspect.line}`), expected.missed);
  assert.ok(coverage.missed.every((suspect) => !graph.nodes.some((node) => node.file === suspect.file && node.line === suspect.line)));
});

// The fixture test has to be able to fail: without the API-call rules, the unreached fetches (lib/legacy.ts and
// the unwired resetPassword action) are no longer reported.
test('a broken rule fails the fixture: without the api-call rules, unreached calls go unreported', async () => {
  const { coverage } = await scanFixture('broken', [{ ...nextAppAdapter, rules: nextAppAdapter.rules.filter((rule) => rule.id !== 'api-call') }]);
  const notes = coverage.unrecognised.map((note) => `${note.file}:${note.line}`).sort();
  assert.notDeepEqual(notes, expected.unrecognised);
  assert.deepEqual(expected.unrecognised.filter((note: string) => !notes.includes(note)), ['app/(auth)/login/actions.ts:19', 'lib/legacy.ts:5']);
});

test('route groups add nothing to the path; dynamic and catch-all segments stay', () => {
  assert.equal(routePath([]), '/');
  assert.equal(routePath(['(shop)', 'products', '[id]']), '/products/[id]');
  assert.equal(routePath(['dashboard', '(overview)']), '/dashboard');
  assert.equal(routePath(['docs', '[...slug]']), '/docs/[...slug]');
});

test('middleware matchers: path patterns and regular expressions', () => {
  assert.ok(matcherRegex('/account/:path*').test('/account'));
  assert.ok(matcherRegex('/account/:path*').test('/account/orders/x'));
  assert.ok(!matcherRegex('/account/:path*').test('/accounts'));
  assert.ok(matcherRegex('/cart').test('/cart'));
  assert.ok(!matcherRegex('/cart').test('/cart/x'));
  assert.ok(matcherRegex('/((?!api|_next/static|_next/image|.*\\.png$).*)').test('/dashboard/invoices'));
  assert.ok(!matcherRegex('/((?!api|_next/static|_next/image|.*\\.png$).*)').test('/api/x'));
});

// From an app Flows had never seen (nextjs-postgres-auth-starter): one <Form> component, its action passed in by each
// page. Each page gets a form flow of its own, and the one on /login is the Log-in step even though both are "Login".
test('a form component used on two pages with different actions is two flows', async () => {
  const dir = join(tmp, 'shared-form');
  const write = (file: string, text: string) => {
    mkdirSync(join(dir, file, '..'), { recursive: true });
    writeFileSync(join(dir, file), text);
  };
  write('package.json', JSON.stringify({ dependencies: { next: '^14.2.5' } }));
  write('tsconfig.json', JSON.stringify({ compilerOptions: { jsx: 'preserve', strict: true } }));
  write('app/form.tsx', "export function Form({ action, children }: { action: any; children: React.ReactNode }) {\n  return <form action={action}><input name=\"email\" /><input name=\"password\" />{children}</form>;\n}\n");
  write('app/login/page.tsx', "import { Form } from '../form';\nexport default function Login() {\n  return <Form action={async (data: FormData) => { 'use server'; await fetch('/api/login', { method: 'POST' }); }}><button>Sign in</button></Form>;\n}\n");
  write('app/register/page.tsx', "import { redirect } from 'next/navigation';\nimport { Form } from '../form';\nexport default function Login() {\n  async function register(data: FormData) {\n    'use server';\n    if (!data.get('email')) return 'Enter an email';\n    redirect('/login');\n  }\n  return <Form action={register}><input name=\"name\" /></Form>;\n}\n");
  write('app/account/page.tsx', "export default function Account() {\n  return <p>Account</p>;\n}\n");
  write('middleware.ts', "import { NextResponse } from 'next/server';\nexport function middleware() { return NextResponse.next(); }\nexport const config = { matcher: ['/account'] };\n");
  const project = tempProject(join(tmp, 'shared'));
  const { graph } = await scanRepo(project, addRepo(project, dir, 'web').config.repos[0]);
  assert.ok(graph);
  const nodes = lookup(graph);
  const { flows } = addLoginSubflows(candidates(graph).flows, nodes);
  assert.deepEqual(flows.map((flow) => flow.name).filter((name) => !name.startsWith('User can view')).sort(), ['User can register', 'User can sign in']);
  const register = flows.find((flow) => flow.name === 'User can register');
  const submit = register?.steps[1];
  assert.deepEqual([submit?.claim, submit?.check?.kind === 'ui' ? submit.check.page : undefined, submit?.errors?.map((error) => error.message)], ['Fill in email, password and name, then submit the login form', '/login', ['Enter an email']]);
  const login = flows.find((flow) => flow.name === 'User can sign in');
  assert.deepEqual(flows.find((flow) => flow.steps[0].kind === 'subflow')?.steps[0].subflow_ref, login?.id, 'the Log-in step is the form on /login');
});

// From the bug-hunting pass on unseen Next.js apps (saas-starter, commerce, taxonomy, the postgres-nextauth template,
// next-saas-stripe-starter): what a button says, read the way a person reads it, and named "User can ...".
test('flows are named from what buttons say: states, icons, Title Case, several buttons in one form', async () => {
  const dir = join(tmp, 'labels');
  const write = (file: string, text: string) => {
    mkdirSync(join(dir, file, '..'), { recursive: true });
    writeFileSync(join(dir, file), text);
  };
  write('package.json', JSON.stringify({ dependencies: { next: '^14.2.5', 'next-auth': '^4.24.0' } }));
  write('tsconfig.json', JSON.stringify({ compilerOptions: { jsx: 'preserve', strict: true } }));
  write(
    'app/items/page.tsx',
    "async function prev() {\n  'use server';\n  await fetch('/api/items?page=prev');\n}\nasync function next() {\n  'use server';\n  await fetch('/api/items?page=next');\n}\nexport default function Items() {\n  return (\n    <form>\n      <button formAction={prev}>Prev</button>\n      <button formAction={next} aria-label=\"Next page\"><svg /></button>\n    </form>\n  );\n}\n",
  );
  write(
    'app/account/page.tsx',
    "import { cn } from '../cn';\nasync function update(data: FormData) {\n  'use server';\n  await fetch('/api/me', { method: 'PATCH' });\n}\nexport default function Account({ pending }: { pending: boolean }) {\n  return (\n    <form action={update}>\n      <input name=\"name\" />\n      <button disabled>Out Of Stock</button>\n      <button type=\"submit\" className={cn('px-2', 'cursor-not-allowed')}>{pending ? 'Saving...' : 'Save Changes'}</button>\n    </form>\n  );\n}\n",
  );
  write('app/cn.ts', 'export const cn = (...names: string[]) => names.join(" ");\n');
  write(
    'app/share/page.tsx',
    "'use client';\nexport default function Share({ copied }: { copied: boolean }) {\n  return <button onClick={() => fetch('/api/share', { method: 'POST' })}>{copied ? 'Copied' : 'Copy link'}</button>;\n}\n",
  );
  write(
    'app/page.tsx',
    "'use client';\nimport { signOut } from 'next-auth/react';\nimport { SubmitButton } from './submit-button';\nasync function subscribe() {\n  'use server';\n  await fetch('/api/subscribe', { method: 'POST' });\n}\nexport default function Home({ mode }: { mode: string }) {\n  return (\n    <main>\n      <button onClick={() => signOut()}>Sign Out</button>\n      <form action={subscribe}><SubmitButton /></form>\n      <form action={subscribe}><button>{mode === 'signin' ? ('Sign in') : ('Sign up')}</button></form>\n    </main>\n  );\n}\n",
  );
  write('app/submit-button.tsx', "export function SubmitButton() {\n  return <button type=\"submit\">Subscribe Now</button>;\n}\n");
  const project = tempProject(join(tmp, 'labels-project'));
  const { graph } = await scanRepo(project, addRepo(project, dir, 'web').config.repos[0]);
  assert.ok(graph);
  const names = candidates(graph).flows.map((flow) => flow.name).filter((name) => !name.startsWith('User can view')).sort();
  assert.deepEqual(names, ['User can copy link', 'User can press Next page', 'User can press Prev', 'User can save changes', 'User can sign in', 'User can sign out', 'User can subscribe now']);
});

test('page titles and pressed labels read as plain words', () => {
  assert.deepEqual(
    ['/', '/account/orders', '/products/[id]', '/docs/[...slug]', '/[...slug]', '/(shop)/categories/[slug]'].map(pageTitle),
    ['the home page', 'the account orders page', 'product details', 'the docs pages', 'any page by its path', 'category details'],
  );
  assert.deepEqual(['Sign Out', 'Sign in with GitHub', 'Proceed to Checkout', 'Prev', 'New post'].map(pressing), ['sign out', 'sign in with GitHub', 'proceed to checkout', 'press Prev', 'press New post']);
});
