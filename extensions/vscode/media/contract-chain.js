// Shared, pure relationship resolver. Never substitute unrelated index records.
const route = value => String(value ?? '').replace(/^\{\{[^}]+\}\}/, '').split(/[?#]/)[0].replace(/\/$/, '') || '/';
export function resolveContractChain(project, contract) {
  const source = project.sourceContext ?? {};
  const endpoints = (source.endpoints ?? []).filter(item => contract.sourceArtifactIds?.includes(item.id)
    || (item.method === contract.method && route(item.path) === route(contract.route ?? contract.path)));
  const ids = new Set(endpoints.map(item => item.id));
  const links = (source.integrations ?? []).filter(item => ids.has(item.endpointId));
  const callers = (source.frontendCalls ?? []).filter(item => links.some(link => link.callId === item.id));
  const ref = (item, kind, relationship) => ({ ...item, kind, artifactId: `${kind}:${item.id}`, relationship });
  const groups = [
    { title: 'Upstream · callers & frontend files', items: callers.map(item => ref(item, 'consumer', 'Indexed CALLS relationship')) },
    { title: 'Frontend components & pages', items: (source.artifacts ?? []).filter(item => ['component', 'page'].includes(item.kind) && callers.some(call => call.source === item.source && call.root === item.root)).map(item => ref(item, item.kind, 'Same-file candidate · not a confirmed call edge')) },
    { title: 'Route & handler', items: endpoints.map(item => ref(item, 'endpoint', 'Indexed route declaration')) },
    ...[['schema', 'Downstream · schemas'], ['model', 'Downstream · database models'], ['test', 'Downstream · tests']].map(([kind, title]) => ({ title, items: (kind === 'schema' ? source.schemas ?? [] : (source.artifacts ?? []).filter(item => item.kind === kind)).filter(item => ids.has(item.endpointId) || endpoints.some(endpoint => (endpoint[`${kind}Ids`] ?? []).includes(item.id))).map(item => ref(item, kind, 'Explicit index relationship')) }))
  ];
  return groups;
}
