import assert from 'node:assert/strict';
import { scanWorkspaceProjects } from '../ui/workspace-explorer.js';
const projects = ['one', 'missing', 'failed', 'restricted', 'last'].map(id => ({id,name:id,sourceContext:{roots:id === 'missing' ? [] : [{path:`/repo/${id}`}]} }));
const visited = [];
const results = await scanWorkspaceProjects({projects, canScan: id => id !== 'restricted', scanProject: async (id, roots) => {
 visited.push(id); assert.equal(roots[0].path, `/repo/${id}`);
 if(id === 'failed') throw new Error('Source unavailable');
 return {filesScanned:3,endpoints:[],frontendCalls:[]};
}});
assert.deepEqual(visited, ['one','failed','last']);
assert.deepEqual(results.map(r=>r.status), ['complete','skipped','failed','skipped','complete']);
let stop = false;
const stopped = await scanWorkspaceProjects({projects, shouldStop:()=>stop, scanProject:async()=>{stop=true;return {filesScanned:1};}});
assert.equal(stopped.length,1);
assert.equal(stopped[0].status,'complete');
console.log('Workspace scanning: configured roots, per-project failure recovery, IDE ownership and stop-after-current passed');
