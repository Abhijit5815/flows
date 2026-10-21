'use server';

import { redirect } from 'next/navigation';
import { z } from 'zod';
import { API_URL } from '@/lib/config';

const Credentials = z.object({ email: z.string().email(), password: z.string().min(8) });

export async function login(previous: string | undefined, formData: FormData) {
  const parsed = Credentials.safeParse({ email: formData.get('email'), password: formData.get('password') });
  if (!parsed.success) return 'Enter a valid email and password.';
  const res = await fetch(`${API_URL}/auth/login`, { method: 'POST', body: JSON.stringify(parsed.data) });
  if (!res.ok) return 'Wrong email or password.';
  redirect('/account');
}

// Not wired to any form yet; the possibly-missed list should show it.
export async function resetPassword(formData: FormData) {
  await fetch(`${API_URL}/auth/reset`, { method: 'POST', body: JSON.stringify({ email: formData.get('email') }) });
}
