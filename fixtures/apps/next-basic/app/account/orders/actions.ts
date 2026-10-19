'use server';

import { revalidatePath } from 'next/cache';
import { API_URL } from '@/lib/config';

export async function cancelOrder(orderId: string) {
  await fetch(`${API_URL}/orders/${orderId}`, { method: 'DELETE' });
  revalidatePath('/account/orders');
}
