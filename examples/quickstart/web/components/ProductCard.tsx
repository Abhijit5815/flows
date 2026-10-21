import Link from 'next/link';
import type { Product } from '@/lib/api';
import AddToCartButton from './AddToCartButton';

export function ProductCard({ product }: { product: Product }) {
  return (
    <article>
      <Link href={`/products/${product.id}`}>{product.name}</Link>
      <AddToCartButton productId={product.id} />
    </article>
  );
}
