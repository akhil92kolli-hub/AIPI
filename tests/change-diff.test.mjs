import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { captureChangeDiff } from '../packages/core/change-diff.mjs';

const execute = promisify(execFile);
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aipi-change-diff-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const git = async (...args) => (await execute('git', ['-C', root, ...args])).stdout.trim();
  await git('init', '-q'); await git('config', 'user.name', 'AIPI fixture'); await git('config', 'user.email', 'fixture@example.test');
  await git('config', 'commit.gpgsign', 'false'); await git('config', 'core.autocrlf', 'false');
  await fs.writeFile(path.join(root, 'orders.py'), 'total = 100\n');
  await fs.writeFile(path.join(root, 'removed.py'), 'obsolete = True\n');
  await fs.mkdir(path.join(root, 'frontend'));
  await fs.writeFile(path.join(root, 'frontend', 'checkout.ts'), 'const total = 100;\n');
  await git('add', '.'); await git('commit', '-qm', 'baseline');
  const base = await git('rev-parse', 'HEAD');
  const capture = options => captureChangeDiff({ root, projectId: 'orders', resourceId: 'repository', baseRef: base, ...options });
  return { root, git, base, capture };
}

test('explicit commit comparison captures rename, deletion, binary and unusual names without patch content', async t => {
  const { root, git, base, capture } = await fixture(t);
  await git('mv', 'orders.py', 'renamed orders.py'); await git('rm', 'removed.py');
  await fs.writeFile(path.join(root, 'odd\tname\n.py'), 'flag = True\n');
  await fs.writeFile(path.join(root, 'binary.dat'), Buffer.from([0, 1, 2, 0, 4]));
  await git('add', '.'); await git('commit', '-qm', 'change');
  const head = await git('rev-parse', 'HEAD');
  const result = await capture({ mode: 'commits', headRef: head });
  assert.equal(result.baseCommit, base); assert.equal(result.headCommit, head);
  assert.equal(result.diffComplete, true); assert.equal(result.dirty, false);
  assert.equal(result.files.find(f => f.path === 'renamed orders.py').previousPath, 'orders.py');
  assert.equal(result.files.find(f => f.path === 'removed.py').status, 'D');
  assert.equal(result.files.find(f => f.path === 'binary.dat').binary, true);
  assert.ok(result.files.some(f => f.path === 'odd\tname\n.py'));
  assert.doesNotMatch(JSON.stringify(result), /flag = True|obsolete = True|total = 100/);
  assert.equal(await git('rev-parse', 'HEAD'), head);
});

test('staged, unstaged, untracked, deleted and same-commit edits affect the snapshot', async t => {
  const { root, git, capture } = await fixture(t);
  const clean = await capture(); assert.equal(clean.dirty, false); assert.equal(clean.files.length, 0);
  await fs.writeFile(path.join(root, 'orders.py'), 'total = "100"\n'); await git('add', 'orders.py');
  const staged = await capture(); assert.equal(staged.dirty, true);
  assert.notEqual(staged.snapshotFingerprint, clean.snapshotFingerprint);
  await fs.writeFile(path.join(root, 'orders.py'), 'total = "200"\n');
  const unstaged = await capture(); assert.notEqual(unstaged.snapshotFingerprint, staged.snapshotFingerprint);
  await fs.writeFile(path.join(root, 'new.py'), 'marker = 1\n');
  const untracked = await capture(); assert.ok(untracked.files.some(f => f.status === '?' && f.path === 'new.py'));
  await fs.writeFile(path.join(root, 'new.py'), 'marker = 2\n');
  assert.notEqual((await capture()).snapshotFingerprint, untracked.snapshotFingerprint);
  await fs.unlink(path.join(root, 'removed.py'));
  assert.equal((await capture()).files.find(f => f.path === 'removed.py').status, 'D');
  assert.equal((await capture()).headCommit, clean.headCommit);
});

