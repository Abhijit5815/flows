import Link from 'next/link';
import { API_URL } from '@/lib/config';

export default function Header() {
  return (
    <header>
      <Link href="/">Shop</Link>
      <form
        action={async () => {
          'use server';
          await fetch(`${API_URL}/users/logout`, { method: 'POST' });
        }}
      >
        <button>Sign out</button>
      </form>
    </header>
  );
}
