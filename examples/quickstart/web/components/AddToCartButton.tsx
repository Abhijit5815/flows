'use client';

import { addToCart } from '@/lib/api';

export default function AddToCartButton({ productId }: { productId: string }) {
  return <button onClick={() => addToCart(productId)}>Add to cart</button>;
}
