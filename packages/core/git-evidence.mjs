import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

async function git(root, args) {
  const { stdout } = await execFileAsync("git", ["-C", path.resolve(root), ...args], { encoding: "utf8", timeout: 3000, maxBuffer: 2_000_000 });
  return stdout.trim();
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
    const changedFiles = status.split("\n").filter(Boolean).map((line) => line.slice(3)).slice(0, 250);
    return { available: true, root: repositoryRoot, commit, branch: branch || "detached", dirty: changedFiles.length > 0, changedFiles, capturedAt: new Date().toISOString() };
  } catch {
    return { available: false, root: resolvedRoot, commit: null, branch: null, dirty: null, changedFiles: [], capturedAt: new Date().toISOString() };
  }
}

export function compareGitEvidence(baseline, current) {
  if (!baseline?.available || !current?.available) return { status: "unavailable", stale: null, commitChanged: null, workingTreeChanged: null, changedFiles: current?.changedFiles ?? [] };
  const commitChanged = baseline.commit !== current.commit;
  const baselineFiles = new Set(baseline.changedFiles ?? []);
  const currentFiles = new Set(current.changedFiles ?? []);
  const workingTreeChanged = baselineFiles.size !== currentFiles.size || [...baselineFiles].some((file) => !currentFiles.has(file));
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
