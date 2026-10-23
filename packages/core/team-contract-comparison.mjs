const methods = ['get', 'put', 'post', 'delete', 'patch', 'options', 'head', 'trace'];
const constraintKeys = ['minimum','maximum','exclusiveMinimum','exclusiveMaximum','multipleOf',
  'minLength','maxLength','pattern','minItems','maxItems','uniqueItems','minProperties','maxProperties',
  'additionalProperties','nullable','const'];
const plain = value => value && typeof value === 'object' && !Array.isArray(value);
const keys = value => plain(value) ? Object.keys(value).sort() : [];

function inspectSchema(schema, document, seen = new Set(), depth = 0) {
  if (depth > 32) return { shape: null, unresolved: true };
  if (!plain(schema)) return { shape: null, unresolved: true };
  if (typeof schema.$ref === 'string') {
    const prefix = '#/components/schemas/';
    if (!schema.$ref.startsWith(prefix) || seen.has(schema.$ref)) return { shape: null, unresolved: true };
    const name = schema.$ref.slice(prefix.length).replaceAll('~1', '/').replaceAll('~0', '~');
    return inspectSchema(document.components?.schemas?.[name], document, new Set([...seen, schema.$ref]), depth + 1);
  }
  if (schema.oneOf || schema.anyOf || schema.allOf || schema.not || schema.discriminator)
    return { shape: null, unresolved: true };
  const properties = Object.create(null);
  for (const name of keys(schema.properties)) {
    const value = schema.properties[name];
    const child = inspectSchema(value, document, seen, depth + 1);
    if (child.unresolved) return { shape: null, unresolved: true };
    properties[name] = child.shape;
  }
  let items = null;
  if (schema.items) {
    const child = inspectSchema(schema.items, document, seen, depth + 1);
    if (child.unresolved) return { shape: null, unresolved: true };
    items = child.shape;
  }
  return { shape: { type: schema.type ?? null, format: schema.format ?? null,
    required: [...(Array.isArray(schema.required) ? schema.required : [])].sort(), properties, items,
    enum: Array.isArray(schema.enum) ? [...schema.enum].sort() : null,
    constraints: Object.fromEntries(constraintKeys.filter(key => Object.hasOwn(schema,key))
      .map(key => [key,schema[key]])) }, unresolved: false };
}

function mediaSchemas(content, document) {
  const result = Object.create(null);
  for (const media of keys(content)) {
    const schema = inspectSchema(content[media]?.schema, document);
    result[media] = schema;
  }
  return result;
}

function compareShape(before, after, location, direction, changes) {
  if (!before || !after) return;
  if (before.type !== after.type || before.format !== after.format || JSON.stringify(before.enum) !== JSON.stringify(after.enum))
    changes.push({ location, kind: 'type_or_value_changed', effect: 'breaking_candidate' });
  if (JSON.stringify(before.constraints) !== JSON.stringify(after.constraints))
    changes.push({ location, kind: 'constraint_changed', effect: direction === 'request' ? 'breaking_candidate' : 'review_required' });
  const oldProperties = new Set(keys(before.properties));
  const newProperties = new Set(keys(after.properties));
  for (const property of oldProperties) if (!newProperties.has(property))
    changes.push({ location: `${location}.${property}`, kind: 'property_removed',
      effect: direction === 'response' ? 'breaking_candidate' : 'review_required' });
  for (const property of newProperties) if (!oldProperties.has(property))
    changes.push({ location: `${location}.${property}`, kind: 'property_added',
      effect: direction === 'request' && after.required.includes(property) ? 'breaking_candidate' : 'additive_candidate' });
  for (const property of oldProperties) if (newProperties.has(property))
    compareShape(before.properties[property], after.properties[property], `${location}.${property}`, direction, changes);
  for (const property of after.required) if (!before.required.includes(property) && oldProperties.has(property))
    changes.push({ location: `${location}.${property}`, kind: 'became_required',
      effect: direction === 'request' ? 'breaking_candidate' : 'review_required' });
  for (const property of before.required) if (!after.required.includes(property) && newProperties.has(property))
    changes.push({ location: `${location}.${property}`, kind: 'became_optional',
      effect: direction === 'response' ? 'breaking_candidate' : 'review_required' });
  if (before.items && after.items) compareShape(before.items, after.items, `${location}[]`, direction, changes);
}

