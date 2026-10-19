import { API_URL } from '@/lib/config';
import { cancelOrder } from './actions';

type Order = { id: string; total: number };

export default async function OrdersPage() {
  const orders: Order[] = await fetch(`${API_URL}/orders`).then((res) => res.json());
  return (
    <ul>
      {orders.map((order) => (
        <li key={order.id}>
          <form action={cancelOrder.bind(null, order.id)}>
            <button>Cancel</button>
          </form>
        </li>
      ))}
    </ul>
  );
}
