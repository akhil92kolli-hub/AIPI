import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const data = await fs.mkdtemp(path.join(os.tmpdir(), "aipi-workspace-lock-"));
const storeUrl = new URL("../scripts/workspace-store.mjs", import.meta.url).href;
const start = (marker, delayMs = 120) => {
  const source = `import {mutateState} from ${JSON.stringify(storeUrl)}; await mutateState(async state => { await new Promise(r => setTimeout(r, ${delayMs})); state.activity.push({marker:${JSON.stringify(marker)}}); });`;
  const child = spawn(process.execPath, ["--input-type=module", "--eval", source], { env: { ...process.env, AIPI_DATA: data, AIPI_WORKSPACE_LOCK_STALE_MS: "1200" }, stdio: ["ignore", "pipe", "pipe"] });
  let error = "";
  child.stderr.on("data", (chunk) => { error += chunk; });
  const completion = new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("exit", (code) => code === 0 ? resolve() : reject(new Error(error || `child exited ${code}`)));
  });
  return { child, completion };
};
const run = (marker) => start(marker).completion;

const lockPath = path.join(data, "workspace.lock");
let holder;
try {
  await Promise.all([run("left"), run("right")]);
  await fs.writeFile(lockPath, "99999999:dead-owner\n");
  const old = new Date(Date.now() - 60_000);
  await fs.utimes(lockPath, old, old);
  await run("stale-lock-recovered");

  holder = start("long-operation", 5400);
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline) {
    const owner = await fs.readFile(lockPath, "utf8").catch(() => "");
    if (Number.parseInt(owner, 10) === holder.child.pid) break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(Number.parseInt(await fs.readFile(lockPath, "utf8"), 10), holder.child.pid, "the long operation owns the workspace lock");
  const initialLockTime = (await fs.stat(lockPath)).mtimeMs;
  await new Promise((resolve) => setTimeout(resolve, 1500));
  assert.ok((await fs.stat(lockPath)).mtimeMs > initialLockTime, "a live long-running mutation refreshes its lock lease");
  await run("waited-for-owner");
  await holder.completion;
  const state = JSON.parse(await fs.readFile(path.join(data, "workspace.json"), "utf8"));
  assert.deepEqual(state.activity.map((entry) => entry.marker).sort(), ["left", "long-operation", "right", "stale-lock-recovered", "waited-for-owner"]);
  assert.equal(state.revision, 5);
  const regressionData = path.join(data, "queue-inversion");
  const regression = `import {mutateState,loadState,saveState} from ${JSON.stringify(storeUrl)};
    await mutateState(() => {});
    const snapshot = await loadState(false);
    let release, entered; const gate = new Promise(r => release = r), ready = new Promise(r => entered = r);
    const mutation = mutateState(async state => { entered(); await gate; state.activity.push({marker:'completed'}); });
    await ready;
    const concurrentSave = saveState(snapshot);
    await new Promise(r => setTimeout(r, 200));
    release();
    await Promise.all([mutation, concurrentSave]);`;
  await promisify(execFile)(process.execPath, ["--input-type=module", "--eval", regression], { env: { ...process.env, AIPI_DATA: regressionData }, timeout: 5000 });
  console.log("workspace cross-process lock test passed");
} finally {
  if (holder && holder.child.exitCode === null) {
    holder.child.kill("SIGTERM");
    await holder.completion.catch(() => {});
  }
  await fs.rm(data, { recursive: true, force: true });
}
