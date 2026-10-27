// Prefixes and route paths join the way Express joins them; "/" adds nothing and there is no trailing slash.
export function joinPath(...parts: string[]): string {
  const joined = `/${parts.join('/')}`.replace(/\/{2,}/g, '/');
  return joined.length > 1 ? joined.replace(/\/$/, '') : joined;
}
