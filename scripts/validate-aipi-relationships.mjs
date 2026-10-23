// Read-only baseline: uses the same detector as source indexing, without writing index/state.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { detectFromFile, buildIntegrations } from './dashboard-server.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const endpoints = [], calls = [];
for (const file of ['ui/app.js', 'ui/workspace-explorer.js', 'scripts/dashboard-server.mjs']) {
  const result = detectFromFile(path.join(root, file), root, await fs.readFile(path.join(root, file), 'utf8'));
  endpoints.push(...result.endpoints);
  calls.push(...result.frontendCalls);
  console.log(JSON.stringify({ file, endpoints: result.endpoints.map(e => ({ method: e.method, path: e.path, line: e.line })), calls: result.frontendCalls.map(c => ({ method: c.method, path: c.path, line: c.line })) }));
}
const relationships = buildIntegrations(endpoints, calls);
console.log(JSON.stringify({ linkedRelationships: relationships.filter(e => e.endpointId && e.callId).length,
  candidateLinks: relationships.filter(e => e.status === 'candidate-link').length,
  linkedHandlers: new Set(relationships.filter(e => e.endpointId && e.callId).map(e => e.endpointId)).size,
  unresolvedCallers: relationships.filter(e => e.callId && !e.endpointId).length }));
