// Test helper shared by the live tests: they call real models only when FLOWS_LIVE_TESTS=1.
import { fileURLToPath } from 'node:url';

export const liveSkip: false | string = process.env.FLOWS_LIVE_TESTS === '1' ? false : 'set FLOWS_LIVE_TESTS=1 to call real models';

// Weights shared by every live run, inside the gitignored .cache folder.
export const liveModelsDir = fileURLToPath(new URL('../../../.cache/flows/models', import.meta.url));