test('staged comparison excludes unstaged and untracked edits, then invalidates when the index changes', async t => {
  const { root, git, capture } = await fixture(t);
  await fs.writeFile(path.join(root, 'orders.py'), 'total = 200\n');
  await git('add', 'orders.py');
  const staged = await capture({ mode: 'staged' });
  assert.deepEqual(staged.files.map(file => file.path), ['orders.py']);
  assert.equal(staged.dirty, true);
  await fs.writeFile(path.join(root, 'orders.py'), 'total = 300\n');
  await fs.writeFile(path.join(root, 'untracked.py'), 'new = True\n');
  const unchangedIndex = await capture({ mode: 'staged' });
  assert.deepEqual(unchangedIndex.files, staged.files);
  assert.equal(unchangedIndex.snapshotFingerprint, staged.snapshotFingerprint);
  const combined = await capture();
  assert.ok(combined.files.some(file => file.path === 'untracked.py'));
  assert.notEqual(combined.snapshotFingerprint, staged.snapshotFingerprint);
  await git('add', 'orders.py');
  const updatedIndex = await capture({ mode: 'staged' });
  assert.notEqual(updatedIndex.snapshotFingerprint, staged.snapshotFingerprint);
  await git('reset', '-q', 'HEAD', '--', 'orders.py');
  const cleanIndex = await capture({ mode: 'staged' });
  assert.deepEqual(cleanIndex.files, []);
  assert.equal(cleanIndex.dirty, false);
});

test('unstaged comparison excludes the index and untracked files while pinning the whole tracked source state', async t => {
  const { root, git, base, capture } = await fixture(t);
  await fs.writeFile(path.join(root, 'orders.py'), 'total = 200\n');
  await git('add', 'orders.py');
  await fs.writeFile(path.join(root, 'orders.py'), 'total = 300\n');
  await fs.writeFile(path.join(root, 'untracked.py'), 'new = True\n');
  const unstaged = await capture({ mode: 'unstaged' });
  assert.deepEqual(unstaged.files.map(file => file.path), ['orders.py']);
  assert.equal(unstaged.dirty, true);
  assert.equal(unstaged.revisionPin.workingTreeFingerprint, unstaged.snapshotFingerprint);
  assert.ok(!(await capture({ mode: 'staged' })).files.some(file => file.path === 'untracked.py'));
  await fs.writeFile(path.join(root, 'orders.py'), 'total = 400\n');
  const changedWorktree = await capture({ mode: 'unstaged' });
  assert.notEqual(changedWorktree.snapshotFingerprint, unstaged.snapshotFingerprint);
  await git('add', 'orders.py');
  const noUnstagedChanges = await capture({ mode: 'unstaged' });
  assert.deepEqual(noUnstagedChanges.files, []);
  assert.equal(noUnstagedChanges.dirty, true, 'the tracked source is still dirty relative to HEAD');
  assert.notEqual(noUnstagedChanges.snapshotFingerprint, changedWorktree.snapshotFingerprint);
  await git('commit', '-qm', 'advance HEAD');
  await assert.rejects(capture({ mode: 'unstaged', baseRef: base }), /current HEAD/);
});

test('unstaged fingerprint changes when staged and working copies move together but the selected patch does not', async t => {
  const { root, git, capture } = await fixture(t);
  await fs.writeFile(path.join(root, 'two.py'), 'first = 1\nsecond = 1\n');
  await git('add', 'two.py'); await git('commit', '-qm', 'two-line fixture');
  await fs.writeFile(path.join(root, 'two.py'), 'first = 2\nsecond = 1\n');
  await git('add', 'two.py');
  await fs.writeFile(path.join(root, 'two.py'), 'first = 2\nsecond = 2\n');
  const first = await capture({ mode: 'unstaged', baseRef: 'HEAD' });
  assert.deepEqual(first.files.map(file => file.path), ['two.py']);
  await fs.writeFile(path.join(root, 'two.py'), 'first = 3\nsecond = 1\n');
  await git('add', 'two.py');
  await fs.writeFile(path.join(root, 'two.py'), 'first = 3\nsecond = 2\n');
  const second = await capture({ mode: 'unstaged', baseRef: 'HEAD' });
  assert.deepEqual(second.files, first.files);
  assert.notEqual(second.snapshotFingerprint, first.snapshotFingerprint);
});

