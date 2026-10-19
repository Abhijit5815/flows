import type { FrameworkAdapter } from '../adapter.ts';

export const expressAdapter: FrameworkAdapter = {
  id: 'express',
  role: 'api',
  detection: { dependency: 'express', testedMajor: 4 },
};