// OpenAPI JSON only. Output is structural evidence, not a compatibility verdict:
// generated code, semantic validation, custom extensions and deployed consumers
// still require independent checks.
export function compareOpenApiJson(beforeText, afterText, { path = '' } = {}) {
  if (typeof beforeText !== 'string' || typeof afterText !== 'string' ||
      beforeText.length > 200_000 || afterText.length > 200_000) throw new TypeError('Bounded OpenAPI JSON text is required');
  let before, after;
  try { before = JSON.parse(beforeText); after = JSON.parse(afterText); }
  catch { return { path, status: 'unknown', reason: 'OpenAPI JSON could not be parsed', changes: [] }; }
  if (!plain(before) || !plain(after) || !/^3\./.test(before.openapi ?? '') || !/^3\./.test(after.openapi ?? '') ||
      !plain(before.paths) || !plain(after.paths))
    return { path, status: 'unknown', reason: 'Both revisions must be OpenAPI 3 JSON documents', changes: [] };
  const changes = [];
  let unresolved = false;
  const routes = new Set([...keys(before.paths), ...keys(after.paths)]);
  for (const route of [...routes].sort()) for (const method of methods) {
    if (before.paths[route]?.$ref || after.paths[route]?.$ref) { unresolved = true; continue; }
    const oldOperation = before.paths[route]?.[method], newOperation = after.paths[route]?.[method];
    const location = `${method.toUpperCase()} ${route}`;
    if (!oldOperation && !newOperation) continue;
    if (!oldOperation || !newOperation) {
      changes.push({ location, kind: oldOperation ? 'operation_removed' : 'operation_added',
        effect: oldOperation ? 'breaking_candidate' : 'additive_candidate' }); continue;
    }
    const oldResponses = oldOperation.responses ?? {}, newResponses = newOperation.responses ?? {};
    for (const status of new Set([...keys(oldResponses), ...keys(newResponses)])) {
      const responseLocation = `${location} response ${status}`;
      if (!oldResponses[status] || !newResponses[status]) {
        changes.push({ location: responseLocation, kind: oldResponses[status] ? 'response_removed' : 'response_added',
          effect: oldResponses[status] ? 'breaking_candidate' : 'additive_candidate' }); continue;
      }
      if (oldResponses[status].$ref || newResponses[status].$ref) { unresolved = true; continue; }
      const oldMedia = mediaSchemas(oldResponses[status].content, before);
      const newMedia = mediaSchemas(newResponses[status].content, after);
      for (const media of new Set([...keys(oldMedia), ...keys(newMedia)])) {
        if (!oldMedia[media] || !newMedia[media]) {
          changes.push({ location: `${responseLocation} ${media}`, kind: oldMedia[media] ? 'media_removed' : 'media_added',
            effect: oldMedia[media] ? 'breaking_candidate' : 'additive_candidate' }); continue;
        }
        if (oldMedia[media].unresolved || newMedia[media].unresolved) { unresolved = true; continue; }
        compareShape(oldMedia[media].shape, newMedia[media].shape, `${responseLocation} ${media}`,'response',changes);
      }
    }
    if (oldOperation.requestBody?.$ref || newOperation.requestBody?.$ref) unresolved = true;
    const oldBody = mediaSchemas(oldOperation.requestBody?.content, before);
    const newBody = mediaSchemas(newOperation.requestBody?.content, after);
    if (!oldOperation.requestBody?.required && newOperation.requestBody?.required)
      changes.push({ location: `${location} request body`, kind: 'request_body_became_required', effect: 'breaking_candidate' });
    for (const media of new Set([...keys(oldBody), ...keys(newBody)])) {
      if (!oldBody[media] || !newBody[media]) {
        changes.push({ location: `${location} request ${media}`, kind: oldBody[media] ? 'request_media_removed' : 'request_media_added',
          effect: newBody[media] && newOperation.requestBody?.required ? 'breaking_candidate' : 'review_required' }); continue;
      }
      if (oldBody[media].unresolved || newBody[media].unresolved) { unresolved = true; continue; }
      compareShape(oldBody[media].shape,newBody[media].shape,`${location} request ${media}`,'request',changes);
    }
    const parameters = (pathItem, operation) => [...(Array.isArray(pathItem?.parameters) ? pathItem.parameters : []),
      ...(Array.isArray(operation?.parameters) ? operation.parameters : [])];
    const previousParameters = parameters(before.paths[route], oldOperation);
    const proposedParameters = parameters(after.paths[route], newOperation);
    const named = param => plain(param) && !param.$ref && typeof param.in === 'string' && typeof param.name === 'string';
    if ([...previousParameters, ...proposedParameters].some(param => !named(param))) unresolved = true;
    const oldParams = new Map(previousParameters.filter(named).map(param => [`${param.in}:${param.name}`,param]));
    const newParams = new Map(proposedParameters.filter(named).map(param => [`${param.in}:${param.name}`,param]));
    for (const id of new Set([...oldParams.keys(),...newParams.keys()])) {
      const prior = oldParams.get(id), next = newParams.get(id);
      if (!prior || !next) changes.push({ location: `${location} parameter ${id}`, kind: prior ? 'parameter_removed' : 'parameter_added',
        effect: next?.required ? 'breaking_candidate' : 'review_required' });
      else if (!prior.required && next.required) changes.push({ location: `${location} parameter ${id}`,
        kind: 'parameter_became_required', effect: 'breaking_candidate' });
      else if (JSON.stringify(prior.schema) !== JSON.stringify(next.schema)) changes.push({ location: `${location} parameter ${id}`,
        kind: 'parameter_schema_changed', effect: 'review_required' });
    }
  }
  return { path, status: unresolved ? 'partial' : 'compared',
    reason: unresolved ? 'Composition, external or unresolved schema references require review' : 'Selected OpenAPI structure compared; other keywords and consumer compatibility remain unproven',
    changes: changes.slice(0, 200), truncated: changes.length > 200 };
}
