import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
const exec=promisify(execFile);
const bin=process.env.AIPI_TEST_PG_BINDIR||'/opt/homebrew/opt/postgresql@17/bin';
await fs.access(path.join(bin,'postgres'));
const temp=await fs.mkdtemp(path.join(os.tmpdir(),'aipi-source-sql-'));
const server=net.createServer();await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const port=server.address().port;await new Promise(resolve=>server.close(resolve));
let started=false;
const run=(command,args,extra={})=>exec(path.join(bin,command),args,{timeout:30000,maxBuffer:2000000,...extra});
const sql=async(statement)=>{const child=execFile(path.join(bin,'psql'),['-h',temp,'-p',String(port),'-d','postgres','-v','ON_ERROR_STOP=1'],{timeout:30000},()=>{});let output='';let errors='';child.stdout.on('data',chunk=>output+=chunk);child.stderr.on('data',chunk=>errors+=chunk);child.stdin.end(statement);await new Promise((resolve,reject)=>child.on('exit',code=>code===0?resolve():reject(new Error(errors+output))));};
try{
 await run('initdb',['-D',path.join(temp,'data'),'--no-locale','-E','UTF8','--auth-local=trust']);
 await run('pg_ctl',['-D',path.join(temp,'data'),'-l',path.join(temp,'postgres.log'),'-o',`-k ${temp} -p ${port} -c listen_addresses=''`,'-w','start']);started=true;
 await sql(await fs.readFile(new URL('./fixtures/source-identity-schema.sql',import.meta.url),'utf8'));
 for(const file of ['20261023010000_workspace_source_identities.sql','20261023011000_source_identity_feed.sql','20261023012000_primary_source_identity_guard.sql','20261023013000_logical_project_names.sql'])await sql(await fs.readFile(new URL('../supabase/migrations/'+file,import.meta.url),'utf8'));
 await sql("insert into team_source_bindings(workspace_id,project_key,source_id,name,kind,provider_repository_id) values('11111111-1111-4111-a111-111111111111','prj_api1234','src_duplicate1234','Duplicate','repository','123');");
 await sql(await fs.readFile(new URL('../supabase/migrations/20261023020000_source_tracking_and_dedup.sql',import.meta.url),'utf8'));
 await sql(await fs.readFile(new URL('../supabase/migrations/20261023021000_tracking_version_guard.sql',import.meta.url),'utf8'));
 await sql(await fs.readFile(new URL('./fixtures/source-identity-acceptance.sql',import.meta.url),'utf8'));
 console.log('PostgreSQL acceptance: duplicate backfill, aliases, local binding, additional source, exact retries, branch tracking, immutable directories, ownership, viewer denial and RLS passed');
}finally{if(started)await run('pg_ctl',['-D',path.join(temp,'data'),'-m','immediate','stop']);await fs.rm(temp,{recursive:true,force:true});}
