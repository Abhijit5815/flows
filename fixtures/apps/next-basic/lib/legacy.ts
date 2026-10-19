import { API_URL } from './config';

// No page uses this any more; the coverage report should say so.
export async function legacyPing() {
  await fetch(`${API_URL}/ping`);
}
