type Order = { id: string; total: number; currency: string };
export async function submitCheckout(sku: string, quantity: number): Promise<string> {
  const response = await fetch('/api/orders', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sku, quantity }),
  });
  if (!response.ok) throw new Error(`Checkout failed: ${response.status}`);
  const order = await response.json() as Order;
  return `${order.currency} ${order.total.toFixed(2)}`;
}