test('optional changed-line metadata captures hunk locations without returning patch content', async t => {
  const { root, capture } = await fixture(t);
  await fs.writeFile(path.join(root, 'orders.py'), 'total = 100\nchanged = "private-value"\n');
  const result = await capture({ includeLineRanges: true });
  const file = result.files.find(item => item.path === 'orders.py');
  assert.equal(result.diffComplete, true);
  assert.deepEqual(file.lineRanges, [{ oldStart: 1, oldLines: 0, newStart: 2, newLines: 1 }]);
  assert.equal(file.baselineContentHash, 'c7568fa5438ca9ee794c032f308477c9eb75f1828e15193fb29236ab942d5f42');
  assert.doesNotMatch(JSON.stringify(result), /private-value|total =/);
});

test('changed-line baseline hashes follow the commit for staged changes and the index for unstaged changes', async t => {
  const { root, git, capture } = await fixture(t);
  await fs.writeFile(path.join(root, 'orders.py'), 'total = 200\n');
  await git('add', 'orders.py');
  await fs.writeFile(path.join(root, 'orders.py'), 'total = 300\n');
  const staged = await capture({ mode: 'staged', includeLineRanges: true });
  const unstaged = await capture({ mode: 'unstaged', includeLineRanges: true });
  assert.equal(staged.files[0].baselineContentHash,
    crypto.createHash('sha256').update('total = 100\n').digest('hex'));
  assert.equal(unstaged.files[0].baselineContentHash,
    crypto.createHash('sha256').update('total = 200\n').digest('hex'));
  assert.notEqual(staged.files[0].baselineContentHash, unstaged.files[0].baselineContentHash);
});

test('a project subdirectory excludes changes and untracked source in sibling resources', async t => {
  const { root, capture } = await fixture(t);
  await fs.writeFile(path.join(root, 'orders.py'), 'total = "100"\n');
  await fs.writeFile(path.join(root, 'private-untracked.py'), 'secret = 1\n');
  const scoped = await capture({ root: path.join(root, 'frontend') });
  assert.equal(scoped.diffComplete, true); assert.equal(scoped.files.length, 0); assert.equal(scoped.dirty, false);
  await fs.writeFile(path.join(root, 'frontend', 'checkout.ts'), 'const total = 200;\n');
  const changed = await capture({ root: path.join(root, 'frontend') });
  assert.deepEqual(changed.files.map(f => f.path), ['frontend/checkout.ts']);
});

test('oversized inventories and untracked contents remain incomplete without a usable pin', async t => {
  const { root, capture } = await fixture(t);
  await fs.writeFile(path.join(root, 'a.py'), 'a = 1\n'); await fs.writeFile(path.join(root, 'b.py'), 'b = 1\n');
  const inventory = await capture({ maxFiles: 1 });
  assert.equal(inventory.diffComplete, false); assert.equal(inventory.revisionPin, null);
  assert.equal(inventory.files.length, 1); assert.ok(inventory.totalChangedFiles > 1);
  const content = await capture({ maxFileBytes: 2 });
  assert.equal(content.diffComplete, false); assert.equal(content.snapshotFingerprint, null);
});

test('untracked symlinks are hashed as links and external content never enters the result', async t => {
  const { root, capture } = await fixture(t);
  const outside = path.join(os.tmpdir(), `aipi-outside-${path.basename(root)}`);
  t.after(() => fs.rm(outside, { force: true }));
  await fs.writeFile(outside, 'outside-sensitive-value'); await fs.symlink(outside, path.join(root, 'link.py'));
  const first = await capture(); assert.equal(first.diffComplete, true);
  await fs.writeFile(outside, 'changed-sensitive-value');
  const second = await capture(); assert.equal(second.snapshotFingerprint, first.snapshotFingerprint);
  assert.doesNotMatch(JSON.stringify(second), /sensitive-value/);
});

test('invalid or option-like revisions cannot execute as Git options; commits mode ignores local dirt', async t => {
  const { root, base, capture } = await fixture(t);
  await assert.rejects(capture({ baseRef: '--help' }), /cannot be resolved/);
  await assert.rejects(capture({ mode: 'commits' }), TypeError);
  await assert.rejects(capture({ headRef: base }), TypeError);
  await fs.writeFile(path.join(root, 'orders.py'), 'total = "dirty"\n');
  const result = await capture({ mode: 'commits', headRef: base });
  assert.equal(result.dirty, false); assert.equal(result.files.length, 0); assert.equal(result.diffComplete, true);
});
