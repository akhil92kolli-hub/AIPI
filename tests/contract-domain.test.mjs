import assert from "node:assert/strict";
import { breakingChangeForConsumer, contractChanges, displayRoute, normalizeContract, normalizeRepository, normalizeRoute } from "../packages/contract-domain/index.js";

const field = (name, type = "string", required = true) => ({ name, type, required });
const changes = (before, after, direction = "request") => contractChanges(
  { direction, schema: { direction, fields: before } },
  { direction, schema: { direction, fields: after } },
);

const cases = [
  { name: "request required add breaks even without an expectation", before: [], after: [field("tenantId")], expected: undefined, breaks: true },
  { name: "request optional add is safe", before: [], after: [field("note", "string", false)], expected: undefined, breaks: false },
  { name: "request required to optional is safe", before: [field("id")], after: [field("id", "string", false)], expected: field("id"), breaks: false },
  { name: "request optional to required breaks optional consumers", before: [field("id", "string", false)], after: [field("id")], expected: field("id", "string", false), breaks: true },
  { name: "request optional to required is safe for already-required consumers", before: [field("id", "string", false)], after: [field("id")], expected: field("id"), breaks: false },
  { name: "request removal breaks consumers that send the field", before: [field("id")], after: [], expected: field("id"), breaks: true },
  { name: "request type change breaks consumers that send the field", before: [field("id")], after: [field("id", "number")], expected: field("id"), breaks: true },
  { name: "response required to optional breaks consumers requiring it", direction: "response", before: [field("id")], after: [field("id", "string", false)], expected: field("id"), breaks: true },
  { name: "response optional to required is safe", direction: "response", before: [field("id", "string", false)], after: [field("id")], expected: field("id", "string", false), breaks: false },
];

for (const test of cases) {
  const [change] = changes(test.before, test.after, test.direction);
  assert.equal(breakingChangeForConsumer(change, test.expected), test.breaks, test.name);
}

assert.equal(displayRoute("%7B%7BbaseUrl%7D%7D%2Fusers%2F%7Bid%7D?expand=1"), "/users/{id}");
assert.equal(normalizeRoute("https://api.example.test/users/[userId]"), "/users/:param");
assert.equal(normalizeRepository("git@GitHub.com:Acme/API.git"), "github.com/acme/api");
assert.equal(normalizeRepository("https://github.com/Acme/API.git"), "github.com/acme/api");
assert.throws(() => normalizeContract({ organizationId: "org", repository: "repo", method: "GET", route: "/x", schema: { fields: [field("id"), field("id")] } }), /Duplicate schema field/);

console.log("contract domain tests passed");
