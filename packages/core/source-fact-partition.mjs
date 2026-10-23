import { createHash } from 'node:crypto';

const sha256 = value => createHash('sha256').update(value).digest('hex');
const proseKeys = new Set(['description','summary','example','examples','externalDocs','title']);
const structuralOnly = (value, depth = 0) => {
  if (depth > 48) throw new TypeError('OpenAPI structure exceeds depth limit');
  if (Array.isArray(value)) return value.map(item => structuralOnly(item, depth + 1));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value)
    .filter(([key]) => !proseKeys.has(key) && !key.startsWith('x-'))
    .map(([key,item]) => [key, structuralOnly(item, depth + 1)]));
  return value;
};
const stable = value => Array.isArray(value) ? value.map(stable) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])])) : value;
const digest = value => sha256(JSON.stringify(stable(value)));
const methods = ['get', 'put', 'post', 'delete', 'patch', 'options', 'head', 'trace'];
const commitPattern = /^[0-9a-f]{40}$/;
const sourcePattern = /^src_[A-Za-z0-9_-]{8,100}$/;

// Only structural OpenAPI 3 JSON is extracted. Descriptions, examples and
// vendor prose never enter a fact partition or an agent context pack.
export function extractOpenApiSourceFacts({ workspaceId, projectKey, sourceBindingId,
  revision, path, content, analyzerVersion = 'openapi-json-v1' }) {
  if (!workspaceId || !/^prj_[A-Za-z0-9_-]{4,100}$/.test(projectKey ?? '') ||
      !sourcePattern.test(sourceBindingId ?? '') || !commitPattern.test(revision ?? '') ||
      typeof path !== 'string' || !/^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))[^\u0000-\u001f]{1,500}$/.test(path) ||
      typeof content !== 'string' || content.length > 200_000 || analyzerVersion !== 'openapi-json-v1')
    throw new TypeError('A bounded source-scoped OpenAPI revision is required');
  let document;
  try { document = JSON.parse(content); } catch { throw new TypeError('OpenAPI JSON is invalid'); }
  if (!document || typeof document !== 'object' || Array.isArray(document) ||
      !/^3\./.test(document.openapi ?? '') || !document.paths ||
      typeof document.paths !== 'object' || Array.isArray(document.paths))
    throw new TypeError('OpenAPI 3 JSON paths are required');
  const operations = [];
  for (const route of Object.keys(document.paths).sort()) {
    const item = document.paths[route];
    if (!/^\/[A-Za-z0-9_./{}~%-]{0,299}$/.test(route) || !item || typeof item !== 'object' || Array.isArray(item) || item.$ref) continue;
    for (const method of methods) {
      const operation = item[method];
      if (!operation || typeof operation !== 'object' || Array.isArray(operation)) continue;
      const structural = structuralOnly({ parameters: operation.parameters ?? null, requestBody: operation.requestBody ?? null,
        responses: operation.responses ?? null });
      operations.push({ method: method.toUpperCase(), route, operationId: typeof operation.operationId === 'string' &&
        /^[A-Za-z_][A-Za-z0-9_.-]{0,199}$/.test(operation.operationId) ? operation.operationId : null,
        structuralHash: digest(structural) });
      if (operations.length > 500) throw new TypeError('OpenAPI operation limit exceeded');
    }
  }
  const contentHash = sha256(content);
  const facts = { kind: 'openapi_operations', operations };
  return { workspaceId, projectKey, sourceBindingId, revision, path, analyzerVersion,
    contentHash, factHash: digest(facts), facts, evidenceKind: 'extracted' };
}

