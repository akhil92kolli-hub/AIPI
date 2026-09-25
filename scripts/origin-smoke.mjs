import assert from "node:assert/strict";

process.env.AIPI_PORT = "0";
process.env.AIPI_MAX_PORT = "0";
process.env.AIPI_TOKEN = "cors-smoke-token";
process.env.AIPI_APP_ORIGIN = "https://legacy-dashboard.example";

const { startDashboard } = await import("../scripts/dashboard-server.mjs");
const dashboard = await startDashboard();
try {
  for (const origin of ["https://aipi.website", "https://www.aipi.website", "https://legacy-dashboard.example"]) {
    const preflight = await fetch(`${dashboard.url}/api/state`, {
      method: "OPTIONS",
      headers: {
        origin,
        "access-control-request-method": "GET",
        "access-control-request-headers": "authorization",
        "access-control-request-private-network": "true",
      },
    });
    assert.equal(preflight.status, 204);
    assert.equal(preflight.headers.get("access-control-allow-origin"), origin);
    assert.equal(preflight.headers.get("access-control-allow-private-network"), "true");
  }

  const rejected = await fetch(`${dashboard.url}/api/connection`, { headers: { origin: "https://untrusted.example" } });
  assert.equal(rejected.status, 403);

  const connection = await fetch(`${dashboard.url}/api/connection`, {
    headers: { origin: "https://www.aipi.website", authorization: "Bearer cors-smoke-token" },
  });
  assert.equal(connection.status, 200);
  assert.equal(connection.headers.get("access-control-allow-origin"), "https://www.aipi.website");
  console.log("Origin smoke passed: production dashboard origins, additive custom origin, private-network preflight, authenticated handshake, and untrusted-origin rejection.");
} finally {
  await new Promise((resolve, reject) => dashboard.server.close((error) => error ? reject(error) : resolve()));
}
