import { execFile } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

async function git(root, args) {
  const { stdout } = await execFileAsync("git", ["-C", path.resolve(root), ...args], { encoding: "utf8", timeout: 3000, maxBuffer: 2_000_000 });
  return stdout.trim();
}

function invalid(message) {
  return Object.assign(new Error(message), { statusCode: 400, code: "INVALID_ARGUMENT" });
}

function validateRemoteName(value) {
  const name = String(value ?? "origin").trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(name)) throw invalid("Remote name may contain letters, numbers, dots, underscores and hyphens");
  return name;
}

async function validateBranch(root, value) {
  const branch = String(value ?? "").trim();
  if (!branch || branch.length > 240) throw invalid("Enter a target branch");
  try { await git(root, ["check-ref-format", "--branch", branch]); }
  catch { throw invalid("Enter a valid Git branch name"); }
  return branch;
}

function validateRepositoryUrl(value) {
  const repositoryUrl = String(value ?? "").trim();
  if (!repositoryUrl) return "";
  if (/^git@github\.com:[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:\.git)?$/.test(repositoryUrl)) return repositoryUrl;
  let parsed;
  try { parsed = new URL(repositoryUrl); } catch { throw invalid("Use a GitHub HTTPS or SSH repository URL"); }
  if (parsed.protocol !== "https:" || parsed.hostname.toLowerCase() !== "github.com" || parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw invalid("Use a credential-free github.com HTTPS or SSH repository URL");
  }
  if (!/^\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:\.git)?\/?$/.test(parsed.pathname)) throw invalid("Use a GitHub repository URL with an owner and repository name");
  return repositoryUrl.replace(/\/$/, "");
}

async function repositoryRoot(root) {
  try { return await git(root, ["rev-parse", "--show-toplevel"]); }
  catch { throw Object.assign(new Error("The selected source is not inside a Git repository"), { statusCode: 409, code: "GIT_NOT_FOUND" }); }
}

async function remoteEntries(root) {
  const names = (await git(root, ["remote"])).split("\n").filter(Boolean);
  const entries = [];
  for (const name of names) {
    const [fetchUrl, pushUrl] = await Promise.all([
      git(root, ["remote", "get-url", name]).catch(() => ""),
      git(root, ["remote", "get-url", "--push", name]).catch(() => ""),
    ]);
    entries.push({ name, fetchUrl, pushUrl: pushUrl || fetchUrl });
  }
  return entries;
}

export async function captureGitEvidence(root) {
  const resolvedRoot = path.resolve(root);
  try {
    const repositoryRoot = await git(resolvedRoot, ["rev-parse", "--show-toplevel"]);
    const [commit, branch, status] = await Promise.all([
      git(repositoryRoot, ["rev-parse", "HEAD"]),
      git(repositoryRoot, ["branch", "--show-current"]),
      git(repositoryRoot, ["status", "--porcelain=v1", "--untracked-files=normal"])
    ]);
    const rawStatusLines = status.split("\n").filter(Boolean);
    const isInternalAipiPath = (rel) => /(?:^|\/)(?:\.api-forge|\.aipi)(?:\/|$)/.test(rel);
    const statusLines = rawStatusLines.filter((line) => !isInternalAipiPath(line.slice(3).split(" -> ").at(-1)));
    const changedFiles = statusLines.map((line) => line.slice(3).split(" -> ").at(-1)).slice(0, 250);
    const fingerprints = [];
    for (const relative of changedFiles) {
      const target = path.resolve(repositoryRoot, relative);
      try {
        const stats = await fs.stat(target);
        if (!stats.isFile()) continue;
        const content = stats.size <= 2_000_000 ? await fs.readFile(target) : Buffer.from(`${stats.size}:${stats.mtimeMs}`);
        fingerprints.push(`${relative}:${crypto.createHash("sha256").update(content).digest("hex")}`);
      } catch { fingerprints.push(`${relative}:deleted`); }
    }
    const workingTreeFingerprint = crypto.createHash("sha256").update([statusLines.join("\n"), ...fingerprints].join("\n")).digest("hex");
    return { available: true, root: repositoryRoot, commit, branch: branch || "detached", dirty: changedFiles.length > 0, changedFiles, workingTreeFingerprint, capturedAt: new Date().toISOString() };
  } catch {
    return { available: false, root: resolvedRoot, commit: null, branch: null, dirty: null, changedFiles: [], capturedAt: new Date().toISOString() };
  }
}

