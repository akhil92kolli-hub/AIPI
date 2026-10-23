import test from 'node:test';
import assert from 'node:assert/strict';
import {buildTaskContext,suggestTaskArtifacts} from '../packages/core/task-context.mjs';
const project = () => ({id:'p',name:'Demo',requests:[],tasks:[{id:'t',title:'Fix login validation'}],sourceContext:{lastScannedAt:'2026-10-10',artifacts:[{id:'login',kind:'component',name:'LoginForm',source:'src/LoginForm.tsx',root:'/project'},{id:'other',kind:'component',name:'Cart',source:'src/Cart.tsx',root:'/project'}]}});
test('candidate discovery never silently links a suggestion',()=>{
  const p=project();const candidates=suggestTaskArtifacts(p,'t');
  assert.equal(candidates.length,1);assert.equal(candidates[0].id,'component:login');
  assert.equal(candidates[0].relationship,'suggested');assert.equal(buildTaskContext(p,'t').artifacts.length,0);
});
test('context identity changes with task links and index revision',()=>{
  const p=project();const before=buildTaskContext(p,'t');
  assert.equal(before.unresolvedQuestions.length,1);
  p.tasks[0].artifactIds=['component:login'];const linked=buildTaskContext(p,'t');
  assert.notEqual(before.id,linked.id);assert.equal(linked.artifacts.length,1);
  p.sourceContext.lastScannedAt='next';assert.notEqual(linked.id,buildTaskContext(p,'t').id);
});
test('unknown task rejected; unlinked files excluded',()=>{
  const p=project();assert.throws(()=>buildTaskContext(p,'other'));
  p.tasks[0].artifactIds=['component:login'];assert.deepEqual(buildTaskContext(p,'t').artifacts.map(a=>a.id),['component:login']);
});
