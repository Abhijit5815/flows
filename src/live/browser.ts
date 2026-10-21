import { chromium, type Browser, type BrowserContext, type LaunchOptions } from 'playwright-core';
import { LiveError } from '../shared/errors.ts';

const INSTALL = `npx playwright-core install chromium${process.platform === 'linux' ? ' --with-deps' : ''}`;

const isPath = (value: string) => /[\\/]/.test(value);
const firstLine = (error: unknown) => (error instanceof Error ? error.message : String(error)).split('\n')[0];

export type Launched = { browser: Browser; name: string };

// PLAN.md Phase 3: Flows downloads no browser. It drives one that is already installed, so it works the same on Mac,
// Windows and Linux: the one the config names (a Playwright channel or a path), else Google Chrome, else Microsoft
// Edge (preinstalled on Windows), else Playwright's own Chromium if the person installed it.
export async function launchBrowser(configured: string | undefined, headless: boolean): Promise<Launched> {
  const tries: { name: string; options: LaunchOptions }[] =
    configured === undefined
      ? [
          { name: 'Google Chrome', options: { channel: 'chrome' } },
          { name: 'Microsoft Edge', options: { channel: 'msedge' } },
          { name: "Playwright's Chromium", options: {} },
        ]
      : [{ name: configured, options: isPath(configured) ? { executablePath: configured } : { channel: configured } }];
  const failures: string[] = [];
  for (const { name, options } of tries) {
    try {
      return { browser: await chromium.launch({ ...options, headless }), name };
    } catch (error) {
      failures.push(`${name}: ${firstLine(error)}`);
    }
  }
  if (configured !== undefined) throw new LiveError(`can't start the browser "${configured}" set in explorer.browser: ${failures[0]}`);
  throw new LiveError(`no browser found: tried Google Chrome, Microsoft Edge and Playwright's Chromium. Install one of them, or run: ${INSTALL}`);
}

// A fresh, empty profile for each run, never the person's own. Service workers are blocked because route() can't
// see the requests they handle, and downloads are refused. Playwright dismisses dialogs (confirm, alert) by itself
// when nothing listens for them, so a confirm() before a delete answers "cancel".
export const newContext = (browser: Browser, storageState?: string): Promise<BrowserContext> =>
  browser.newContext({ serviceWorkers: 'block', acceptDownloads: false, viewport: { width: 1280, height: 800 }, ...(storageState === undefined ? {} : { storageState }) });
