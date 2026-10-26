'use client';

import { addToCart } from '@/lib/api';

export default function AddToCartButton({ productId }: { productId: number }) {
  return <button onClick={() => addToCart(productId)}>Add to cart</button>;
}
