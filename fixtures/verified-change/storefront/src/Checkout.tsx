import React from 'react';

type Order = { id: string; total: number; currency: string };

export async function loadOrder(baseUrl: string): Promise<Order> {
  const response = await fetch(`${baseUrl}/orders/order-1`);
  if (!response.ok) throw new Error(`Orders request failed: ${response.status}`);
  const order = await response.json() as Order;
  if (typeof order.total !== 'number' || !Number.isFinite(order.total)) {
    throw new Error('Orders total must be numeric');
  }
  return order;
}

export function CheckoutSummary({ order }: { order: Order }) {
  return <strong>Checkout total: {order.currency} {order.total.toFixed(2)}</strong>;
}
