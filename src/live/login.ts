import { chmodSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { BrowserContext, Page } from 'playwright-core';
import { projectDataDir, type ExplorerConfig, type Project } from '../config/project.ts';
import { ConfigError, LiveError } from '../shared/errors.ts';
import { launchBrowser, newContext } from './browser.ts';
import type { Guard } from './readonly.ts';

// PLAN.md Phase 3 login: the person logs in themselves and the session is kept locally, or the config points to
// credentials in env. Flows invents none.

export type Credentials = { user: string; password: string; path: string | undefined };

// A saved session can sign someone in, so it lives in the cache, never in .flows/, and is never exported or printed.
export const sessionFile = (project: Project, name: string): string => join(projectDataDir(project), 'sessions', `${name}.json`);

// Owner-only where the OS has POSIX modes; on Windows the user folder's own permissions apply.
export async function saveSession(context: BrowserContext, file: string): Promise<void> {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  await context.storageState({ path: file });
  try {
    chmodSync(file, 0o600);
  } catch {
    // no POSIX modes here (Windows)
  }
}

// The credentials of a named login, read from the variables the config names. A named variable that isn't set is a
// config mistake, not "no login".
export function envCredentials(config: ExplorerConfig, name: string): Credentials | undefined {
  const login = config.logins[name];
  if (login === undefined) return undefined;
  const value = (variable: string, field: string) => {
    const found = process.env[variable];
    if (!found) throw new ConfigError(`environment variable ${variable} (explorer.logins.${name}.${field}) is not set`);
    return found;
  };
  return { user: value(login.user_env, 'user_env'), password: value(login.password_env, 'password_env'), path: login.path };
}

const visiblePassword = (page: Page) => page.locator('input[type=password]').visible().first();

// Types the env credentials into the form that has the password field, on `path` or the start page (opening a
// "Log in" or "Sign in" control first if no password field shows), and submits it. The read-only guard lets through
// that one submit: the write whose body carries the password.
// onForm runs once the login form is found and before anything is typed, so the explorer can record the login as a
// form it submitted.
export async function loginWithEnv(page: Page, guard: Guard, credentials: Credentials, start: URL, settle: () => Promise<void>, onForm: () => Promise<void> = async () => undefined): Promise<void> {
  const at = new URL(credentials.path ?? start.pathname, start).href;
  await page.goto(at);
  await settle();
  if ((await visiblePassword(page).count()) === 0) {
    // A button, a link, or a plain clickable element (a tab in a sign-in dialog) that says "Log in" or "Sign in".
    const opener = page
      .getByRole('button', { name: /^(log ?in|sign ?in)$/i })
      .or(page.getByRole('link', { name: /^(log ?in|sign ?in)$/i }))
      .or(page.getByText(/^\s*(log ?in|sign ?in)\s*$/i))
      .visible()
      .first();
    if ((await opener.count()) === 0) throw new LiveError(`no login form at ${at}: no password field, and no "Log in" or "Sign in" control to open one; set explorer.logins.<name>.path to the login page`);
    await opener.click({ timeout: 5000 });
    await settle();
  }
  const password = visiblePassword(page);
  if ((await password.count()) === 0) throw new LiveError(`no password field at ${at}, even after opening the login control`);
  // The user field is the visible text or email field just before the password field, in the same form.
  const found = await password.evaluate((input) => {
    const scope = input.closest('form') ?? document.body;
    const before = [...scope.querySelectorAll('input')].filter(
      (field) => ['text', 'email', 'tel', ''].includes(field.type) && field.checkVisibility() && (field.compareDocumentPosition(input) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0,
    );
    const user = before.at(-1);
    if (user === undefined) return false;
    user.setAttribute('data-flows-login', 'user');
    input.setAttribute('data-flows-login', 'password');
    return true;
  });
  if (!found) throw new LiveError(`no user field before the password field at ${at}`);
  await onForm();
  await page.locator('[data-flows-login=user]').fill(credentials.user);
  await page.locator('[data-flows-login=password]').fill(credentials.password);
  const submit = page.locator('[data-flows-login=password]').locator('xpath=ancestor::form[1]').locator('button[type=submit], button:not([type]), input[type=submit]').first();
  await guard.allowLogin(credentials.password, async () => {
    if ((await submit.count()) > 0) await submit.click({ timeout: 5000 });
    else await page.locator('[data-flows-login=password]').press('Enter');
    await settle();
  });
  if ((await visiblePassword(page).count()) > 0) throw new LiveError(`the login at ${at} didn't work: the password field is still there (wrong credentials, a second step or a captcha); log in by hand with "flows login" instead`);
}

// `flows login`: a visible browser at the URL, where the person logs in; when they say they're done, the session is
// saved for the explorer and the inspector. Nothing is blocked here: the person is the one acting.
export async function loginByHand(url: string, file: string, config: ExplorerConfig, done: () => Promise<void>): Promise<void> {
  if (process.platform === 'linux' && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) {
    throw new LiveError('there is no display to open a browser on; put env credentials in explorer.logins instead');
  }
  const { browser } = await launchBrowser(config.browser, false);
  try {
    const context = await newContext(browser);
    const page = await context.newPage();
    await page.goto(url);
    await done();
    await saveSession(context, file);
  } finally {
    await browser.close();
  }
}
