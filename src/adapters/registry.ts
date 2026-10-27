import type { Role } from '../config/project.ts';
import { ConfigError } from '../shared/errors.ts';
import type { FrameworkAdapter } from './adapter.ts';
import { expressAdapter } from './express/express.ts';
import { nestAdapter } from './nestjs/nestjs.ts';
import { nextApiAdapter } from './nextjs-api/nextjs-api.ts';
import { nextAppAdapter } from './nextjs-app/nextjs.ts';

export const ADAPTERS: readonly FrameworkAdapter[] = [expressAdapter, nextAppAdapter, nextApiAdapter, nestAdapter];

// For a framework the user names (config or CLI): it must exist and read repos of this role.
export function adapterFor(id: string, role: Role, adapters: readonly FrameworkAdapter[] = ADAPTERS): FrameworkAdapter {
  const adapter = adapters.find((candidate) => candidate.id === id);
  if (adapter === undefined) throw new ConfigError(`unknown framework "${id}"; known: ${adapters.map((a) => a.id).join(', ')}`);
  if (adapter.role !== role) throw new ConfigError(`${id} reads ${adapter.role} repos, not ${role} repos`);
  return adapter;
}
