import { API_URL } from '@/lib/config';

export default async function CartPage() {
  const cart = await fetch(`${API_URL}/cart`, { cache: 'no-store' }).then((res) => res.json());
  return <pre>{JSON.stringify(cart)}</pre>;
}
