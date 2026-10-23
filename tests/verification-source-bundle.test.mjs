import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { test } from 'node:test';
import { exportCleanVerificationSourceBundles, importCleanVerificationSourceBundles } from '../packages/core/verification-source-bundle.mjs';

const execute = promisify(execFile);
const hash = value => `sha256:${crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex')}`;

test('approved clean source history exports and imports an exact commit without the origin checkout', async t => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'aipi-source-bundle-'));
  t.after(() => fs.rm(temporary, { recursive: true, force: true }));
  const root = path.join(temporary, 'origin');
  await fs.mkdir(root);
  const git = async (...args) => (await execute('git', ['-C', root, ...args])).stdout.trim();
  await git('init', '-q');
  await fs.writeFile(path.join(root, 'app.py'), 'print("ready")\n');
  await git('add', '.');
  await git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-qm', 'source');
  const commit = await git('rev-parse', 'HEAD');
  const body = { schemaVersion: 1, kind: 'aipi.verification-package', workspaceId: 'workspace-one',
    changeId: 'change-one', resources: [{ projectId: 'orders', resourceId: 'root', commit, dirty: false }],
    checks: [{ projectId: 'orders', resourceId: 'root' }], receiptIds: [], complete: true, sourceReproducible: true };
  const manifest = { ...body, manifestHash: hash(body) };
  const bindings = [{ projectId: 'orders', resourceId: 'root', root }];
  const artifactDirectory = path.join(temporary, 'artifacts');
  await assert.rejects(exportCleanVerificationSourceBundles({ manifest, bindings,
    outputDirectory: artifactDirectory, approveHistory: () => false }), /approval/);
  const bundleManifest = await exportCleanVerificationSourceBundles({ manifest, bindings,
    outputDirectory: artifactDirectory, approveHistory: () => true });
  assert.equal(bundleManifest.artifacts.length, 1);
  assert.match(bundleManifest.artifacts[0].file, /^[a-f0-9]{64}\.bundle$/);
  const destinationDirectory = path.join(temporary, 'imported');
  await assert.rejects(importCleanVerificationSourceBundles({ manifest, bundleManifest,
    artifactDirectory, destinationDirectory, approveImport: () => false }), /unapproved/);
  const imported = await importCleanVerificationSourceBundles({ manifest, bundleManifest,
    artifactDirectory, destinationDirectory, approveImport: () => true });
  assert.equal(imported.length, 1);
  assert.equal((await execute('git', ['-C', imported[0].root, 'rev-parse', 'HEAD'])).stdout.trim(), commit);
  assert.equal(await fs.readFile(path.join(imported[0].root, 'app.py'), 'utf8'), 'print("ready")\n');
  await fs.appendFile(path.join(root, 'app.py'), 'print("changed")\n');
  await assert.rejects(exportCleanVerificationSourceBundles({ manifest, bindings,
    outputDirectory: artifactDirectory, approveHistory: () => true }), /Source changed/);
  await fs.appendFile(path.join(artifactDirectory, bundleManifest.artifacts[0].file), 'tamper');
  await assert.rejects(importCleanVerificationSourceBundles({ manifest, bundleManifest,
    artifactDirectory, destinationDirectory: path.join(temporary, 'tampered'),
    approveImport: () => true }), /artifact changed/);
});
