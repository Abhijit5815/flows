// Matching observed URLs to the patterns source declares (PLAN.md Phase 3: observed URLs like /orders/123 are matched
// to source route patterns like /orders/:id). Pages use Next.js App Router patterns, routes use Express 4 patterns;
// each side is matched only against its own kind.

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Next.js: [id] is one segment, [...slug] one or more, [[...slug]] zero or more. Route groups like (shop) aren't part
// of the URL; the adapter has already left them out.
export function pageRegex(pattern: string): RegExp {
  const segments = pattern.split('/').filter((segment) => segment !== '' && !/^\(.*\)$/.test(segment));
  let source = '';
  for (const segment of segments) {
    if (/^\[\[\.\.\..+\]\]$/.test(segment)) source += '(?:/[^/]+)*';
    else if (/^\[\.\.\..+\]$/.test(segment)) source += '(?:/[^/]+)+';
    else if (/^\[.+\]$/.test(segment)) source += '/[^/]+';
    else source += `/${escape(segment)}`;
  }
  return new RegExp(`^${source === '' ? '/' : source}/?$`);
}

// Express 4 (path-to-regexp 0.1): :id is one segment, :id? an optional one, :id(\d+) one that matches the regex,
// and * anything.
export function routeRegex(pattern: string): RegExp {
  let source = '';
  const token = /\/:(\w+)(\([^)]*\))?(\?)?|\*|[^/*]+|\//g;
  for (const match of pattern.matchAll(token)) {
    const [text, name, constraint, optional] = match;
    if (name !== undefined) {
      const segment = `/(${constraint === undefined ? '[^/]+?' : constraint.slice(1, -1)})`;
      source += optional === undefined ? segment : `(?:${segment})?`;
    } else if (text === '*') source += '.*';
    else source += escape(text);
  }
  return new RegExp(`^${source}/?$`, 'i');
}

// How specific a pattern is: static segments first, so /products/new wins over /products/[id].
const specificity = (pattern: string) => pattern.split('/').filter((segment) => segment !== '' && !/^[[:*]/.test(segment)).length;

// The most specific pattern that matches the path, if any.
export function bestMatch(path: string, patterns: readonly string[], toRegex: (pattern: string) => RegExp): string | undefined {
  return patterns.filter((pattern) => toRegex(pattern).test(path)).sort((a, b) => specificity(b) - specificity(a) || b.length - a.length)[0];
}

// A path with no source pattern: segments that look like ids become ":id", so /orders/123 and /orders/456 are one.
// shortcut: ids are guessed (numbers, UUIDs, long hex, masked values, short codes mixing letters and digits); a
// code made of letters only stays as it is, so such pages are explored once per code until source gives a pattern.
export const generalize = (path: string): string =>
  path
    .split('/')
    .map((segment) =>
      /^\d+$/.test(segment) || /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(segment) || /^[0-9a-f]{12,}$/i.test(segment) || /^\[\w+\]$/.test(segment) || /^(?=.*\d)(?=.*[a-z])[a-z0-9_-]{6,}$/i.test(segment)
        ? ':id'
        : segment,
    )
    .join('/');
