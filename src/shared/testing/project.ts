// Test helper: a new project whose storage stays inside its own folder, never in the real ~/.cache/flows.
import { initProject, type Project } from '../../config/project.ts';

export const tempProject = (root: string): Project => initProject(root, 'test', 'store');
