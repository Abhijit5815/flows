import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { z } from 'zod';
import { CategorySchema, DEFAULT_CATEGORIES, type Category } from '../model/category.ts';
import { ConfigError } from '../shared/errors.ts';
import { parseOrThrow } from '../shared/validate.ts';

const RoleSchema = z.enum(['web', 'api']);

const OpenAiCompatibleSchema = z.object({
  provider: z.literal('openai-compatible'),
  base_url: z.url(),
  model: z.string().min(1),
  api_key_env: z.string().min(1).optional(),
  timeout_ms: z.int().positive().default(120_000),
});

const AnthropicSchema = z.object({
  provider: z.literal('anthropic'),
  model: z.string().min(1).default('claude-opus-5-5'),
  effort: z.enum(['low', 'medium', 'high', 'xhigh', 'max']).default('low'),
});

const LocalEmbedderSchema = z.object({
  provider: z.literal('local'),
  model: z.string().min(1).default('bge-small-en-v1.5'),
});

const ThresholdSchema = z.object({ min_prob: z.number().min(0).max(1), min_margin: z.number().min(0).max(1) });

export const DEFAULT_THRESHOLD: Threshold = { min_prob: 0.7, min_margin: 0.1 };

export const ProjectConfigSchema = z.object({
  schema_version: z.literal(0),
  id: z.uuid(),
  name: z.string().min(1),
  repos: z.array(z.object({ path: z.string().min(1), role: RoleSchema })).superRefine((repos, ctx) => {
    const seen = new Set<string>();
    repos.forEach((repo, i) => {
      const key = `${repo.role}:${repo.path}`;
      if (seen.has(key)) ctx.addIssue({ code: 'custom', path: [i], message: `${repo.path} is already registered as ${repo.role}` });
      seen.add(key);
    });
  }),
  // Default: a free local model, so nothing leaves the machine and no API key or billing is needed.
  llm: z
    .discriminatedUnion('provider', [AnthropicSchema, OpenAiCompatibleSchema])
    .prefault({ provider: 'openai-compatible', base_url: 'http://localhost:11434/v1', model: 'llama3.2:3b' }),
  embedder: z.discriminatedUnion('provider', [LocalEmbedderSchema, OpenAiCompatibleSchema]).prefault({ provider: 'local' }),
  decider: z.object({ thresholds: z.record(z.string(), ThresholdSchema).prefault({}) }).prefault({}),
  storage_dir: z.string().min(1).optional(),
  categories: z.array(CategorySchema).min(1).optional(),
});

export type ProjectConfig = z.infer<typeof ProjectConfigSchema>;
export type Role = z.infer<typeof RoleSchema>;
export type LlmConfig = ProjectConfig['llm'];
export type EmbedderConfig = ProjectConfig['embedder'];
export type OpenAiCompatibleConfig = z.infer<typeof OpenAiCompatibleSchema>;
export type Threshold = z.infer<typeof ThresholdSchema>;

// `raw` is the file as written, so saving keeps only what the user set; defaults stay in the schema.
export type Project = { root: string; config: ProjectConfig; raw: Record<string, unknown> };

export const configFile = (root: string): string => join(root, '.flows', 'config.json');

function validate(root: string, raw: unknown): Project {
  const config = parseOrThrow(ProjectConfigSchema, raw, configFile(root), ConfigError);
  return { root, config, raw: raw as Record<string, unknown> }; // safe: the schema accepted an object
}

function write(project: Project): void {
  const file = configFile(project.root);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(`${file}.tmp`, `${JSON.stringify(project.raw, null, 2)}\n`);
  renameSync(`${file}.tmp`, file); // atomic, so a crash never leaves half a config
}

export function initProject(root: string, name: string): Project {
  if (existsSync(configFile(root))) throw new ConfigError(`${configFile(root)} already exists`);
  const project = validate(root, { schema_version: 0, id: randomUUID(), name, repos: [] });
  write(project);
  return project;
}

export function loadProject(root: string): Project {
  const file = configFile(root);
  if (!existsSync(file)) throw new ConfigError(`no Flows project in ${root} (missing .flows/config.json); run "flows init" first`);
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    throw new ConfigError(`${file} is not valid JSON`, { cause: error });
  }
  return validate(root, raw);
}

export function addRepo(project: Project, path: string, role: string): Project {
  const absolute = resolve(project.root, path);
  if (!existsSync(absolute) || !statSync(absolute).isDirectory()) throw new ConfigError(`${path} is not a directory`);
  // Stored relative to the project root so the config still works if the folder moves.
  const repo = { path: relative(project.root, absolute) || '.', role };
  const updated = validate(project.root, { ...project.raw, repos: [...project.config.repos, repo] });
  write(updated);
  return updated;
}

// The project's own config wins, then FLOWS_HOME, then the per-user cache folder.
export function storageDir(project: Project): string {
  if (project.config.storage_dir !== undefined) return resolve(project.root, project.config.storage_dir);
  return process.env.FLOWS_HOME ?? join(homedir(), '.cache', 'flows');
}

export const projectDataDir = (project: Project): string => join(storageDir(project), 'projects', project.config.id);

export const categories = (config: ProjectConfig): readonly Category[] => config.categories ?? DEFAULT_CATEGORIES;

export const threshold = (config: ProjectConfig, task: string): Threshold => config.decider.thresholds[task] ?? DEFAULT_THRESHOLD;

// Keys only ever come from the environment; a named but unset variable is a config mistake, not "no key".
export function apiKey(config: OpenAiCompatibleConfig): string | undefined {
  if (config.api_key_env === undefined) return undefined;
  const key = process.env[config.api_key_env];
  if (!key) throw new ConfigError(`environment variable ${config.api_key_env} is not set`);
  return key;
}
