// Test helper shared by the browser tests: they run when an installed browser starts, and skip with the reason
// otherwise (PLAN.md Phase 3: Flows drives the person's own browser and downloads none).
import { launchBrowser } from '../../live/browser.ts';

export const browserSkip: false | string = await launchBrowser(undefined, true).then(
  async ({ browser }) => {
    await browser.close();
    return false as const;
  },
  (error: Error) => error.message,
);
