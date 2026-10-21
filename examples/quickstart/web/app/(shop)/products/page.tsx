import { ProductCard } from '@/components/ProductCard';
import { getProducts } from '@/lib/api';

export default async function ProductsPage() {
  const products = await getProducts();
  return products.map((product) => <ProductCard key={product.id} product={product} />);
}
