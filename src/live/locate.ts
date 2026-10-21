import type { Locator, Page } from 'playwright-core';

type Role = Parameters<Page['getByRole']>[0];

// The element a Flows selector names (snapshot.ts), as a Playwright locator. The first match is used: a selector was
// unique when it was taken, and a page that changed since gets its first look-alike rather than nothing.
export function locate(page: Page, selector: string): Locator {
  const colon = selector.indexOf(':');
  const kind = selector.slice(0, colon);
  const value = selector.slice(colon + 1);
  const quoted = (text: string) => JSON.stringify(text);
  switch (kind) {
    case 'testid':
      return page.locator(`[data-testid=${quoted(value)}]`).first();
    case 'attr': {
      const at = value.indexOf('=');
      return page.locator(`[${value.slice(0, at)}=${quoted(value.slice(at + 1))}]`).first();
    }
    case 'id':
      return page.locator(`[id=${quoted(value)}]`).first();
    case 'name':
      return page.locator(`[name=${quoted(value)}]`).first();
    case 'role': {
      const space = value.indexOf(' ');
      return page.getByRole(value.slice(0, space) as Role, { name: value.slice(space + 1).replace(/^"|"$/g, ''), exact: true }).first();
    }
    default:
      return page.locator(`xpath=${value}`).first();
  }
}
