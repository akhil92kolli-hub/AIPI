import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const revisionFor = (project) => project.sourceContext?.gitRevision ?? project.sourceContext?.git?.find((entry) => entry.commit)?.commit ?? "working-tree";
const repositoryRoot = (project) => project.sourceContext?.roots?.find((entry) => entry.kind === "workspace")?.path ?? project.sourceContext?.roots?.[0]?.path;

async function workingTree(root) {
  if (!root) return { files: [], summary: "Repository root unavailable." };
  try {
    const [{ stdout: status }, { stdout: stat }] = await Promise.all([
      execFileAsync("git", ["status", "--porcelain=v1", "--untracked-files=all"], { cwd: root, maxBuffer: 512_000 }),
      execFileAsync("git", ["diff", "--stat", "--no-ext-diff"], { cwd: root, maxBuffer: 512_000 })
    ]);
    const files = status.split("\n").filter(Boolean).slice(0, 100).map((line) => ({ status: line.slice(0, 2).trim() || "M", path: line.slice(3).trim() }));
    return { files, summary: stat.trim().slice(0, 4000) || `${files.length} working-tree file${files.length === 1 ? "" : "s"} changed.` };
  } catch (error) {
    return { files: [], summary: `Git working tree unavailable: ${error.message}` };
  }
}

export async function buildCommitPack(project, task, options = {}) {
  const tree = options.workingTree ?? await workingTree(repositoryRoot(project));
  const contractIds = new Set(task.contractIds ?? []);
  const contracts = (project.contracts ?? []).filter((contract) => contractIds.has(contract.id)).map((contract) => ({ id: contract.id, method: contract.method, route: contract.route, state: contract.state ?? contract.comparisonState }));
  const evidenceIds = new Set([...(task.runtimeEvidenceIds ?? []), ...(task.evidenceIds ?? [])]);
  const evidence = (project.evidence ?? []).filter((entry) => evidenceIds.has(entry.id) || (entry.taskId === task.id && (!entry.contractId || contractIds.has(entry.contractId)))).slice(0, 12).map((entry) => ({ id: entry.id, type: entry.type, contractId: entry.contractId ?? null, result: entry.result?.passed ?? entry.result ?? null, sourceRevision: entry.sourceRevision }));
  const receipt = (project.verificationReceipts ?? []).find((entry) => (entry.result === "Verified" || entry.status === "passed") && (entry.taskId === task.id || contractIds.has(entry.contractId))) ?? null;
  const payload = { objective: task.title, sourceRevision: revisionFor(project), files: tree.files, diffSummary: tree.summary, contracts, evidence, verificationReceipt: receipt ? { id: receipt.id, result: receipt.result ?? receipt.status, sourceRevision: receipt.sourceRevision, verifiedAt: receipt.verifiedAt } : null };
  const prompt = [
    "Write one atomic commit message and a concise pull-request body from this bounded AIPI change pack.",
    "Do not claim checks that are absent. Cite the verification receipt and revision exactly when present.",
    JSON.stringify(payload)
  ].join("\n").slice(0, 6400);
  return { ...payload, prompt, estimatedTokens: Math.ceil(Buffer.byteLength(prompt, "utf8") / 4), tokenBudget: 1600, generatedAt: new Date().toISOString() };
}

