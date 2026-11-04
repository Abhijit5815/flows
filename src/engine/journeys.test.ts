import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { addRepo } from '../config/project.ts';
import { lookup } from '../graph/lookup.ts';
import { scanRepo } from '../ingest/pipeline.ts';
import { tempProject } from '../shared/testing/project.ts';
import { journeys } from './journeys.ts';

const tmp = mkdtempSync(join(tmpdir(), 'flows-journeys-'));
after(() => rmSync(tmp, { recursive: true, force: true }));

test('a journey follows links across three pages; the footer every page shows is not a step', async () => {
  const dir = join(tmp, 'app');
  const write = (file: string, text: string) => {
    mkdirSync(join(dir, file, '..'), { recursive: true });
    writeFileSync(join(dir, file), text);
  };
  write('package.json', JSON.stringify({ dependencies: { next: '^14.2.5' } }));
  write('tsconfig.json', JSON.stringify({ compilerOptions: { jsx: 'preserve', strict: true } }));
  write('app/footer.tsx', "import Link from 'next/link';\nexport function Footer() {\n  return <footer><Link href=\"/terms\">Terms</Link></footer>;\n}\n");
  const page = (name: string, h1: string, next?: [string, string]) =>
    `import Link from 'next/link';\nimport { Footer } from '../footer';\nexport default function ${name}() {\n  return <main><h1>${h1}</h1>${next === undefined ? '' : `<Link href="${next[0]}">${next[1]}</Link>`}<Footer /></main>;\n}\n`;
  write('app/a/page.tsx', page('A', 'Start here', ['/b', 'Next step']));
  write('app/b/page.tsx', page('B', 'Middle', ['/c', 'Finish up']));
  write('app/c/page.tsx', page('C', 'The end'));
  write('app/d/page.tsx', page('D', 'Elsewhere'));
  write('app/terms/page.tsx', page('Terms', 'Terms of use'));
  const project = tempProject(join(tmp, 'project'));
  const { graph } = await scanRepo(project, addRepo(project, dir, 'web').config.repos[0]);
  assert.ok(graph);
  const found = journeys(graph, lookup(graph));
  assert.deepEqual(found.map((flow) => flow.name), ['Journey: Start here → Middle → The end']);
  const [journey] = found;
  assert.deepEqual(journey.steps.map((step) => step.claim), ['Open /a', 'Click Next step to go to /b', 'Click Finish up to go to /c']);
  assert.deepEqual(journey.steps.at(-1)?.action?.button, { text: 'Finish up', selector: 'role=link[name="Finish up"]' });
  assert.deepEqual(journey.tags, ['journey']);
});
