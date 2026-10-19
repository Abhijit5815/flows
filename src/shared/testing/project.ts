// Test helper: a new project whose storage stays inside its own folder, never in the real ~/.cache/flows.
import { readFileSync } from 'node:fs';
import { configFile, initProject, loadProject, type Project } from '../../config/project.ts';
import { writeJsonAtomic } from '../json-file.ts';

export function tempProject(root: string): Project {
  initProject(root, 'test');
  writeJsonAtomic(configFile(root), { ...JSON.parse(readFileSync(configFile(root), 'utf8')), storage_dir: 'store' }, 2);
  return loadProject(root);
}
