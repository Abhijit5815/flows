import { API_URL } from './config';

export type Product = { id: number; name: string; price: number };

export async function getProducts(): Promise<Product[]> {
  const res = await fetch(`${API_URL}/products`, { cache: 'no-store' });
  return res.json();
}

export async function getProduct(id: string): Promise<Product> {
  const res = await fetch(`${API_URL}/products/${id}`);
  return res.json();
}

export async function addToCart(productId: number) {
  await fetch(`${API_URL}/cart/items`, { method: 'POST', body: JSON.stringify({ productId }) });
}

export async function updateProfile(name: string, email: string) {
  await fetch(`${API_URL}/users/me`, { method: 'PATCH', body: JSON.stringify({ name, email }) });
}
