import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execute = promisify(execFile);
const digest = value => crypto.createHash('sha256').update(value).digest('hex');
const hash = value => `sha256:${digest(JSON.stringify(value))}`;
const key = value => JSON.stringify([value.projectId, value.resourceId]);
const fail = message => { throw new TypeError(message); };
const gitEnvironment = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: os.devNull,
  GIT_LFS_SKIP_SMUDGE: '1' };
const git = async (root, ...args) => (await execute('git', ['-C', root, ...args], {
  env: gitEnvironment, timeout: 30_000, maxBuffer: 2_000_000 })).stdout.trim();

function validPackage(manifest) {
  if (!manifest || manifest.schemaVersion !== 1 || manifest.kind !== 'aipi.verification-package'
    || manifest.complete !== true || manifest.sourceReproducible !== true
    || !Array.isArray(manifest.resources) || !manifest.resources.length || manifest.resources.length > 64
    || manifest.resources.some(item => item.dirty || !/^[a-f0-9]{40,64}$/.test(item.commit ?? ''))
    || new Set(manifest.resources.map(key)).size !== manifest.resources.length) return false;
  const { manifestHash, ...content } = manifest;
  return manifestHash === hash(content);
}

/** Full reachable Git history can contain old secrets. The caller must obtain
 * explicit per-resource approval to share that history before export. */
export async function exportCleanVerificationSourceBundles({ manifest, bindings,
  outputDirectory, approveHistory, maxBytesPerBundle = 100_000_000 }) {
  if (!validPackage(manifest) || !Array.isArray(bindings) || typeof approveHistory !== 'function'
    || !path.isAbsolute(outputDirectory ?? '') || !Number.isInteger(maxBytesPerBundle)
    || maxBytesPerBundle < 1 || maxBytesPerBundle > 500_000_000)
    fail('A complete clean package, absolute artifact directory and explicit history approval are required.');
  const bound = new Map(bindings.map(item => [key(item), item.root]));
  if (bound.size !== bindings.length) fail('Duplicate source bindings are not allowed.');
  await fs.mkdir(outputDirectory, { recursive: true });
  const artifacts = [];
  for (const resource of manifest.resources) {
    const root = bound.get(key(resource));
    if (typeof root !== 'string' || !path.isAbsolute(root)
      || await approveHistory(resource.projectId, resource.resourceId, resource.commit) !== true)
      fail('Every clean source and its reachable history require explicit sharing approval.');
    if (await git(root, 'rev-parse', 'HEAD') !== resource.commit
      || await git(root, 'status', '--porcelain=v1', '--untracked-files=all'))
      fail('Source changed after package review; export the current reviewed commit instead.');
    const temporary = path.join(outputDirectory, `.aipi-bundle-${crypto.randomUUID()}`);
    try {
      await git(root, 'bundle', 'create', temporary, 'HEAD');
      const bytes = await fs.readFile(temporary);
      if (!bytes.length || bytes.length > maxBytesPerBundle) fail('Source history bundle exceeds the approved size limit.');
      const contentHash = `sha256:${digest(bytes)}`;
      const file = `${digest(bytes)}.bundle`;
      const destination = path.join(outputDirectory, file);
      try { await fs.writeFile(destination, bytes, { flag: 'wx' }); }
      catch (error) { if (error.code !== 'EEXIST' || digest(await fs.readFile(destination)) !== digest(bytes)) throw error; }
      artifacts.push({ projectId: resource.projectId, resourceId: resource.resourceId,
        commit: resource.commit, file, contentHash, byteLength: bytes.length });
    } finally { await fs.rm(temporary, { force: true }); }
  }
  artifacts.sort((a, b) => key(a).localeCompare(key(b)));
  const body = { schemaVersion: 1, kind: 'aipi.clean-source-bundles',
    packageManifestHash: manifest.manifestHash, historyScope: 'all commits reachable from the pinned HEAD of each resource',
    artifacts };
  return { ...body, bundleManifestHash: hash(body) };
}

/** Verify every artifact before writing any checkout. This materializes source
 * only after the importing user approves each resource; it never installs or
 * executes an imported project command. */
export async function importCleanVerificationSourceBundles({ manifest, bundleManifest,
  artifactDirectory, destinationDirectory, approveImport }) {
  if (!validPackage(manifest) || !bundleManifest || bundleManifest.schemaVersion !== 1
    || bundleManifest.kind !== 'aipi.clean-source-bundles'
    || bundleManifest.packageManifestHash !== manifest.manifestHash
    || !Array.isArray(bundleManifest.artifacts) || bundleManifest.artifacts.length !== manifest.resources.length
    || typeof approveImport !== 'function' || !path.isAbsolute(artifactDirectory ?? '')
    || !path.isAbsolute(destinationDirectory ?? '')) fail('A matching clean bundle manifest and explicit import approval are required.');
  const { bundleManifestHash, ...unsigned } = bundleManifest;
  if (bundleManifestHash !== hash(unsigned)) fail('The source bundle manifest changed after export.');
  const resources = new Map(manifest.resources.map(item => [key(item), item]));
  const prepared = [], seen = new Set();
  for (const artifact of bundleManifest.artifacts) {
    const resource = resources.get(key(artifact));
    if (!resource || seen.has(key(artifact)) || resource.commit !== artifact.commit
      || !/^[a-f0-9]{64}\.bundle$/.test(artifact.file ?? '')
      || artifact.contentHash !== `sha256:${artifact.file.slice(0, 64)}`
      || !Number.isInteger(artifact.byteLength) || artifact.byteLength < 1
      || artifact.byteLength > 500_000_000
      || await approveImport(artifact.projectId, artifact.resourceId, artifact.commit) !== true)
      fail('An imported source artifact is unapproved or does not match the reviewed package.');
    seen.add(key(artifact));
    const file = path.join(artifactDirectory, artifact.file);
    const bytes = await fs.readFile(file);
    if (bytes.length !== artifact.byteLength || `sha256:${digest(bytes)}` !== artifact.contentHash)
      fail('A source artifact changed after export.');
    prepared.push({ artifact, file, destination: path.join(destinationDirectory,
      `resource-${digest(key(artifact)).slice(0, 24)}`) });
  }
  if (seen.size !== resources.size) fail('A participating source bundle is missing.');
  await fs.mkdir(destinationDirectory, { recursive: true });
  const created = [];
  try {
    for (const item of prepared) {
      await fs.access(item.destination).then(() => fail('Import destination already exists.'), error => {
        if (error.code !== 'ENOENT') throw error;
      });
      await execute('git', ['clone', '--quiet', '--no-checkout', '--', item.file, item.destination],
        { env: gitEnvironment, timeout: 60_000, maxBuffer: 2_000_000 });
      created.push(item.destination);
      await git(item.destination, 'cat-file', '-e', `${item.artifact.commit}^{commit}`);
      await git(item.destination, 'checkout', '--quiet', '--detach', item.artifact.commit);
      if (await git(item.destination, 'rev-parse', 'HEAD') !== item.artifact.commit
        || await git(item.destination, 'status', '--porcelain=v1', '--untracked-files=all'))
        fail('Imported source does not match the reviewed clean commit.');
    }
  } catch (error) {
    for (const destination of created) await fs.rm(destination, { recursive: true, force: true });
    throw error;
  }
  return prepared.map(item => ({ projectId: item.artifact.projectId,
    resourceId: item.artifact.resourceId, root: item.destination, commit: item.artifact.commit }));
}
