// PLAN.md Phase 3 / §8: tokens and personal data in captured traffic are redacted before anything is written. A run
// file keeps what the cross-check and a reviewer need (method, path, status, the shape of a body, its harmless values)
// and nothing that could sign someone in or identify them.

// A name (header, JSON key, query parameter) whose value is a secret: split into words, so "access_token" and
// "sessionId" match but "author" doesn't.
const SECRET_WORDS = new Set(['password', 'passwd', 'pass', 'pwd', 'token', 'secret', 'key', 'apikey', 'session', 'sid', 'auth', 'authorization', 'cookie', 'otp', 'card', 'cvv', 'cvc', 'ssn', 'iban', 'pin', 'jwt', 'bearer', 'signature', 'credential', 'credentials']);

export const isSecretName = (name: string): boolean =>
  name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .some((word) => SECRET_WORDS.has(word));

// In any stored text: emails, JWTs, long hex or base64-like tokens, and long digit runs (cards, phone numbers).
const PATTERNS: [RegExp, string][] = [
  [/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[email]'],
  [/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*/g, '[jwt]'],
  [/\b[0-9a-f]{32,}\b/gi, '[token]'],
  // Random tokens mix upper case, lower case and digits; paths and slugs rarely do.
  [/(?<![A-Za-z0-9+/_-])(?=[A-Za-z0-9+/_-]*\d)(?=[A-Za-z0-9+/_-]*[a-z])(?=[A-Za-z0-9+/_-]*[A-Z])[A-Za-z0-9+/_-]{32,}={0,2}/g, '[token]'],
  [/(?<!\w)\+?\d(?:[ .()-]{0,2}\d){9,}(?!\w)/g, '[number]'],
];

export const redactText = (text: string): string => PATTERNS.reduce((out, [pattern, mask]) => out.replace(pattern, mask), text);

// A path segment that carries a secret or a person (a reset token, an email) becomes one masked segment, so a page
// or route pattern with a parameter there still matches.
export const redactPath = (path: string): string => path.split('/').map((segment) => (segment === '' ? segment : redactText(decodeSafe(segment)))).join('/');

function decodeSafe(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

// The URL without its fragment, secret query values masked and the rest redacted like text.
export function redactUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return redactText(raw);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return `${url.protocol}${redactText(url.href.slice(url.protocol.length))}`; // mailto:, tel:
  const query = [...url.searchParams].map(([name, value]) => `${encodeURIComponent(name)}=${isSecretName(name) ? '[redacted]' : encodeURIComponent(redactText(value))}`);
  return `${url.origin}${redactPath(url.pathname)}${query.length > 0 ? `?${query.join('&')}` : ''}`;
}

// Only these headers are kept, so Authorization, Cookie, Set-Cookie and every custom token header are never stored.
const KEPT_HEADERS = new Set(['content-type', 'content-length', 'location', 'cache-control', 'accept']);

export const redactHeaders = (headers: Record<string, string>): Record<string, string> =>
  Object.fromEntries(Object.entries(headers).flatMap(([name, value]) => (KEPT_HEADERS.has(name.toLowerCase()) ? [[name.toLowerCase(), redactText(value)]] : [])));

const MAX_ITEMS = 20;
const MAX_DEPTH = 6;

// A JSON value with secret keys masked, strings redacted, and long arrays and deep nesting cut short.
export function redactJson(value: unknown, depth = 0): unknown {
  if (typeof value === 'string') return redactText(value);
  if (value === null || typeof value !== 'object') return value;
  if (depth >= MAX_DEPTH) return '[…]';
  if (Array.isArray(value)) return [...value.slice(0, MAX_ITEMS).map((item) => redactJson(item, depth + 1)), ...(value.length > MAX_ITEMS ? [`[${value.length - MAX_ITEMS} more]`] : [])];
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, isSecretName(key) ? '[redacted]' : redactJson(item, depth + 1)]));
}

// What a blocked write would have sent, without any value: the type of each JSON field, or a form's field names.
export function bodyShape(body: string | null, contentType: string | undefined): unknown {
  if (body === null || body === '') return null;
  const type = contentType?.toLowerCase() ?? '';
  try {
    if (type.includes('json') || /^\s*[[{]/.test(body)) return shapeOf(JSON.parse(body));
  } catch {
    // not JSON after all: fall through to the field names
  }
  if (type.includes('x-www-form-urlencoded')) return { fields: [...new URLSearchParams(body).keys()] };
  if (type.includes('multipart/form-data')) return { fields: [...body.matchAll(/name="([^"]+)"/g)].map((match) => match[1]) };
  return { bytes: body.length };
}

// A JSON value's field types without its values.
export function shapeOf(value: unknown, depth = 0): unknown {
  if (value === null) return null;
  if (typeof value !== 'object') return typeof value;
  if (depth >= MAX_DEPTH) return '[…]';
  if (Array.isArray(value)) return value.length === 0 ? [] : [shapeOf(value[0], depth + 1)];
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, shapeOf(item, depth + 1)]));
}
