"use client";

export function CheckoutForm() {
  async function checkout() {
    const response = await fetch("/checkout", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ amount: 20 }) });
    // Deliberate pilot failure: payment errors are not presented to the customer.
    return response.json();
  }
  return <button onClick={checkout}>Pay</button>;
}
