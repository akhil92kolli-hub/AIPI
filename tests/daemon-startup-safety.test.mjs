import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'aipi-startup-safety-'));
const descriptor = path.join(temp, 'daemon.json');
const cli = path.resolve('scripts/aipi-cli-bundle.mjs');
const env = {...process.env, AIPI_CONNECTION_FILE:descriptor, AIPI_DATA:path.join(temp, 'data'), AIPI_PORT:'0', AIPI_MAX_PORT:'0'};
const busy = http.createServer(() => {});
const children = [];
try {
  await new Promise(resolve => busy.listen(0, '127.0.0.1', resolve));
  const record = JSON.stringify({pid:process.pid, url:`http://127.0.0.1:${busy.address().port}`, token:'test-only'});
  await fs.writeFile(descriptor, record);
  await assert.rejects(exec(process.execPath, [cli, 'daemon'], {env, timeout:10000}), error => /may be busy/.test(error.stderr));
  assert.equal(await fs.readFile(descriptor, 'utf8'), record, 'a timeout must not delete a live descriptor');
  await fs.unlink(descriptor);
  for (let i = 0; i < 3; i++) children.push(spawn(process.execPath, [cli, 'daemon'], {env, stdio:['ignore','pipe','pipe']}));
  const deadline = Date.now() + 20000;
  let saved;
  while (Date.now() < deadline) {
    try { saved = JSON.parse(await fs.readFile(descriptor, 'utf8')); break; } catch {}
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.ok(saved, 'one concurrent starter publishes a descriptor');
  const connection = await fetch(`${saved.url}/api/connection`, {headers:{authorization:`Bearer ${saved.token}`}});
  assert.equal(connection.status, 200);
  await new Promise(resolve => setTimeout(resolve, 1000));
  assert.equal(children.filter(child => child.exitCode === null).length, 1, 'only one direct daemon survives concurrent startup');
  assert.equal(saved.pid, children.find(child => child.exitCode === null).pid);
  console.log('daemon startup safety: busy descriptors preserved and concurrent starts coordinated');
} finally {
  for (const child of children) if (child.exitCode === null) child.kill('SIGTERM');
  await Promise.all(children.map(child => child.exitCode !== null ? Promise.resolve() : new Promise(resolve => child.once('exit', resolve))));
  busy.closeAllConnections();
  await new Promise(resolve => busy.close(resolve));
  await fs.rm(temp, {recursive:true, force:true});
}
