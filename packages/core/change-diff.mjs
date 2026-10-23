import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

const execute = promisify(execFile);
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const validText = value => typeof value === 'string' && value.length > 0 && value.length <= 512 && !value.includes('\0');

// Read-only Git capture. No fetch, checkout, hook, dependency installation or
// repository mutation. Returned content is metadata, not raw source/patches.
export async function captureChangeDiff({ root, projectId, resourceId, baseRef,
  headRef, mode = 'working-tree', includeLineRanges = false,
  maxFiles = 250, maxBytes = 2_000_000, maxFileBytes = 2_000_000 } = {}) {
  if (![root, projectId, resourceId, baseRef].every(validText)
    || !['working-tree', 'staged', 'unstaged', 'commits'].includes(mode)
    || (mode === 'commits' ? !validText(headRef) : headRef !== undefined)
    || typeof includeLineRanges !== 'boolean'
    || !Number.isInteger(maxFiles) || maxFiles < 1 || maxFiles > 2000
    || !Number.isInteger(maxBytes) || maxBytes < 1024 || maxBytes > 16_000_000
    || !Number.isInteger(maxFileBytes) || maxFileBytes < 1 || maxFileBytes > 16_000_000) {
    throw new TypeError('A scoped root, explicit baseline, comparison mode and bounded capture limits are required.');
  }
  const requestedRoot = await fs.realpath(root);
  async function git(args) {
    const { stdout } = await execute('git', ['--no-pager', '-c', 'core.fsmonitor=false', '-C', requestedRoot, ...args], {
      encoding: 'utf8', timeout: 10_000, maxBuffer: maxBytes,
      env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' },
    });
    return stdout;
  }
  let repositoryRoot;
  try { repositoryRoot = await fs.realpath((await git(['rev-parse', '--show-toplevel'])).trim()); }
  catch { throw new Error('The selected source must be inside an accessible Git repository.'); }
  const relativeRoot = path.relative(repositoryRoot, requestedRoot);
  if (relativeRoot === '..' || relativeRoot.startsWith(`..${path.sep}`)) throw new Error('Source root escapes its repository.');
  const scope = relativeRoot ? [`:(top,literal)${relativeRoot.split(path.sep).join('/')}`] : [];
  const diffFlags = ['--no-ext-diff', '--no-textconv', '--ignore-submodules=none'];
  async function commit(ref) {
    try { return (await git(['rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`])).trim(); }
    catch { throw new Error('The selected revision cannot be resolved to a local commit. Fetch explicitly if needed.'); }
  }
  const baseCommit = await commit(baseRef);
  const headCommit = await commit(mode === 'commits' ? headRef : 'HEAD');
  if (mode === 'unstaged' && baseCommit !== headCommit) {
    throw new Error('Unstaged comparison uses the current HEAD as its baseline; select HEAD or use combined working changes.');
  }
  const comparisons = mode === 'commits' ? [baseCommit, headCommit] : mode === 'unstaged' ? [] : [baseCommit];
  const selectionFlags = mode === 'staged' ? ['--cached'] : [];
  const gaps = [];
  const limitFailure = error => error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' || error.killed
    ? 'Git output exceeded the capture budget or time limit.' : 'Git diff capture was unavailable.';
  async function boundedDiff(args) {
    try { return await git(['diff', ...diffFlags, ...args, '--', ...scope]); }
    catch (error) { gaps.push(limitFailure(error)); return null; }
  }
  async function untracked() {
    let names;
    try { names = (await git(['ls-files', '--full-name', '--others', '--exclude-standard', '-z', '--', ...scope])).split('\0').filter(Boolean); }
    catch (error) { gaps.push(limitFailure(error)); return { names: [], fingerprints: [] }; }
    const fingerprints = [];
    let capturedBytes = 0;
    for (const name of names.slice(0, maxFiles)) {
      const target = path.resolve(repositoryRoot, name);
      // Never follow a symlink (including a parent-directory symlink) outside
      // the selected source. A symlink itself is captured as link metadata.
      try {
        const parent = await fs.realpath(path.dirname(target));
        if (parent !== requestedRoot && !parent.startsWith(requestedRoot + path.sep)) {
          gaps.push('An untracked path is outside the selected source.'); continue;
        }
        const stat = await fs.lstat(target);
        if (stat.isSymbolicLink()) {
          fingerprints.push([name, 'symlink', hash(await fs.readlink(target))]); continue;
        }
        if (!stat.isFile() || stat.size > maxFileBytes || capturedBytes + stat.size > maxBytes) {
          gaps.push('An untracked file exceeds the capture budget or has unsupported content.'); continue;
        }
        const content = await fs.readFile(target);
        capturedBytes += content.length;
        fingerprints.push([name, 'file', hash(content)]);
      } catch { gaps.push('An untracked file could not be captured consistently.'); }
    }
    if (names.length > maxFiles) gaps.push('Untracked file inventory exceeds the file limit.');
    return { names, fingerprints };
  }
  async function snapshot() {
    const patch = await boundedDiff([...selectionFlags, '--binary', '--no-renames', ...comparisons]);
    if (mode === 'commits') return { fingerprint: patch === null ? null : hash(patch), dirty: false, untrackedNames: [] };
    if (mode === 'staged') {
      const index = await boundedDiff(['--cached', '--binary', '--no-renames', headCommit]);
      return { fingerprint: patch === null || index === null ? null : hash(JSON.stringify([patch, index])),
        dirty: Boolean(index), untrackedNames: [] };
    }
    if (mode === 'unstaged') {
      // The selected inventory is index-to-worktree, but a source pin must
      // also change when the index and worktree move together.
      const index = await boundedDiff(['--cached', '--binary', '--no-renames', headCommit]);
      return { fingerprint: patch === null || index === null ? null : hash(JSON.stringify([index, patch])),
        dirty: Boolean(index || patch), untrackedNames: [] };
    }
    const work = await boundedDiff(['--binary', '--no-renames', headCommit]);
    const index = await boundedDiff(['--cached', '--binary', '--no-renames', headCommit]);
    const files = await untracked();
    return { fingerprint: patch === null || work === null || index === null ? null
      : hash(JSON.stringify([patch, work, index, files.fingerprints])),
    dirty: Boolean(work || index || files.names.length), untrackedNames: files.names };
  }
  const before = await snapshot();
  const inventory = await boundedDiff([...selectionFlags, '--name-status', '-z', '--find-renames', ...comparisons]);
  const numstat = await boundedDiff([...selectionFlags, '--numstat', '-z', '--no-renames', ...comparisons]);
  const stats = new Map();
  for (const entry of (numstat ?? '').split('\0').filter(Boolean)) {
    const first = entry.indexOf('\t'), second = entry.indexOf('\t', first + 1);
    if (first < 0 || second < 0) { gaps.push('Git change statistics could not be parsed.'); continue; }
    const added = entry.slice(0, first), removed = entry.slice(first + 1, second);
    stats.set(entry.slice(second + 1), { binary: added === '-' || removed === '-',
      addedLines: added === '-' ? null : Number(added), removedLines: removed === '-' ? null : Number(removed) });
  }
  const fields = (inventory ?? '').split('\0');
  const files = [];
  for (let i = 0; i < fields.length && fields[i];) {
    const status = fields[i++], oldPath = fields[i++];
    if (!/^[ACDMRTUXB](?:\d+)?$/.test(status) || !oldPath) { gaps.push('Git change inventory could not be parsed.'); break; }
    const renamed = /^[RC]/.test(status);
    const newPath = renamed ? fields[i++] : oldPath;
    if (!newPath) { gaps.push('Git rename inventory is incomplete.'); break; }
    const details = stats.get(newPath) ?? stats.get(oldPath);
    files.push({ status: status[0], path: newPath, previousPath: renamed ? oldPath : null,
      binary: details?.binary ?? null, addedLines: details?.addedLines ?? null, removedLines: details?.removedLines ?? null });
    if (status[0] === 'U') gaps.push('Unmerged files require conflict resolution before assessment.');
  }
  for (const name of before.untrackedNames) files.push({ status: '?', path: name, previousPath: null,
    binary: null, addedLines: null, removedLines: null });
  if (files.length > maxFiles) gaps.push('Changed file inventory exceeds the file limit.');
  if (includeLineRanges) {
    const eligible = files.filter(file => ['M', 'A'].includes(file.status) && file.binary === false);
    if (eligible.length > 50) gaps.push('Changed-line extraction exceeds the 50-file limit.');
    let extractedBytes = 0;
    for (const file of eligible.slice(0, 50)) {
      try {
        if (file.status === 'M') {
          const baselineText = await git(['show', mode === 'unstaged' ? `:${file.path}` : `${baseCommit}:${file.path}`]);
          extractedBytes += Buffer.byteLength(baselineText, 'utf8');
          if (extractedBytes > maxBytes) { gaps.push('Changed-line extraction exceeded the capture byte budget.'); break; }
          file.baselineContentHash = hash(baselineText);
        }
        const patch = await git(['diff', ...diffFlags, ...selectionFlags, '--no-renames', '--unified=0',
          ...comparisons, '--', `:(top,literal)${file.path}`]);
        extractedBytes += Buffer.byteLength(patch, 'utf8');
        if (extractedBytes > maxBytes) { gaps.push('Changed-line extraction exceeded the capture byte budget.'); break; }
        const lineRanges = [...patch.matchAll(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/gm)]
          .map(match => ({ oldStart: Number(match[1]), oldLines: Number(match[2] ?? 1),
            newStart: Number(match[3]), newLines: Number(match[4] ?? 1) }));
        if (lineRanges.length > 200 || !lineRanges.length && (file.addedLines || file.removedLines)) {
          gaps.push('Changed-line extraction is incomplete for a selected path.');
        } else file.lineRanges = lineRanges;
      } catch (error) { gaps.push(limitFailure(error)); }
    }
  }
  const after = mode === 'commits' ? before : await snapshot();
  const currentHead = mode === 'commits' ? headCommit : await commit('HEAD');
  if (before.fingerprint !== after.fingerprint || currentHead !== headCommit) {
    gaps.push('Source changed while the diff was being captured; reassess before using the result.');
  }
  const complete = gaps.length === 0 && before.fingerprint !== null;
  return { schemaVersion: 1, projectId, resourceId, mode, baseCommit, headCommit,
    sourcePrefix: relativeRoot.split(path.sep).join('/'),
    dirty: before.dirty, diffComplete: complete,
    snapshotFingerprint: complete ? `sha256:${before.fingerprint}` : null,
    revisionPin: complete ? { projectId, resourceId, commit: headCommit, dirty: before.dirty,
      workingTreeFingerprint: before.dirty ? `sha256:${before.fingerprint}` : null } : null,
    files: files.slice(0, maxFiles), totalChangedFiles: files.length, gaps: [...new Set(gaps)],
    coverage: 'This captures a scoped Git diff; dependency discovery, impact confirmation and verification have not executed.' };
}
