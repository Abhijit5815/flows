// Phase 2 spike for open item 13.2: does ast-grep parse every sample file, and can ts-morph
// resolve the constants, imports and properties the adapters will depend on?
import { Lang, parse, type SgNode } from '@ast-grep/napi';
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { extname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Node, Project, SyntaxKind } from 'ts-morph';
import { percentile } from '../../src/shared/stats.ts';

const SAMPLES = fileURLToPath(new URL('../../fixtures/samples/', import.meta.url));
const LANG_BY_EXT: Record<string, Lang> = { '.ts': Lang.TypeScript, '.mts': Lang.TypeScript, '.tsx': Lang.Tsx, '.js': Lang.JavaScript, '.jsx': Lang.Tsx, '.mjs': Lang.JavaScript };

function listFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    if (name === 'node_modules' || name === '.git') return [];
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return listFiles(path);
    return LANG_BY_EXT[extname(name)] ? [path] : [];
  });
}

// 1. ast-grep: parse every file, timing it and counting parse errors.
const files = listFiles(SAMPLES);
const times: number[] = [];
const withErrors: string[] = [];
for (const file of files) {
  const source = readFileSync(file, 'utf8');
  const start = performance.now();
  const root = parse(LANG_BY_EXT[extname(file)], source).root();
  times.push(performance.now() - start);
  const errors = root.findAll({ rule: { kind: 'ERROR' } });
  if (errors.length > 0) withErrors.push(`${relative(SAMPLES, file)} (${errors.length} error nodes, first at line ${errors[0].range().start.line + 1})`);
}

// 2. ast-grep: do the patterns the adapters need actually match?
const rootOf = (path: string) => parse(LANG_BY_EXT[extname(path)], readFileSync(join(SAMPLES, path), 'utf8')).root();
const lines = (nodes: SgNode[]) => nodes.map((node) => node.range().start.line + 1);
const routeCall = { rule: { pattern: '$R.$M($PATH, $$$HANDLERS)' }, constraints: { M: { regex: '^(get|post|put|patch|delete|all)$' } } };
const patternChecks = [
  ['express-starter users.route.ts: $R.$M($PATH, ...) route calls', lines(rootOf('typescript-express-starter/lib/default/src/routes/users.route.ts').findAll(routeCall))],
  ['chessu auth.route.ts: router.route($PATH) chains', lines(rootOf('chessu/server/src/routes/auth.route.ts').findAll({ rule: { pattern: '$R.route($PATH)' } }))],
  ['chessu routes/index.ts: router.use($PREFIX, $ROUTER) mounts', lines(rootOf('chessu/server/src/routes/index.ts').findAll({ rule: { pattern: '$R.use($PREFIX, $ROUTER)' } }))],
  ['chessu lib/game.ts: fetch($URL, ...) calls', lines(rootOf('chessu/client/src/lib/game.ts').findAll({ rule: { pattern: 'fetch($URL, $$$REST)' } }))],
  ['next-learn actions.ts: "use server" directive', lines(rootOf('next-learn/dashboard/final-example/app/lib/actions.ts').findAll({ rule: { pattern: "'use server'" } }))],
] as const;

// 3. ts-morph: load each app with its own tsconfig and resolve the hard cases.
type Check = { name: string; ok: boolean; detail: string };
const checks: Check[] = [];
const loads: string[] = [];
function project(tsconfig: string): Project {
  const start = performance.now();
  const loaded = new Project({ tsConfigFilePath: join(SAMPLES, tsconfig) });
  loads.push(`${tsconfig}: ${loaded.getSourceFiles().length} files in ${(performance.now() - start).toFixed(0)} ms`);
  return loaded;
}
function check(name: string, run: () => string | undefined): void {
  try {
    const detail = run();
    checks.push({ name, ok: detail !== undefined, detail: detail ?? 'not resolved' });
  } catch (error) {
    checks.push({ name, ok: false, detail: `threw: ${error instanceof Error ? error.message : String(error)}` });
  }
}
const declarationText = (node: Node | undefined) => node?.getText().replace(/\s+/g, ' ').slice(0, 120);

const client = project('chessu/client/tsconfig.json');
check('chessu client: `${API_URL}` in lib/game.ts resolves through the @/ alias to its declaration', () => {
  const file = client.getSourceFileOrThrow(join(SAMPLES, 'chessu/client/src/lib/game.ts'));
  const apiUrl = file.getFirstDescendant((node) => Node.isIdentifier(node) && node.getText() === 'API_URL' && Node.isTemplateSpan(node.getParent()));
  return declarationText(apiUrl && Node.isIdentifier(apiUrl) ? apiUrl.getDefinitionNodes()[0] : undefined);
});

