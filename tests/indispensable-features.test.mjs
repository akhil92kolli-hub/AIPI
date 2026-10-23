import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { generateNodeTestSource, generatePytestSource } from "../packages/test-generators/index.mjs";
import { readTraffic, startTrafficProxy } from "../packages/local-observer/index.mjs";

const request = { name: "POST /api/users", method: "POST", url: "{{baseUrl}}/api/users", body: { content: '{"email":"developer@example.com"}' }, assertions: [{ type: "status", equals: 201 }] };
assert.match(generateNodeTestSource({ request }), /node:test/);
assert.match(generateNodeTestSource({ request }), /assert\.equal\(response\.status, 201\)/);
assert.match(generatePytestSource({ request }), /requests\.request\("POST"/);
assert.match(generatePytestSource({ request }), /assert response\.status_code == 201/);

const root = await fs.mkdtemp(path.join(os.tmpdir(), "aipi-auth-capture-"));
const upstream = http.createServer((_request, response) => { response.writeHead(200, { "content-type": "application/json" }); response.end('{"ok":true}'); });
await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
let captured;
const proxy = await startTrafficProxy({ target: `http://127.0.0.1:${upstream.address().port}`, root, port: 0, onRequestAuth: (headers) => { captured = headers; } });
await fetch(`${proxy.url}/private`, { headers: { authorization: "Bearer local-test-secret", cookie: "session=private" } });
await new Promise((resolve) => setTimeout(resolve, 50));
assert.equal(captured.authorization, "Bearer local-test-secret");
assert.equal(captured.cookie, "session=private");
const [record] = await readTraffic(root);
assert.equal(record.request.headers.authorization, "[REDACTED]");
assert.equal(record.request.headers.cookie, "[REDACTED]");
await proxy.close();
await new Promise((resolve) => upstream.close(resolve));

const app = await fs.readFile(new URL("../ui/app.js", import.meta.url), "utf8");
const styles = await fs.readFile(new URL("../ui/styles.css", import.meta.url), "utf8");
const server = await fs.readFile(new URL("../scripts/dashboard-server.mjs", import.meta.url), "utf8");
assert.match(app, /\["project", "Home", "home-project"\]/);
assert.match(app, /\["tools", "Tools", "nav-tools"\]/);
assert.match(app, /<h1>Tools<\/h1>/);
assert.match(styles, /body\[data-aipi-channel="aipi\.ide\.v1"\] \.mobile-header,[\s\S]{0,180}width:100%!important/);
assert.match(app, /Generate &amp; Run Test/);
assert.match(app, /Actual · caller sent/);
assert.match(app, /MUST call the verify_contract_revision MCP tool/);
assert.match(app, /id="authCaptureButton"/);
assert.match(app, /OAuth 2\.0 \(Client credentials\)/);
assert.match(app, /id="oauthTokenUrl"/);
assert.match(app, /function contextGenerationMarkup\(generation, currentContextPackId\)/);
assert.match(app, /Saved generations[\s\S]{0,160}versions/);
assert.match(app, /Generation \$\{esc\(generation\.generation \?\? "\?"\)\}/);
assert.match(app, /Freshness: \$\{esc\(freshness\)\}/);
assert.match(app, /Superseded by <code/);
assert.match(styles, /\.context-generation-history>\.context-generation-row/);
assert.match(styles, /\.context-generation-identity>code\{overflow-wrap:anywhere/);
assert.match(styles, /\.configuration-list \.kv-row \[data-kv-value\]/);
assert.match(server, /watchFileSystem/);
assert.match(server, /STATE_CHANGE_APPROVAL_REQUIRED/);
assert.match(server, /AIPI_CAPTURED_AUTHORIZATION/);

const { executeSaved } = await import("../scripts/dashboard-server.mjs");
const oauthProject = {
  id: "oauth-project",
  activeEnvironmentId: "dev",
  environments: [{ id: "dev", variables: [{ key: "oauth-secret", value: "local-client-secret", secret: true, enabled: true }] }]
};
const oauthRequest = {
  id: "oauth-request",
  name: "OAuth-protected resource",
  method: "GET",
  url: "https://api.example.test/private",
  headers: [],
  params: [],
  auth: { type: "oauth", tokenUrl: "https://identity.example.test/token", clientId: "client:id", clientSecretRef: "oauth-secret", scope: "read:items", audience: "https://api.example.test" },
  body: { type: "json", content: "" }
};
const calls = [];
const oauthResult = await executeSaved(async (input) => {
  calls.push(input);
  if (input.name === "OAuth token request") {
    assert.equal(input.method, "POST");
    assert.equal(input.body.grant_type, "client_credentials");
    assert.equal(input.body.client_secret, "local-client-secret");
    assert.equal(input.body.scope, "read:items");
    assert.equal(input.body.audience, "https://api.example.test");
    assert.equal(input.timeout_ms, 15000);
    return { status: 200, ok: true, body: '{"access_token":"short-lived-token","token_type":"Bearer"}', json: { access_token: "short-lived-token", token_type: "Bearer" } };
  }
  assert.equal(input.headers.authorization, "Bearer short-lived-token");
  return { status: 200, ok: true, passed: true, headers: {}, body: "{}", json: {} };
}, oauthProject, oauthRequest);
assert.equal(oauthResult.status, 200);
assert.equal(calls.length, 2, "one token request precedes the protected resource request");
assert.ok(!JSON.stringify(oauthResult).includes("local-client-secret"));
assert.ok(!JSON.stringify(oauthResult).includes("short-lived-token"));

const basicOAuthRequest = { ...oauthRequest, auth: { ...oauthRequest.auth, clientAuthMethod: "basic" } };
await executeSaved(async (input) => {
  if (input.name === "OAuth token request") {
    assert.equal(input.body.client_secret, undefined, "Basic auth does not duplicate the secret in the form body");
    const decoded = Buffer.from(input.headers.authorization.slice("Basic ".length), "base64").toString();
    assert.equal(decoded, "client%3Aid:local-client-secret", "Basic credentials are form-encoded before base64 encoding");
    return { status: 200, ok: true, json: { access_token: "another-short-lived-token", token_type: "Bearer" }, body: "{}" };
  }
  assert.equal(input.headers.authorization, "Bearer another-short-lived-token");
  return { status: 200, ok: true, passed: true, headers: {}, body: "{}", json: {} };
}, oauthProject, basicOAuthRequest);

let insecureTokenRequestCalls = 0;
const insecureOAuthResult = await executeSaved(async () => { insecureTokenRequestCalls += 1; }, oauthProject, {
  ...oauthRequest,
  auth: { ...oauthRequest.auth, tokenUrl: "http://identity.example.test/token" }
});
assert.equal(insecureTokenRequestCalls, 0, "insecure token endpoints are rejected before making a network request");
assert.match(insecureOAuthResult.error, /HTTPS/);
assert.ok(!JSON.stringify(insecureOAuthResult).includes("local-client-secret"));

console.log("Indispensable workflow generation, auth redaction, diff UI, watcher and loop-closure checks passed");
