#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { astFrontendPayload, astRouteInfo } from "../packages/contract-engine/ast-index.mjs";
import { traceNextRoute, validatePayloadAgainstTrace } from "../packages/contract-engine/index.mjs";
import { discoverRouteHandlers, findRouteHandler, routeAdapterNames } from "../packages/contract-engine/route-adapters.mjs";
import { parseCapturedBody, redactCapturedQuery, redactCapturedUrl } from "../packages/local-observer/index.mjs";
import { checkBlastRadius, FileRegistry } from "../packages/remote-registry/index.mjs";
import { anonymizeFixtureData, diffObservedContract, generateFixtureContent } from "../packages/core/index.mjs";
import { normalizeOtelTraces, summarizeOtelBatch } from "../packages/local-observer/otel.mjs";
import { incrementalSourceIndex } from "../packages/contract-engine/incremental-index.mjs";
import { validationForHandler } from "../packages/contract-engine/validation-adapters.mjs";

const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), "aipi-regression-"));

try {
  const arrowHandler = `
    import { z } from "zod";
    const createOrder = z.object({
      email: z.string().email().min(6),
      quantity: z.number().int().gte(1).lte(20)
    }).strict();
    export const POST = async (request: Request) => Response.json(createOrder.parse(await request.json()));
  `;
  const astRoute = astRouteInfo({ file: "route.ts", text: arrowHandler, method: "POST" });
  assert.equal(astRoute.handler?.export, "POST");
  assert.equal(astRoute.schemas[0].additionalProperties, false);
  assert.equal(astRoute.schemas[0].fields[1].type, "integer");

  const frontend = `
    export async function createOrder(email: string, quantity: number) {
      const payload = { email, quantity };
      return fetch("/api/orders", { method: "POST", body: JSON.stringify(payload) });
    }
  `;
  const frontendPayload = astFrontendPayload({ file: "orders.ts", text: frontend, backendRoute: "/api/orders", method: "POST" });
  assert.deepEqual(frontendPayload.fields.map(({ name, type }) => ({ name, type })), [
    { name: "email", type: "string" },
    { name: "quantity", type: "number" },
  ]);

  const tracedValidation = {
    validation: astRoute.schemas[0],
  };
  const invalid = validatePayloadAgainstTrace(tracedValidation, { email: "a@b", quantity: 0, ignored: true });
  assert.equal(invalid.checked, true);
  assert.equal(invalid.valid, false);
  assert.equal(invalid.errors.some((error) => error.keyword === "format"), true);
  assert.equal(invalid.errors.some((error) => error.keyword === "minimum"), true);
  assert.equal(invalid.errors.some((error) => error.keyword === "additionalProperties"), true);

  const nodeServer = `
    import http from "node:http";
    http.createServer((request, response) => {
      const url = new URL(request.url, "http://localhost");
      if (request.method === "GET" && url.pathname === "/api/health") {
        response.end(JSON.stringify({ ok: true }));
      }
    });
  `;
  await fs.writeFile(path.join(temporaryRoot, "server.mjs"), nodeServer);
  const nodeTrace = await traceNextRoute({ root: temporaryRoot, url: "/api/health", method: "GET" });
  assert.equal(nodeTrace.stack, "Node HTTP");
  assert.equal(nodeTrace.handler?.file, "server.mjs");

  const adapterFixtures = [
    { file: "express.ts", text: 'import express from "express"; const app = express(); app.post("/api/orders/:id", handler);', framework: "Express", url: "/api/orders/42", method: "POST" },
    { file: "hono.ts", text: 'import { Hono } from "hono"; const app = new Hono(); app.get("/api/orders/:id", handler);', framework: "Hono", url: "/api/orders/42", method: "GET" },
    { file: "fastify.ts", text: 'import Fastify from "fastify"; const fastify = Fastify(); fastify.route({ method: "PATCH", url: "/api/orders/:id", handler });', framework: "Fastify", url: "/api/orders/42", method: "PATCH" },
    { file: "api.py", text: '@app.delete("/api/orders/{order_id}")\nasync def delete_order(order_id: str): pass', framework: "FastAPI", url: "/api/orders/42", method: "DELETE" },
  ];
  for (const fixture of adapterFixtures) {
    const found = findRouteHandler({ ...fixture });
    assert.equal(found?.framework, fixture.framework);
    assert.equal(discoverRouteHandlers(fixture).length, 1);
  }
  assert.deepEqual(routeAdapterNames, ["next-app-router", "supabase-edge", "express", "fastify", "hono", "fastapi", "node-http"]);

  const fastifyText = `
    import Fastify from "fastify";
    const app = Fastify();
    app.route({ method: "POST", url: "/orders", schema: { body: { type: "object", additionalProperties: false, required: ["customerId"], properties: { customerId: { type: "string", format: "uuid" }, note: { type: "string" } } } }, handler });
  `;
  const fastifyHandler = findRouteHandler({ file: "orders.ts", text: fastifyText, url: "/orders", method: "POST" });
  const fastifySchema = validationForHandler({ text: fastifyText, handler: fastifyHandler });
  assert.equal(fastifySchema.kind, "json-schema");
  assert.deepEqual(fastifySchema.fields.map(({ name, type, required }) => ({ name, type, required })), [
    { name: "customerId", type: "uuid", required: true },
    { name: "note", type: "string", required: false },
  ]);

  const fastApiText = `
from pydantic import BaseModel
from uuid import UUID
class OrderInput(BaseModel):
    customer_id: UUID
    quantity: int
    note: str | None = None

@app.post("/orders")
async def create_order(payload: OrderInput):
    return payload
  `;
  const fastApiHandler = findRouteHandler({ file: "api.py", text: fastApiText, url: "/orders", method: "POST" });
  const fastApiSchema = validationForHandler({ text: fastApiText, handler: fastApiHandler });
  assert.equal(fastApiSchema.kind, "pydantic");
  assert.equal(fastApiSchema.fields.find((field) => field.name === "customer_id").type, "uuid");
  assert.equal(fastApiSchema.fields.find((field) => field.name === "note").required, false);

  const incrementalRoot = path.join(temporaryRoot, "incremental");
  await fs.mkdir(incrementalRoot);
  const incrementalFile = path.join(incrementalRoot, "route.ts");
  await fs.writeFile(incrementalFile, "export const GET = () => null;\n");
  let parses = 0;
  const detect = (_file, text) => { parses += 1; return { length: text.length }; };
  const firstIndex = await incrementalSourceIndex({ root: incrementalRoot, files: [incrementalFile], detect });
  const secondIndex = await incrementalSourceIndex({ root: incrementalRoot, files: [incrementalFile], detect });
  assert.equal(firstIndex.metrics.parsed, 1);
  assert.equal(secondIndex.metrics.cacheHits, 1);
  assert.equal(parses, 1);

  const redactedUrl = redactCapturedUrl("http://localhost/api/orders?token=secret&view=summary");
  assert.match(redactedUrl, /token=%5BREDACTED%5D/);
  assert.match(redactedUrl, /view=summary/);
  assert.deepEqual(redactCapturedQuery({ password: "secret", page: "2" }), { password: "[REDACTED]", page: "2" });
  assert.deepEqual(parseCapturedBody(Buffer.from("email=test%40example.com&password=secret"), "application/x-www-form-urlencoded"), {
    email: "test@example.com",
    password: "[REDACTED]",
  });
  assert.match(parseCapturedBody(Buffer.from("binary"), "application/octet-stream"), /BINARY BODY OMITTED/);

  const privatePayload = {
    id: "550e8400-e29b-41d4-a716-446655440000",
    name: "Ada Lovelace",
    email: "ada@example.com",
    phone: "+44 1234 567890",
    address: "12 Private Road",
    status: "active",
    nested: { userId: 42, password: "must-not-leak" },
  };
  const anonymized = anonymizeFixtureData(privatePayload);
  assert.equal(anonymized.value.email, "user@example.test");
  assert.equal(anonymized.value.name, "Example User");
  assert.equal(anonymized.value.id, "00000000-0000-4000-8000-000000000001");
  assert.equal(anonymized.value.nested.userId, 1001);
  assert.equal(anonymized.value.nested.password, "[REDACTED]");
  assert.equal(anonymized.value.status, "active");
  const fixture = generateFixtureContent(privatePayload, { preserveFields: ["name"] });
  assert.match(fixture.content, /Ada Lovelace/);
  assert.doesNotMatch(fixture.content, /ada@example\.com|12 Private Road|must-not-leak/);
  assert.equal(fixture.privacy.anonymized, true);
  const unrelatedSchema = [{ name: "users", source: "schema.sql", columns: [{ name: "id", type: "uuid", nullable: false }] }];
  assert.equal(diffObservedContract({ id: "550e8400-e29b-41d4-a716-446655440000", name: "Ada" }, unrelatedSchema, "/items").status, "unverified");
  assert.equal(diffObservedContract({ id: "550e8400-e29b-41d4-a716-446655440000", name: "Ada" }, unrelatedSchema, "/items", { minimumConfidence: 0 }).status, "drift");

  const otelSpans = normalizeOtelTraces({ resourceSpans: [{ resource: { attributes: [{ key: "service.name", value: { stringValue: "orders-api" } }] }, scopeSpans: [{ spans: [{ traceId: "trace-1", spanId: "span-1", name: "POST /api/orders", startTimeUnixNano: "1000000", endTimeUnixNano: "7000000", status: { code: 2 }, attributes: [
    { key: "http.request.method", value: { stringValue: "POST" } },
    { key: "http.route", value: { stringValue: "/api/orders/:id" } },
    { key: "http.response.status_code", value: { intValue: "500" } },
    { key: "code.file.path", value: { stringValue: "src/orders.ts" } },
    { key: "code.line.number", value: { intValue: "42" } },
    { key: "db.system.name", value: { stringValue: "postgresql" } },
    { key: "db.statement", value: { stringValue: "select * from customers where email = 'private@example.com'" } },
    { key: "authorization", value: { stringValue: "Bearer secret" } },
  ] }] }] }] });
  assert.equal(otelSpans[0].route, "/api/orders/:param");
  assert.equal(otelSpans[0].durationMs, 6);
  assert.equal(otelSpans[0].code.line, 42);
  assert.equal(otelSpans[0].database.system, "postgresql");
  assert.equal(JSON.stringify(otelSpans).includes("private@example.com"), false);
  assert.deepEqual(summarizeOtelBatch(otelSpans), { spans: 1, routes: ["POST /api/orders/:param"], failures: 1, services: ["orders-api"] });

  const emptyRegistry = new FileRegistry(path.join(temporaryRoot, "registry.json"));
  const unknownBlastRadius = await checkBlastRadius(emptyRegistry, {
    organizationId: "org_test",
    repository: "orders-api",
    method: "POST",
    route: "/api/orders",
    schema: { fields: [{ name: "id", type: "uuid", required: true }] },
  });
  assert.equal(unknownBlastRadius.status, "unverified");
  assert.equal(unknownBlastRadius.safe, null);
  assert.equal(unknownBlastRadius.baseline, null);
  const firstVersion = await emptyRegistry.upsert({ organizationId: "org_test", repository: "orders-api", method: "POST", route: "/api/orders", revision: "commit-1", schema: { fields: [{ name: "id", type: "uuid", required: true }] } });
  const secondVersion = await emptyRegistry.upsert({ organizationId: "org_test", repository: "orders-api", method: "POST", route: "/api/orders", revision: "commit-2", schema: { fields: [{ name: "id", type: "uuid", required: true }, { name: "status", type: "string", required: true }] } });
  assert.notEqual(firstVersion.versionId, secondVersion.versionId);
  assert.equal((await emptyRegistry.list("org_test"))[0].revision, "commit-2");
  assert.equal((await emptyRegistry.listVersions({ organizationId: "org_test", repository: "orders-api" })).length, 2);
  assert.equal((await emptyRegistry.listAudit("org_test")).length, 2);

  console.log("AIPI port-free regression test passed");
} finally {
  await fs.rm(temporaryRoot, { recursive: true, force: true });
}
