import test from "node:test";
import assert from "node:assert/strict";

test("POST /api/send", async () => {
  const response = await fetch("http://localhost:3000/api/send", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({})
  });
  assert.equal(response.status, 201);
});
