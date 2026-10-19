import type { FrameworkAdapter } from '../adapter.ts';

export const nextAppAdapter: FrameworkAdapter = {
  id: 'nextjs-app',
  role: 'web',
  // Only the App Router is supported; a Pages Router app has no app/ folder and is reported, not guessed at.
  detection: { dependency: 'next', testedMajor: 14, needsOneOf: ['app', 'src/app'] },
  // Placeholder: detection only, until the Next.js adapter itself is added.
  rules: [],
  extract: () => [],
};