const starter = project('typescript-express-starter/lib/default/tsconfig.json');
check('express-starter: `${this.path}` resolves to the class property initializer', () => {
  const file = starter.getSourceFileOrThrow(join(SAMPLES, 'typescript-express-starter/lib/default/src/routes/users.route.ts'));
  const access = file.getDescendantsOfKind(SyntaxKind.PropertyAccessExpression).find((node) => node.getText() === 'this.path');
  const declaration = access?.getNameNode().getDefinitionNodes()[0];
  return declaration && Node.isPropertyDeclaration(declaration) ? `path = ${declaration.getInitializer()?.getText()}` : undefined;
});
check('express-starter: `new UserRoute()` in server.ts resolves through the @routes/ alias to the class', () => {
  const file = starter.getSourceFileOrThrow(join(SAMPLES, 'typescript-express-starter/lib/default/src/server.ts'));
  const expression = file.getDescendantsOfKind(SyntaxKind.NewExpression).find((node) => node.getExpression().getText() === 'UserRoute');
  const declaration = expression?.getExpression().asKind(SyntaxKind.Identifier)?.getDefinitionNodes()[0];
  return declaration ? `${declaration.getKindName()} in ${relative(SAMPLES, declaration.getSourceFile().getFilePath())}` : undefined;
});

const server = project('chessu/server/tsconfig.json');
check('chessu server: `games` in router.use("/games", games) resolves to the router in games.route.ts', () => {
  const file = server.getSourceFileOrThrow(join(SAMPLES, 'chessu/server/src/routes/index.ts'));
  const games = file.getDescendantsOfKind(SyntaxKind.CallExpression).find((call) => call.getText().startsWith('router.use("/games"'))?.getArguments()[1];
  const declaration = games?.asKind(SyntaxKind.Identifier)?.getDefinitionNodes()[0];
  return declaration ? `${declaration.getKindName()} "${declarationText(declaration)}" in ${relative(SAMPLES, declaration.getSourceFile().getFilePath())}` : undefined;
});

const learn = project('next-learn/dashboard/final-example/tsconfig.json');
check('next-learn: useFormState(createInvoice) resolves to the "use server" action', () => {
  const file = learn.getSourceFileOrThrow(join(SAMPLES, 'next-learn/dashboard/final-example/app/ui/invoices/create-form.tsx'));
  const call = file.getDescendantsOfKind(SyntaxKind.CallExpression).find((node) => node.getExpression().getText() === 'useFormState');
  const declaration = call?.getArguments()[0]?.asKind(SyntaxKind.Identifier)?.getDefinitionNodes()[0];
  if (!declaration) return undefined;
  const target = declaration.getSourceFile();
  const usesServer = target.getStatements()[0]?.getText().includes('use server');
  return `${declaration.getKindName()} in ${relative(SAMPLES, target.getFilePath())}${usesServer ? ' (file starts with "use server")' : ''}`;
});

const report = [
  '# Parser spike results (Phase 2, open item 13.2)',
  '',
  `ast-grep (@ast-grep/napi) parsed ${files.length} files from the three sample repos.`,
  `- per-file parse time: p50 ${percentile(times, 50).toFixed(2)} ms, p95 ${percentile(times, 95).toFixed(2)} ms, max ${percentile(times, 100).toFixed(2)} ms, total ${times.reduce((a, b) => a + b, 0).toFixed(0)} ms`,
  `- files with parse errors: ${withErrors.length}${withErrors.length ? `\n${withErrors.map((line) => `  - ${line}`).join('\n')}` : ''}`,
  '',
  'Pattern checks (match lines):',
  ...patternChecks.map(([name, found]) => `- ${name}: ${found.length} match(es) at lines ${found.join(', ') || 'none'}`),
  '',
  'ts-morph project loads:',
  ...loads.map((line) => `- ${line}`),
  '',
  'ts-morph resolution checks:',
  ...checks.map((c) => `- ${c.ok ? 'PASS' : 'FAIL'}: ${c.name} -> ${c.detail}`),
  '',
].join('\n');
writeFileSync(new URL('./RESULTS.md', import.meta.url), report);
console.log(report);
if (checks.some((c) => !c.ok) || patternChecks.some(([, found]) => found.length === 0)) process.exitCode = 1;
