const decodeRoute = (value) => {
  let result = String(value ?? '').trim();
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const decoded = decodeURIComponent(result);
      if (decoded === result) break;
      result = decoded;
    } catch { break; }
  }
  return result;
};

export function displayRoute(value) {
  const decoded = decodeRoute(value).replace(/^https?:\/\/[^/]+/i, '');
  const route = decoded.replace(/^\{\{baseUrl\}\}/i, '').split(/[?#]/)[0] || '/';
  return `/${route}`.replace(/\/{2,}/g, '/').replace(/\/$/, '') || '/';
}

export function normalizeRoute(value) {
  return displayRoute(value)
    .replace(/\{\{[^}]+\}\}/g, ':param')
    .replace(/\$\{[^}]+\}/g, ':param')
    .replace(/\{[^}]+\}/g, ':param')
    .replace(/\[[^\]]+\]/g, ':param')
    .replace(/:[A-Za-z0-9_]+/g, ':param');
}

export function normalizeRepository(value) {
  let repository = String(value ?? '').normalize('NFKC').trim();
  if (!repository) return '';
  repository = repository.replace(/^git@([^:]+):/i, 'https://$1/').replace(/^ssh:\/\/git@/i, 'https://');
  try {
    const url = new URL(repository);
    repository = `${url.hostname}${url.pathname}`;
  } catch {}
  return repository.replace(/\.git$/i, '').replace(/^\/+|\/+$/g, '').replace(/\/{2,}/g, '/').toLocaleLowerCase('en-US');
}

const normalizeField = (field) => ({
  name:String(field?.name ?? '').trim(),
  type:String(field?.type ?? 'unknown').trim().toLowerCase(),
  required:field?.required !== false
});

export function normalizeContract(contract) {
  if (!contract?.organizationId || !contract?.repository || !contract?.route || !contract?.method) throw new Error('organizationId, repository, route, and method are required');
  const direction = contract.direction ?? contract.schema?.direction ?? 'request';
  if (!['request', 'response'].includes(direction)) throw new Error('Contract direction must be request or response');
  const repository = normalizeRepository(contract.repository);
  if (!repository || repository.length > 240) throw new Error('Repository identity must be between 1 and 240 characters');
  const fields = (contract.schema?.fields ?? []).map(normalizeField).filter((field) => field.name);
  const names = new Set();
  for (const field of fields) {
    if (names.has(field.name)) throw new Error(`Duplicate schema field: ${field.name}`);
    names.add(field.name);
  }
  return {
    organizationId:String(contract.organizationId),
    repository,
    method:String(contract.method).toUpperCase(),
    route:normalizeRoute(contract.route),
    direction,
    revision:contract.revision ? String(contract.revision) : 'working-tree',
    source:contract.source ?? null,
    schema:{...contract.schema, direction, fields},
    consumers:(contract.consumers ?? []).map((consumer) => ({
      repository:normalizeRepository(consumer.repository),
      file:String(consumer.file ?? ''),
      line:Math.max(1, Number(consumer.line ?? 1)),
      fields:(consumer.fields ?? []).map(normalizeField).filter((field) => field.name)
    })).filter((consumer) => consumer.repository && consumer.file),
    updatedAt:new Date().toISOString()
  };
}

export function contractChanges(previous, proposed) {
  const direction = proposed?.direction ?? proposed?.schema?.direction ?? previous?.direction ?? previous?.schema?.direction ?? 'request';
  const before = new Map((previous?.schema?.fields ?? []).map((field) => [field.name, field]));
  const after = new Map((proposed?.schema?.fields ?? []).map((field) => [field.name, field]));
  const changes = [];
  for (const [name, field] of before) {
    const next = after.get(name);
    if (!next) changes.push({field:name, kind:'removed', before:field.type, after:null, direction});
    else if (field.type !== next.type) changes.push({field:name, kind:'type-changed', before:field.type, after:next.type, direction});
    else if (field.required !== next.required) changes.push({field:name, kind:'required-changed', before:field.required, after:next.required, direction});
  }
  for (const [name, field] of after) {
    if (!before.has(name)) changes.push({field:name, kind:field.required ? 'required-added' : 'optional-added', before:null, after:field.type, direction});
  }
  return changes;
}

export function breakingChangeForConsumer(change, expected) {
  if (change.direction === 'response') {
    if (['removed', 'type-changed'].includes(change.kind)) return Boolean(expected);
    return change.kind === 'required-changed' && change.after === false && expected?.required === true;
  }
  if (change.kind === 'required-added') return true;
  if (['removed', 'type-changed'].includes(change.kind)) return Boolean(expected);
  return change.kind === 'required-changed' && change.after === true && expected?.required !== true;
}

export function contractIdentity(contract) {
  const normalized = normalizeContract(contract);
  return `${normalized.organizationId}:${normalized.repository}:${normalized.method}:${normalized.route}:${normalized.direction}`;
}
