import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {inspectRemoteGitSync} from '../packages/core/git-evidence.mjs';
const root=await fs.mkdtemp(path.join(os.tmpdir(),'aipi-remote-status-'));
const git=(...args)=>execFileSync('git',['-C',root,...args],{encoding:'utf8'}).trim();
try{
 git('init','-b','main');git('config','user.email','test@example.invalid');git('config','user.name','AIPI fixture');git('remote','add','origin','https://github.com/acme/fixture');
 await fs.writeFile(path.join(root,'api.txt'),'one');git('add','.');git('commit','-m','one');const first=git('rev-parse','HEAD');
 await fs.writeFile(path.join(root,'api.txt'),'two');git('commit','-am','two');const second=git('rev-parse','HEAD');
 const options=commit=>({readRemote:async()=>`${commit}\trefs/heads/main\n`});
 assert.equal((await inspectRemoteGitSync(root,{},options(second))).status,'up_to_date');
 assert.equal((await inspectRemoteGitSync(root,{},options(first))).status,'ahead');
 git('reset','--hard',first);assert.equal((await inspectRemoteGitSync(root,{},options(second))).status,'behind');
 await fs.writeFile(path.join(root,'api.txt'),'other');git('commit','-am','different');const divergent=git('rev-parse','HEAD');
 assert.equal((await inspectRemoteGitSync(root,{},options(second))).status,'diverged');
 await fs.writeFile(path.join(root,'api.txt'),'uncommitted');const dirty=await inspectRemoteGitSync(root,{},options(divergent));assert.equal(dirty.dirty,true);assert.equal(dirty.status,'up_to_date');
 assert.equal(git('rev-parse','HEAD'),divergent,'Checking never moves HEAD');
 assert.equal(await fs.readFile(path.join(root,'api.txt'),'utf8'),'uncommitted','Checking never changes working files');
 assert.equal((await inspectRemoteGitSync(root,{},options(''))).status,'unknown');
 assert.equal((await inspectRemoteGitSync(root,{},options('f'.repeat(40)))).status,'different');
 assert.doesNotMatch(JSON.stringify(dirty),new RegExp(root));
 console.log('Remote Git sync: current, ahead, behind, diverged, unknown and dirty states; no checkout writes or paths returned');
}finally{await fs.rm(root,{recursive:true,force:true});}
