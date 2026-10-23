import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { fileURLToPath } from "node:url";
import { commerceState } from "../fixtures/workspace-commerce/state.mjs";
import { saveWorkspaceGroup } from "../packages/core/workspace-groups.mjs";

const temp = await fs.mkdtemp(path.join(os.tmpdir(), "aipi-mvp-preview-"));
process.env.AIPI_DATA = path.join(temp, "data");
process.env.AIPI_PORT = "0"; process.env.AIPI_MAX_PORT = "0";
const fixtureRoot = fileURLToPath(new URL("../fixtures/workspace-commerce/", import.meta.url));
const state = commerceState();
const services = [];
for (const project of state.projects) {
  const root = path.join(temp, project.id);
  if (project.id !== "payments") await fs.cp(path.join(fixtureRoot, project.id), root, { recursive: true });
  else await fs.mkdir(root, { recursive: true });
  project.sourceContext.roots = [{ kind: "workspace", path: root }];
  for (const artifact of project.sourceContext.artifacts) artifact.root = root;
  if (project.id === "storefront") continue;
  const server = http.createServer(async (request, response) => {
    let raw = "";
    for await (const chunk of request) raw += chunk;
    let input = {};
    try { input = raw ? JSON.parse(raw) : {}; } catch {}
    const valid = Number(input.amount) > 0;
    response.writeHead(request.method === "GET" ? 200 : valid ? 201 : 422, { "content-type": "application/json" });
    response.end(JSON.stringify({ service: project.id, ...(valid ? { orderId: "demo-order" } : { error: "Amount must be positive" }) }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  project.environments[0].variables[0].value = `http://127.0.0.1:${server.address().port}`;
  if (project.environments[0].services) project.environments[0].services[0].baseUrl = project.environments[0].variables[0].value;
  services.push(server);
}
saveWorkspaceGroup(state, { name: "Commerce MVP", projectIds: state.projects.map((project) => project.id) }, "wsg_commerce");
const { mutateState } = await import("./workspace-store.mjs");
await mutateState((current) => { Object.assign(current, state); });
const { executeRequest, callToolWithTelemetry } = await import("./api-forge-server.mjs");
const { startDashboard } = await import("./dashboard-server.mjs");
const dashboard = await startDashboard({ executeRequest, callTool: callToolWithTelemetry });
console.log(`MVP preview: ${dashboard.url}/projects/storefront/explore`);
console.log(`Isolated fixture data: ${temp}`);
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => {
  for (const server of services) server.close();
  dashboard.server.close(() => process.exit(0));
});
