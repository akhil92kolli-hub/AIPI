#!/usr/bin/env node

import path from "node:path";
import { diffFrontendBackend, traceNextRoute } from "../packages/contract-engine/index.mjs";
import { checkBlastRadius, FileRegistry } from "../packages/remote-registry/index.mjs";

const root = path.resolve("fixtures/next-contract-mismatch");
const registry = new FileRegistry(path.resolve(".api-forge/tmp/demo-registry.json"));

const trace = await traceNextRoute({ root, url: "/api/users", method: "POST" });
const contractDiff = await diffFrontendBackend({
  root,
  frontendFile: "src/create-user.ts",
  backendRoute: "/api/users",
  method: "POST",
});

await registry.upsert({
  organizationId: "demo-org",
  repository: "payments-api",
  method: "POST",
  route: "/api/users",
  revision: "main@demo",
  schema: { fields: [{ name: "customerId", type: "uuid", required: true }] },
  consumers: [
    { repository: "ios-app-repo", file: "Sources/Checkout.swift", line: 42, fields: [{ name: "customerId", type: "uuid", required: true }] },
    { repository: "billing-dashboard-repo", file: "src/api/customers.ts", line: 18, fields: [{ name: "customerId", type: "uuid", required: true }] },
  ],
});

const blastRadius = await checkBlastRadius(registry, {
  organizationId: "demo-org",
  repository: "payments-api",
  method: "POST",
  route: "/api/users",
  revision: "proposed",
  schema: { fields: [{ name: "customerId", type: "number", required: true }] },
});

process.stdout.write(`${JSON.stringify({
  story: "AIPI traced a route, found a local contract mismatch, and identified remote consumers before a breaking change.",
  trace,
  localContractDiff: contractDiff.mismatches,
  crossRepositoryBlastRadius: blastRadius,
}, null, 2)}\n`);
