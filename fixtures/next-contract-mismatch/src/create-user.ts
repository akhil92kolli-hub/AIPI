export async function createUser(customerId: number) {
  return fetch("/api/users", { method: "POST", body: JSON.stringify({ customerId }) });
}
