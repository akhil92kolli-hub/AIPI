import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { nodeHttpRoutes, httpCalls } from '../packages/contract-engine/http-source.mjs';
import { buildIntegrations, detectFromFile } from '../scripts/dashboard-server.mjs';

const server = String.raw`import http from 'node:http';
http.createServer((req, res) => {
 const url = new URL(req.url, 'http://localhost');
 if(req.method === 'OPTIONS') return res.end();
 if(req.method === 'GET' && url.pathname === '/launch') res.end();
 if(req.method === 'POST' && url.pathname === '/initialize') res.end();
 const task = url.pathname.match(/^\/api\/projects\/([^/]+)\/tasks\/search-context$/);
 if (req.method === 'POST' && task) res.end();
 const unsupported = url.pathname.match(/^\/api\/(foo|bar)$/);
 if(req.method === 'GET' && unsupported) res.end();
 if(req.method === 'GET' || url.pathname === '/not-a-route') res.end();
 if(location.pathname === '/dashboard') res.end();
});`;
assert.deepEqual(nodeHttpRoutes('server.mjs', server).map(r => [r.method, r.route]), [
 ['GET', '/launch'], ['POST', '/initialize'], ['POST', '/api/projects/:param/tasks/search-context']
]);
assert.deepEqual(nodeHttpRoutes('ui.js', "if(location.pathname === '/dashboard') render();"), []);
assert.deepEqual(nodeHttpRoutes('fake.js', "const http = {}; http.createServer((req) => { const url = new URL(req.url); if(req.method === 'POST' && url.pathname === '/fake') {} });"), []);

const client = [String.raw`
async function transport(path, options = {}) { return fetch(path, {headers: {}, ...options}); }
async function api(path, options = {}) { return transport(path, options); }
api('/initialize', {method: 'POST'});
api('/launch');
api('/unknown', {method: operation});
api('/override', {method: 'POST', ...options});
api('/explicit', {...options, method: 'PUT'});
api('/dynamic/' + id);
`, "api(`/api/projects/${encodeURIComponent(id)}/tasks/search-context`, {method: 'POST'});", 'api(`/api/${resource}`);', String.raw`
function other(api) { api('/not-http'); }
// fetch('/comment');
const example = "fetch('/string')";
function local(fetch) { fetch('/shadowed'); }
`].join('\n');
const calls = httpCalls('client.js', client);
assert.deepEqual(calls.map(c => c.path), ['/initialize', '/launch', '/explicit', '/api/projects/${encodeURIComponent(id)}/tasks/search-context', '/api/${resource}']);
assert.equal(calls[3].routePattern, '/api/projects/:param/tasks/search-context');
assert.equal(calls[4].resolution, 'dynamic-template');
assert.ok(calls.every(call => call.endLine >= call.line && call.rangeMethod === 'typescript-ast'));
const endpoints = nodeHttpRoutes('server.mjs', server).map((r, i) => ({...r, id: `ep${i}`, path:r.route}));
const links = buildIntegrations(endpoints, calls.map((c,i) => ({...c,id:`call${i}`})));
assert.equal(links[0].status, 'healthy');
assert.equal(links[3].status, 'candidate-link');
assert.equal(links[3].confirmationState, 'inferred');
assert.equal(links[4].endpointId, null);
assert.equal(buildIntegrations([...endpoints, {...endpoints[0],id:'duplicate'}], [{...calls[1],id:'ambiguous'}])[0].endpointId, null);
assert.equal(buildIntegrations(endpoints, [{id:'external',method:'GET',path:'https://external.test/launch',resolution:'literal'}])[0].endpointId, null);

const app = await fs.readFile(new URL('../ui/app.js', import.meta.url), 'utf8');
const backend = await fs.readFile(new URL('../scripts/dashboard-server.mjs', import.meta.url), 'utf8');
const found = httpCalls('ui/app.js', app), routes = nodeHttpRoutes('scripts/dashboard-server.mjs', backend);
assert.equal(nodeHttpRoutes('ui/app.js', app).length, 0);
assert.equal(routes.find(r => r.route === '/launch').method, 'GET');
assert.equal(routes.find(r => r.route === '/api/vault/initialize').method, 'POST');
for (const route of ['/api/send', '/api/vault/initialize']) assert.ok(found.some(c => c.path === route && c.method === 'POST'));
assert.ok(found.some(c => c.routePattern === '/api/projects/:param/tasks/search-context'));
assert.ok(routes.some(r => r.route === '/api/projects/:param/tasks/search-context'));
assert.equal(detectFromFile('/repo/ui.js', '/repo', "const sample = `fetch('/example')`;").frontendCalls.length, 0);
const fastapi = detectFromFile('/repo/app.py', '/repo', "@app.get('/orders')\ndef orders():\n    return {'total': 1}\n\n@app.get('/health')\ndef health():\n    return {'ok': True}\n");
assert.deepEqual(fastapi.endpoints.map(entry => [entry.path, entry.line, entry.endLine]),
  [['/orders', 1, 3], ['/health', 5, 7]]);
assert.ok(fastapi.endpoints.every(entry => entry.rangeMethod === 'python-indentation-heuristic'));
const next = detectFromFile('/repo/app/api/orders/route.ts', '/repo',
  "export async function GET() {\n  return Response.json({ total: 100 });\n}\n");
assert.deepEqual(next.endpoints.map(entry => [entry.path, entry.line, entry.endLine, entry.rangeMethod]),
  [['/api/orders', 1, 3, 'typescript-ast']]);
console.log('HTTP source: real AIPI routes/wrappers, parameter candidates, ambiguity and false-positive cases passed');
