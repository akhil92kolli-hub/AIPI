import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);
const temp = await fs.mkdtemp(path.join(os.tmpdir(), "aipi-handshake-"));
const root = path.join(temp, "sample-project");
const connectionFile = path.join(temp, "daemon.json");
const dataDirectory = path.join(temp, "data");
const token = "handshake-smoke-token";
const env = {
  ...process.env,
  AIPI_CONNECTION_FILE: connectionFile,
  AIPI_DATA: dataDirectory,
  AIPI_PORT: "0",
  AIPI_MAX_PORT: "0",
  AIPI_TOKEN: token,
  AIPI_APP_ORIGIN: "https://legacy-dashboard.example",
};
const cli = path.resolve("scripts/aipi-cli-bundle.mjs");
let dashboard;
let staleDaemon;

try {
  await fs.mkdir(path.join(root, "src"), { recursive: true });
  await fs.writeFile(path.join(root, "package.json"), '{"name":"aipi-handshake-project"}\n');
  await fs.writeFile(path.join(root, "src", "api.ts"), "export function health() { return { ok: true }; }\n");

  Object.assign(process.env, {
    AIPI_DATA: dataDirectory,
    AIPI_PORT: "0",
    AIPI_MAX_PORT: "0",
    AIPI_TOKEN: token,
    AIPI_APP_ORIGIN: "https://legacy-dashboard.example",
  });
  const serverModule = await import("../scripts/dashboard-server.mjs");
  const apiModule = await import("../scripts/api-forge-server.mjs");
  dashboard = await serverModule.startDashboard({
    executeRequest: apiModule.executeRequest,
    callTool: apiModule.callTool,
  });
  apiModule.setAipiRuntime(dashboard);
  await fs.writeFile(connectionFile, `${JSON.stringify({
    version: 1,
    pid: process.pid,
    url: dashboard.url,
    port: dashboard.port,
    token,
    startedAt: new Date().toISOString(),
  })}\n`, { mode: 0o600 });

  await exec(process.execPath, [cli, "init", "--root", root, "--config-only"], { env, timeout: 15000 });
  const { stdout } = await exec(process.execPath, [
    cli, "open", "--root", root, "--app", "https://www.aipi.website/dashboard/", "--no-open",
  ], { env, timeout: 30000 });
  assert.match(stdout, new RegExp(`https://www\\.aipi\\.website/dashboard/#port=${dashboard.port}&token=${token}&project=`));

  const origin = "https://www.aipi.website";
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

  const handshake = await fetch(`${dashboard.url}/api/connection`, {
    headers: { origin, authorization: `Bearer ${token}` },
  });
  assert.equal(handshake.status, 200);
  assert.equal((await handshake.json()).protocolVersion, 2);

  const stateResponse = await fetch(`${dashboard.url}/api/state`, {
    headers: { origin, authorization: `Bearer ${token}` },
  });
  assert.equal(stateResponse.status, 200);
  assert.equal(stateResponse.headers.get("access-control-allow-origin"), origin);
  const state = await stateResponse.json();
  assert.ok(state.projects.some((project) => project.sourceContext?.roots?.some((source) => path.resolve(source.path) === root)));

  const unauthenticated = await fetch(`${dashboard.url}/api/state`, { headers: { origin } });
  assert.equal(unauthenticated.status, 401);
  assert.equal(unauthenticated.headers.get("access-control-allow-origin"), origin);

  staleDaemon = http.createServer((_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ connected: true, port: staleDaemon.address().port, companion: "old" }));
  });
  await new Promise((resolve, reject) => {
    staleDaemon.once("error", reject);
    staleDaemon.listen(0, "127.0.0.1", resolve);
  });
  await fs.writeFile(connectionFile, `${JSON.stringify({
    url: `http://127.0.0.1:${staleDaemon.address().port}`,
    token: "stale-daemon-token",
  })}\n`);
  await assert.rejects(
    exec(process.execPath, [cli, "status"], { env, timeout: 15000 }),
    (error) => error.code === 1 && /"status": "offline"/.test(error.stdout)
  );
  console.log("Handshake smoke passed: real dashboard server, project registration/selection, hosted dashboard launch, PNA/CORS preflight, authenticated local state, rejected unauthenticated state, and stale-daemon rejection.");
} finally {
  if (dashboard) await new Promise((resolve, reject) => dashboard.server.close((error) => error ? reject(error) : resolve()));
  if (staleDaemon) await new Promise((resolve, reject) => staleDaemon.close((error) => error ? reject(error) : resolve()));
  await fs.rm(temp, { recursive: true, force: true });
}
