import assert from 'node:assert/strict';
import {startTeamSyncSession} from '../packages/core/team-realtime.mjs';
let fail=false,calls=0;
const channel={on(){return this;},subscribe(){return this;}};
const session=await startTeamSyncSession({}, {organizationId:'11111111-1111-4111-a111-111111111111',accessToken:'test-session',
  clientFactory:()=>({realtime:{setAuth:async()=>{}},channel:()=>channel,removeChannel:async()=>{}}),
  sync:async()=>({error:fail?'denied':null}),onAfterSync:async({accessToken})=>{assert.equal(accessToken,'test-session');calls++;return {linked:1,conflicts:0};}});
try{assert.equal(calls,1);assert.equal(session.status().result.repositoryBindings.linked,1);
  fail=true;await session.runNow();assert.equal(calls,1,'No reconciliation after a failed access/sync pass');
}finally{await session.stop();}
console.log('Repository reconciliation runs after authenticated sync and is skipped on sync failure');
