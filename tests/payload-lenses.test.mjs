import assert from "node:assert/strict";
import { extractBase64TextFields, extractJwtTokens } from "../ui/payload-lenses.js";

const encode = (value) => Buffer.from(value, "utf8").toString("base64url");
const jwt = `${encode(JSON.stringify({ alg: "HS256", typ: "JWT" }))}.${encode(JSON.stringify({ sub: "usr_99a", role: "admin", exp: 1900000000 }))}.c2lnbmF0dXJl`;

assert.deepEqual(extractJwtTokens({ authorization: jwt, nested: { ordinary: "not.a.jwt" } }), [
  {
    path: "$.authorization",
    header: { alg: "HS256", typ: "JWT" },
    claims: { sub: "usr_99a", role: "admin", exp: 1900000000 }
  }
]);

assert.deepEqual(extractBase64TextFields({ opaque: encode("AIPI pipeline payload") }), [
  { path: "$.opaque", decoded: "AIPI pipeline payload", truncated: false }
]);
assert.deepEqual(extractBase64TextFields({ binary: "AAECAwQFBgcICQoLDA0ODw==" }), []);
assert.deepEqual(extractJwtTokens({ token: `${encode("{}")}.${encode("{}")}.sig` }), [
  { path: "$.token", header: {}, claims: {} }
]);
assert.equal(extractBase64TextFields(Object.fromEntries(Array.from({ length: 30 }, (_, index) => [`field${index}`, encode(`field-${index}-with-enough-utf8-text`)]))).length, 20);

console.log("AIPI payload lens tests passed");
