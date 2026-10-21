import AddToCartButton from '@/components/AddToCartButton';
import { getProduct } from '@/lib/api';

export default async function ProductPage({ params }: { params: { id: string } }) {
  const product = await getProduct(params.id);
  return (
    <main>
      <h1>{product.name}</h1>
      <AddToCartButton productId={product.id} />
    </main>
  );
}
