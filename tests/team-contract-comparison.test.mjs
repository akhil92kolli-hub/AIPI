import assert from 'node:assert/strict';
import { compareOpenApiJson } from '../packages/core/team-contract-comparison.mjs';

const schema = properties => ({ openapi:'3.1.0', paths: { '/orders': { get: { responses: {
  200: { content: { 'application/json': { schema: { type:'object', properties } } } },
} } } } });
const before = schema({id:{type:'string'},total:{type:'number'}});
const after = schema({id:{type:'string'},amount:{type:'number'}});
const result = compareOpenApiJson(JSON.stringify(before),JSON.stringify(after),{path:'openapi.json'});
assert.equal(result.status,'compared');
assert.deepEqual(result.changes.map(entry=>entry.kind),['property_removed','property_added']);
assert.equal(result.changes[0].effect,'breaking_candidate');
assert.equal(result.changes[1].effect,'additive_candidate');
const requiredBefore = structuredClone(before);
requiredBefore.paths['/orders'].get.responses[200].content['application/json'].schema.required=['id'];
const optionalAfter = structuredClone(requiredBefore);
optionalAfter.paths['/orders'].get.responses[200].content['application/json'].schema.required=[];
assert.deepEqual(compareOpenApiJson(JSON.stringify(requiredBefore),JSON.stringify(optionalAfter)).changes,
  [{location:'GET /orders response 200 application/json.id',kind:'became_optional',effect:'breaking_candidate'}]);
const requestBefore = {openapi:'3.1.0',paths:{'/orders':{post:{requestBody:{content:{'application/json':{
  schema:{type:'object',properties:{id:{type:'string'}}}}}},responses:{200:{description:'ok'}}}}}};
const requestAfter = structuredClone(requestBefore);
requestAfter.paths['/orders'].post.requestBody.content['application/json'].schema.properties.token={type:'string'};
requestAfter.paths['/orders'].post.requestBody.content['application/json'].schema.required=['token'];
assert.equal(compareOpenApiJson(JSON.stringify(requestBefore),JSON.stringify(requestAfter)).changes[0].effect,'breaking_candidate');
const constrained = structuredClone(requestBefore);
constrained.paths['/orders'].post.requestBody.content['application/json'].schema.properties.id.minLength=12;
assert.equal(compareOpenApiJson(JSON.stringify(requestBefore),JSON.stringify(constrained)).changes[0].kind,'constraint_changed');
const pathParamsBefore={openapi:'3.1.0',paths:{'/orders/{id}':{parameters:[{in:'path',name:'id',required:true,schema:{type:'string'}}],
  get:{responses:{200:{description:'ok'}}}}}};
const pathParamsAfter=structuredClone(pathParamsBefore);
pathParamsAfter.paths['/orders/{id}'].parameters[0].schema.pattern='^[0-9]+$';
assert.equal(compareOpenApiJson(JSON.stringify(pathParamsBefore),JSON.stringify(pathParamsAfter)).changes[0].kind,'parameter_schema_changed');
const unknown = schema({id:{$ref:'https://example.com/external-schema'}});
assert.equal(compareOpenApiJson(JSON.stringify(before),JSON.stringify(unknown)).status,'partial');
const referencedResponse = structuredClone(before);
referencedResponse.paths['/orders'].get.responses[200]={$ref:'#/components/responses/Order'};
assert.equal(compareOpenApiJson(JSON.stringify(before),JSON.stringify(referencedResponse)).status,'partial');
const referencedParameter = structuredClone(pathParamsBefore);
referencedParameter.paths['/orders/{id}'].parameters=[{$ref:'#/components/parameters/OrderId'}];
assert.equal(compareOpenApiJson(JSON.stringify(pathParamsBefore),JSON.stringify(referencedParameter)).status,'partial');
assert.equal(compareOpenApiJson('not-json',JSON.stringify(after)).status,'unknown');
console.log('Bounded OpenAPI structural deltas distinguish breaking candidates, additive candidates and unresolved schemas');
