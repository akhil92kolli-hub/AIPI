import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { incrementalSourceIndex } from '../packages/contract-engine/incremental-index.mjs';

const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'aipi-content-index-'));
try {
  const root = path.join(temp, 'root');
  await fs.mkdir(root);
  const file = path.join(root, 'api.ts');
  const outside = path.join(temp, 'outside.ts');
  const linked = path.join(root, 'linked.ts');
  await fs.writeFile(file, 'route=A\n');
  await fs.writeFile(outside, 'outside\n');
  await fs.symlink(outside, linked);
  let parsed = 0;
  const detect = async (_file, text) => { parsed += 1; return { route: text.trim() }; };
  const first = await incrementalSourceIndex({ root, files: [file, linked], detect });
  assert.equal(first.metrics.parsed, 1);
  assert.equal(first.metrics.unreadable, 1, 'a symlink outside the registered root is excluded');
  const originalTime = (await fs.stat(file)).mtime;
  await fs.writeFile(file, 'route=B\n');
  await fs.utimes(file, originalTime, originalTime);
  const changed = await incrementalSourceIndex({ root, files: [file], detect });
  assert.equal(changed.metrics.parsed, 1, 'equal size and timestamp cannot reuse stale facts');
  assert.equal(changed.results[0].route, 'route=B');
  const unchanged = await incrementalSourceIndex({ root, files: [file], detect });
  assert.equal(unchanged.metrics.parsed, 0);
  assert.equal(unchanged.metrics.cacheHits, 1);
  assert.equal(parsed, 2);
  console.log('Incremental extraction validates byte hashes and registered-root containment');
} finally {
  await fs.rm(temp, { recursive: true, force: true });
}
