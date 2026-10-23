// Deterministic three-service fixture. No real credentials or external traffic.
export function commerceState() {
  const project = (id, name, root, artifact) => ({
    id, name, requests: [], tasks: [], contracts: [], contextPacks: [],
    activeEnvironmentId: "development",
    environments: [{ id: "development", name: "Development", variables: [{ key: "baseUrl", value: "http://127.0.0.1:3000", enabled: true }] }],
    sourceContext: { roots: [{ kind: "workspace", path: root }], scanStatus: "complete", lastScannedAt: "2026-10-18T00:00:00.000Z", artifacts: artifact ? [artifact] : [], endpoints: [], frontendCalls: [], schemas: [], integrations: [], git: [] }
  });
  const frontend = project("storefront", "Storefront", "/fixture/storefront", { id: "checkout", name: "Checkout page", kind: "page", source: "app/checkout/page.tsx", root: "/fixture/storefront", route: "/checkout", line: 1 });
  const orders = project("orders", "Orders service", "/fixture/orders", { id: "checkout", name: "Checkout handler", kind: "component", source: "src/checkout.ts", root: "/fixture/orders", line: 1 });
  const payments = project("payments", "Payment simulator", "/fixture/payments");
  for (const owner of [orders, payments]) {
    owner.contracts = [{ id: "checkout-contract", method: "POST", route: "/checkout", serviceId: owner.id, sourceArtifactIds: [], sourceRequestIds: ["checkout-request"] }];
    owner.requests = [{ id: "checkout-request", name: "Create checkout", method: "POST", url: "{{baseUrl}}/checkout", contractId: "checkout-contract", serviceId: owner.id, headers: [], params: [], auth: { type: "none" }, body: { type: "json", content: "{}" }, assertions: [{ type: "status", equals: 201 }] }];
  }
  payments.environments[0].services = [{ id: "payment-provider", name: "Payment provider", variableKey: "payments", baseUrl: "http://127.0.0.1:3001", targetType: "external" }];
  return { version: 2, revision: 0, projects: [frontend, orders, payments], activeProjectId: "storefront", history: [], handoffs: [], timeline: [] };
}
