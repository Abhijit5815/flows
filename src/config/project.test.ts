import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_CATEGORIES } from '../model/category.ts';
import { ConfigError } from '../shared/errors.ts';
import { addRepo, apiKey, categories, configFile, findRepo, initProject, loadProject, projectDataDir, setFramework, storageDir, threshold } from './project.ts';

const tmp = mkdtempSync(join(tmpdir(), 'flows-config-'));
after(() => rmSync(tmp, { recursive: true, force: true }));

let n = 0;
function freshRoot(): string {
  const root = join(tmp, `p${n++}`);
  mkdirSync(join(root, 'apps', 'web'), { recursive: true });
  mkdirSync(join(root, 'apps', 'api'), { recursive: true });
  return root;
}

const isConfigError = (pattern: RegExp) => (error: unknown) => error instanceof ConfigError && pattern.test(error.message);

test('init writes only id, name and repos; loading fills in every default', () => {
  const root = freshRoot();
  initProject(root, 'demo');
  const written = JSON.parse(readFileSync(configFile(root), 'utf8'));
  assert.deepEqual(Object.keys(written).sort(), ['id', 'name', 'repos', 'schema_version']);

  const { config } = loadProject(root);
  assert.deepEqual(config.llm, { provider: 'openai-compatible', base_url: 'http://localhost:11434/v1', model: 'llama3.2:3b', timeout_ms: 120_000 });
  assert.deepEqual(config.embedder, { provider: 'local', model: 'bge-small-en-v1.5' });
  assert.deepEqual(threshold(config, 'destructive-risk'), { min_prob: 0.7, min_margin: 0.1 });
  assert.equal(categories(config), DEFAULT_CATEGORIES);
  assert.deepEqual(config.explorer, { max_pages: 50, max_depth: 3, min_safe_prob: 0.8, logins: {} });
  assert.equal(config.engine.observed_only_weight, 0.9);
});

test('init refuses to overwrite an existing project', () => {
  const root = freshRoot();
  initProject(root, 'demo');
  assert.throws(() => initProject(root, 'again'), isConfigError(/already exists/));
});

test('loading a folder without a project says how to create one', () => {
  assert.throws(() => loadProject(freshRoot()), isConfigError(/flows init/));
});

test('a config that is not JSON, or has invalid values, is a ConfigError', () => {
  const root = freshRoot();
  initProject(root, 'demo');
  writeFileSync(configFile(root), '{ not json');
  assert.throws(() => loadProject(root), isConfigError(/not valid JSON/));

  const raw = { schema_version: 0, id: crypto.randomUUID(), name: 'demo', repos: [], llm: { provider: 'openai-compatible', base_url: 'nope', model: 'm' } };
  writeFileSync(configFile(root), JSON.stringify(raw));
  assert.throws(() => loadProject(root), isConfigError(/base_url/));
});

test('repos are stored relative to the project root, one per path and role', () => {
  const root = freshRoot();
  let project = initProject(root, 'demo');
  project = addRepo(project, join(root, 'apps', 'web'), 'web');
  project = addRepo(project, 'apps/api', 'api');
  project = addRepo(project, 'apps/api', 'web'); // the same folder may serve both roles
  assert.deepEqual(loadProject(root).config.repos, [
    { path: 'apps/web', role: 'web' },
    { path: 'apps/api', role: 'api' },
    { path: 'apps/api', role: 'web' },
  ]);

  // The input is what's wrong, so the message says so, not that the config file is invalid.
  assert.throws(() => addRepo(project, './apps/api', 'api'), isConfigError(/^\.\/apps\/api is already registered as api$/));
  assert.throws(() => addRepo(project, 'apps/web', 'mobile'), isConfigError(/^the role must be web or api, not "mobile"$/));
  assert.throws(() => addRepo(project, 'apps/missing', 'web'), isConfigError(/not a directory/));
});

test('a repo can pin its framework, and the pin can be cleared', () => {
  const root = freshRoot();
  let project = addRepo(addRepo(initProject(root, 'demo'), 'apps/api', 'api'), 'apps/api', 'web');
  project = setFramework(project, findRepo(project, './apps/api', 'api'), 'express');
  assert.deepEqual(loadProject(root).config.repos, [
    { path: 'apps/api', role: 'api', framework: 'express' },
    { path: 'apps/api', role: 'web' },
  ]);
  project = setFramework(project, findRepo(project, 'apps/api', 'api'), undefined);
  assert.deepEqual(loadProject(root).config.repos, [
    { path: 'apps/api', role: 'api' },
    { path: 'apps/api', role: 'web' },
  ]);
  assert.throws(() => findRepo(project, 'apps/api'), isConfigError(/registered as both web and api/));
  assert.throws(() => findRepo(project, 'apps/web'), isConfigError(/apps\/web is not registered/));
});

test('storage: config value, then FLOWS_HOME, then ~/.cache/flows', () => {
  const root = freshRoot();
  const project = initProject(root, 'demo');
  const saved = process.env.FLOWS_HOME;
  try {
    delete process.env.FLOWS_HOME;
    assert.equal(storageDir(project), join(homedir(), '.cache', 'flows'));
    process.env.FLOWS_HOME = join(tmp, 'home');
    assert.equal(storageDir(project), join(tmp, 'home'));
    const custom = { ...project, config: { ...project.config, storage_dir: 'cache' } };
    assert.equal(storageDir(custom), join(root, 'cache'));
  } finally {
    if (saved === undefined) delete process.env.FLOWS_HOME;
    else process.env.FLOWS_HOME = saved;
  }
});

test('API keys come from the named environment variable, and a missing one is an error', () => {
  const config = { provider: 'openai-compatible' as const, base_url: 'http://localhost:11434/v1', model: 'm', timeout_ms: 1000 };
  assert.equal(apiKey(config), undefined);
  process.env.FLOWS_TEST_KEY = 'k';
  assert.equal(apiKey({ ...config, api_key_env: 'FLOWS_TEST_KEY' }), 'k');
  delete process.env.FLOWS_TEST_KEY;
  assert.throws(() => apiKey({ ...config, api_key_env: 'FLOWS_TEST_KEY' }), isConfigError(/FLOWS_TEST_KEY is not set/));
});

test("a copied project keeps the id but never shares the original's cache", () => {
  const root = freshRoot();
  const original = initProject(root, 'demo');
  cpSync(root, `${root}-copy`, { recursive: true });
  const copy = loadProject(`${root}-copy`);
  assert.equal(copy.config.id, original.config.id);
  assert.notEqual(projectDataDir(copy), projectDataDir(original));
  assert.equal(projectDataDir(loadProject(root)), projectDataDir(original), 'the same folder keeps its cache');
});