export async function inspectGitBinding(root, binding = {}) {
  const repository = await repositoryRoot(root);
  const evidence = await captureGitEvidence(repository);
  const remotes = await remoteEntries(repository);
  const remoteName = validateRemoteName(binding.remoteName || "origin");
  const selectedRemote = remotes.find((entry) => entry.name === remoteName) ?? null;
  const targetBranch = await validateBranch(repository, binding.targetBranch || evidence.branch || "main");
  let upstream = "";
  try { upstream = await git(repository, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"]); } catch {}
  let ahead = null;
  let behind = null;
  if (selectedRemote) {
    try {
      const counts = await git(repository, ["rev-list", "--left-right", "--count", `${remoteName}/${targetBranch}...HEAD`]);
      [behind, ahead] = counts.split(/\s+/).map(Number);
    } catch {}
  }
  return { ...evidence, repositoryRoot: repository, remotes, remoteName, selectedRemote, targetBranch, upstream, ahead, behind };
}

// Query the remote ref without fetch, pull, push, credential prompts or worktree writes.
export async function inspectRemoteGitSync(root,binding={}, {readRemote}={}) {
  const inspection=await inspectGitBinding(root,binding);
  const remote=inspection.selectedRemote?.fetchUrl;
  const checkedAt=new Date().toISOString();
  const result={status:"unknown",dirty:inspection.dirty,localCommit:inspection.commit,remoteCommit:null,branch:inspection.targetBranch,checkedAt};
  if(!remote)return {...result,reason:"No configured remote for this source"};
  validateRepositoryUrl(remote);
  try{
    const {stdout}=readRemote?{stdout:await readRemote({root:inspection.repositoryRoot,remote,branch:inspection.targetBranch})}:await execFileAsync("git",["-C",inspection.repositoryRoot,"ls-remote","--heads",remote,`refs/heads/${inspection.targetBranch}`],{
      encoding:"utf8",timeout:10000,maxBuffer:100000,env:{...process.env,GIT_TERMINAL_PROMPT:"0",GIT_SSH_COMMAND:"ssh -oBatchMode=yes -oConnectTimeout=5",GCM_INTERACTIVE:"never"},
    });
    const remoteCommit=stdout.trim().split(/\s+/)[0];
    if(!/^[a-f0-9]{40}$/.test(remoteCommit))return {...result,reason:"Remote branch is unavailable"};
    result.remoteCommit=remoteCommit;
    if(remoteCommit===inspection.commit)return {...result,status:"up_to_date"};
    try{
      const counts=await git(inspection.repositoryRoot,["rev-list","--left-right","--count",`${remoteCommit}...HEAD`]);
      const [behind,ahead]=counts.split(/\s+/).map(Number);
      return {...result,status:behind&&ahead?"diverged":behind?"behind":"ahead",ahead,behind};
    }catch{return {...result,status:"different",reason:"Fetch the remote in your IDE to compare history"};}
  }catch{return {...result,reason:"Remote check failed; authenticate Git in your IDE and retry"};}
}

export async function configureGitBinding(root, input = {}) {
  const repository = await repositoryRoot(root);
  const remoteName = validateRemoteName(input.remoteName || "origin");
  const targetBranch = await validateBranch(repository, input.targetBranch);
  const repositoryUrl = validateRepositoryUrl(input.repositoryUrl);
  const remotes = await remoteEntries(repository);
  const existing = remotes.find((entry) => entry.name === remoteName);
  if (!existing && !repositoryUrl) throw invalid("Enter a GitHub repository URL for the new remote");
  if (!existing) await git(repository, ["remote", "add", remoteName, repositoryUrl]);
  else if (repositoryUrl && ![existing.fetchUrl, existing.pushUrl].includes(repositoryUrl)) {
    throw Object.assign(new Error(`${remoteName} already points to ${existing.pushUrl || existing.fetchUrl}. Use another remote name or update it with Git before saving.`), { statusCode: 409, code: "REMOTE_CONFLICT" });
  }
  const inspected = await inspectGitBinding(repository, { remoteName, targetBranch });
  return { root: repository, remoteName, repositoryUrl: inspected.selectedRemote?.pushUrl || inspected.selectedRemote?.fetchUrl || repositoryUrl, targetBranch, updatedAt: new Date().toISOString(), status: "configured", inspection: inspected };
}

export async function planGitPublish(root, binding = {}) {
  const inspected = await inspectGitBinding(root, binding);
  if (!inspected.selectedRemote) throw Object.assign(new Error(`Git remote ${inspected.remoteName} is not configured`), { statusCode: 409, code: "REMOTE_NOT_FOUND" });
  const remoteRef = `refs/remotes/${inspected.remoteName}/${inspected.targetBranch}`;
  let targetExists = true;
  try { await git(inspected.repositoryRoot, ["show-ref", "--verify", "--quiet", remoteRef]); }
  catch { targetExists = false; }
  let outgoingCount = 0;
  let outgoingCommits = [];
  if (targetExists) {
    outgoingCount = Number(await git(inspected.repositoryRoot, ["rev-list", "--count", `${remoteRef}..HEAD`])) || 0;
    const log = await git(inspected.repositoryRoot, ["log", "--format=%H%x09%s", "-n", "20", `${remoteRef}..HEAD`]);
    outgoingCommits = log.split("\n").filter(Boolean).map((line) => { const [commit, ...subject] = line.split("\t"); return { commit, subject: subject.join("\t") }; });
  } else {
    outgoingCount = Number(await git(inspected.repositoryRoot, ["rev-list", "--count", "HEAD"])) || 0;
    const log = await git(inspected.repositoryRoot, ["log", "--format=%H%x09%s", "-n", "20", "HEAD"]);
    outgoingCommits = log.split("\n").filter(Boolean).map((line) => { const [commit, ...subject] = line.split("\t"); return { commit, subject: subject.join("\t") }; });
  }
  return {
    root: inspected.repositoryRoot,
    remoteName: inspected.remoteName,
    repositoryUrl: inspected.selectedRemote.pushUrl || inspected.selectedRemote.fetchUrl,
    targetBranch: inspected.targetBranch,
    commit: inspected.commit,
    currentBranch: inspected.branch,
    dirty: inspected.dirty,
    changedFiles: inspected.changedFiles,
    targetExists,
    outgoingCount,
    outgoingCommits,
    canPublish: !inspected.dirty && outgoingCount > 0,
    blockingReason: inspected.dirty ? "Commit or discard local working tree changes before publishing" : outgoingCount === 0 ? "No committed changes are waiting to publish" : null,
  };
}

export async function publishGitHead(root, binding = {}, expectedCommit) {
  const plan = await planGitPublish(root, binding);
  if (!expectedCommit || expectedCommit !== plan.commit) throw Object.assign(new Error("The repository changed after the publish review. Refresh the plan before publishing."), { statusCode: 409, code: "REVISION_CHANGED" });
  if (!plan.canPublish) throw Object.assign(new Error(plan.blockingReason), { statusCode: 409, code: "PUBLISH_BLOCKED" });
  const { stdout, stderr } = await execFileAsync("git", ["-C", plan.root, "push", "--porcelain", "--", plan.remoteName, `HEAD:refs/heads/${plan.targetBranch}`], { encoding: "utf8", timeout: 120000, maxBuffer: 2_000_000 });
  return { ...plan, publishedAt: new Date().toISOString(), output: `${stdout}\n${stderr}`.trim() };
}

export function compareGitEvidence(baseline, current) {
  if (!baseline?.available || !current?.available) return { status: "unavailable", stale: null, commitChanged: null, workingTreeChanged: null, changedFiles: current?.changedFiles ?? [] };
  const commitChanged = baseline.commit !== current.commit;
  const baselineFiles = new Set(baseline.changedFiles ?? []);
  const currentFiles = new Set(current.changedFiles ?? []);
  const fileSetChanged = baselineFiles.size !== currentFiles.size || [...baselineFiles].some((file) => !currentFiles.has(file));
  const workingTreeChanged = baseline.workingTreeFingerprint && current.workingTreeFingerprint
    ? baseline.workingTreeFingerprint !== current.workingTreeFingerprint
    : fileSetChanged;
  return { status: commitChanged || workingTreeChanged ? "stale" : "current", stale: commitChanged || workingTreeChanged, commitChanged, workingTreeChanged, changedFiles: current.changedFiles ?? [], baselineCommit: baseline.commit, currentCommit: current.commit, branch: current.branch };
}

export async function projectGitFreshness(sourceContext = {}) {
  const baselines = sourceContext.git ?? [];
  const roots = sourceContext.roots ?? [];
  const reports = [];
  for (const root of roots) {
    const current = await captureGitEvidence(root.path);
    const baseline = baselines.find((entry) => path.resolve(entry.root) === path.resolve(current.root) || path.resolve(entry.requestedRoot ?? entry.root) === path.resolve(root.path));
    reports.push({ root: root.path, baseline: baseline ?? null, current, comparison: compareGitEvidence(baseline, current) });
  }
  const comparable = reports.filter((entry) => entry.comparison.status !== "unavailable");
  return { status: comparable.some((entry) => entry.comparison.stale) ? "stale" : comparable.length ? "current" : "unavailable", checkedAt: new Date().toISOString(), roots: reports };
}
