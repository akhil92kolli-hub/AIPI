export function checkout(input: { amount: number }) {
  return input.amount > 0
    ? { status: 201, body: { orderId: "demo-order" } }
    : { status: 422, body: { error: "Amount must be positive" } };
}