export function extractGeneratedClientFacts({workspaceId,projectKey,sourceBindingId,revision,path,content,files}) {
  if(!workspaceId || !/^prj_[A-Za-z0-9_-]{4,100}$/.test(projectKey??'') || !sourcePattern.test(sourceBindingId??'') ||
      !commitPattern.test(revision??'') || !/^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))[^\u0000-\u001f]{1,500}$/.test(path??'') ||
      typeof content!=='string' || content.length>32_000 || !Array.isArray(files) || files.length>20)
    throw new TypeError('A bounded generated-client manifest and verified files are required');
  let manifest;
  try{manifest=JSON.parse(content);}catch{throw new TypeError('Generated-client manifest is invalid JSON');}
  const producer=manifest?.producer;
  const listed=manifest?.generatedFiles;
  const operations=manifest?.operationIds;
  if(manifest?.schemaVersion!==1 || !['openapi-generator','openapi-typescript','orval'].includes(manifest.generator) ||
      producer?.workspaceId!==workspaceId || !sourcePattern.test(producer?.sourceBindingId??'') ||
      !commitPattern.test(producer?.revision??'') || !/^[0-9a-f]{64}$/.test(producer?.contentHash??'') ||
      !Array.isArray(listed) || !listed.length || listed.length>20 ||
      !Array.isArray(operations) || !operations.length || operations.length>200 ||
      operations.some(item=>typeof item!=='string'||!/^[A-Za-z_][A-Za-z0-9_.-]{0,199}$/.test(item)))
    throw new TypeError('Generated-client provenance is incomplete');
  const verified=new Map(files.map(file=>[file.path,file.content]));
  const paths=new Set();
  for(const file of listed){
    if(typeof file?.path!=='string'|| !/^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))[^\u0000-\u001f]{1,500}$/.test(file.path)||
        paths.has(file.path)||!/^([0-9a-f]{64})$/.test(file.sha256??'')||
        typeof verified.get(file.path)!=='string'||sha256(verified.get(file.path))!==file.sha256)
      throw new TypeError('Generated-client file digest is missing or mismatched');
    paths.add(file.path);
  }
  for(const operationId of operations){
    const symbol=new RegExp(`(^|[^A-Za-z0-9_.-])${operationId.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')}([^A-Za-z0-9_.-]|$)`);
    if(![...paths].some(filePath=>symbol.test(verified.get(filePath))))
      throw new TypeError('Generated-client operation is absent from verified files');
  }
  const facts={kind:'generated_client',generator:manifest.generator,generatorEvidence:'extracted',
    producerSourceBindingId:producer.sourceBindingId,producerRevision:producer.revision,
    producerContentHash:producer.contentHash,operationIds:[...new Set(operations)].sort(),
    generatedFiles:[...paths].sort()};
  return {workspaceId,projectKey,sourceBindingId,revision,path,analyzerVersion:'generated-client-v1',
    contentHash:sha256(content),factHash:digest(facts),facts,evidenceKind:'manifest_claim'};
}

// A generated-client declaration is a deterministic candidate only when it
// names the exact producer source, revision and content hash. It is never a
// compatibility receipt and cannot promote a release decision on its own.
export function discoverPinnedGeneratedConsumers(producer, clients) {
  if (!producer || !Array.isArray(clients) || clients.length > 1000) throw new TypeError('Bounded producer and clients required');
  const matches = [];
  for (const client of clients) {
    const claim=client?.facts?.kind==='generated_client'?{...client,...client.facts}:client;
    if (claim?.kind !== 'generated_client' || claim?.generatorEvidence !== 'extracted' ||
        !sourcePattern.test(client.sourceBindingId ?? '') || !commitPattern.test(client.revision ?? '') ||
        claim.producerSourceBindingId !== producer.sourceBindingId ||
        claim.producerRevision !== producer.revision || claim.producerContentHash !== producer.contentHash ||
        client.workspaceId !== producer.workspaceId || client.sourceBindingId === producer.sourceBindingId) continue;
    const used = new Set(Array.isArray(claim.operationIds) ? claim.operationIds : []);
    const operations = producer.facts?.operations?.filter(operation => operation.operationId && used.has(operation.operationId)) ?? [];
    if (!operations.length) continue;
    matches.push({ projectKey: client.projectKey, sourceBindingId: client.sourceBindingId,
      revision: client.revision, path: client.path, producerSourceBindingId: producer.sourceBindingId,
      producerRevision: producer.revision, producerContentHash: producer.contentHash,
      operations: operations.map(({method, route, operationId}) => ({method, route, operationId})),
      status: 'candidate', evidenceKind: 'extracted', compatibility: 'unverified' });
  }
  return matches.sort((a,b) => `${a.sourceBindingId}:${a.path}`.localeCompare(`${b.sourceBindingId}:${b.path}`));
}

export function validateSourceFactPartition(partition) {
  return Boolean(partition && sourcePattern.test(partition.sourceBindingId ?? partition.source_id ?? '') &&
    commitPattern.test(partition.revision ?? partition.revision_commit ?? '') &&
    ['openapi-json-v1','generated-client-v1'].includes(partition.analyzerVersion ?? partition.analyzer_version) &&
    (partition.factHash ?? partition.fact_hash) === digest(partition.facts) &&
    /^[0-9a-f]{64}$/.test(partition.contentHash ?? partition.content_hash ?? ''));
}
