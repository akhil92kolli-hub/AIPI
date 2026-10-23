#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { buildProjectKnowledgeGraph, traverseKnowledgeGraph } from "../packages/core/knowledge-graph.mjs";
import { ensureTaskVerificationPlan, executeTaskVerificationPlan, projectGitRevision } from "../packages/core/verification-runner.mjs";
import { executeLinkedTestCommand, executeSaved } from "./dashboard-server.mjs";
import { executeRequest } from "./api-forge-server.mjs";
import { loadState, mutateState } from "./workspace-store.mjs";

const execFileAsync = promisify(execFile);
const hash = (value, length = 16) => crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, length);

export function parseVerifyArgs(argv = process.argv.slice(2)) {
  const options = { project: null, files: [], changed: false, approveStateChangingReplays: false };
  if (process.env.AIPI_RECEIPT_OUTPUT) options.receiptOutput = process.env.AIPI_RECEIPT_OUTPUT;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--project") options.project = argv[++index] ?? null;
    else if (argument === "--files") options.files.push(...String(argv[++index] ?? "").split(",").map((entry) => entry.trim()).filter(Boolean));
    else if (argument === "--changed") options.changed = true;
    else if (argument === "--approve-state-changing-replays") options.approveStateChangingReplays = true;
    else if (argument === "--receipt-output") options.receiptOutput = argv[++index] ?? null;
    else if (["--help", "-h"].includes(argument)) options.help = true;
    else throw new Error(`Unknown argument: ${argument}`);
  }
  if (!options.files.length) options.changed = true;
  return options;
}

function repositoryRoot(project) {
  return project.gitBinding?.repositoryRoot
    ?? project.sourceContext?.roots?.find((entry) => entry.kind === "workspace")?.path
    ?? project.sourceContext?.roots?.[0]?.path
    ?? process.cwd();
}

export async function changedFilesForProject(project) {
  const root = repositoryRoot(project);
  try {
    const { stdout } = await execFileAsync("git", ["diff", "--name-only", "HEAD"], { cwd: root, encoding: "utf8", maxBuffer: 2_000_000 });
    return stdout.split(/\r?\n/).map((entry) => entry.trim()).filter(Boolean);
  } catch (error) {
    throw new Error(`Unable to detect changed files in ${root}: ${error.stderr || error.message}`);
  }
}

const comparablePath = (value) => String(value ?? "").replaceAll("\\", "/").replace(/^\.\//, "").replace(/\/$/, "");

function pathVariants(file, root) {
  const normalized = comparablePath(file);
  const absolute = comparablePath(path.isAbsolute(file) ? path.resolve(file) : path.resolve(root, file));
  const relative = comparablePath(path.relative(root, absolute));
  return new Set([normalized, absolute, relative]);
}

function nodeMatchesFile(node, variants, root) {
  for (const source of [node.source, node.detail, node.file].filter(Boolean)) {
    const clean = comparablePath(String(source).split(":").slice(0, -1).join(":") || source);
    const sourceVariants = pathVariants(clean, node.root ?? root);
    if ([...sourceVariants].some((candidate) => variants.has(candidate))) return true;
    if ([...variants].some((candidate) => candidate.endsWith(`/${clean}`) || clean.endsWith(`/${candidate}`))) return true;
  }
  return false;
}

export function impactedContractsForFiles(project, files = [], { depth = 5 } = {}) {
  buildProjectKnowledgeGraph(project, {
    pinnedEdges: project.knowledgeGraph?.pinnedEdges ?? [],
    runtimeEdges: project.knowledgeGraph?.edges?.filter((edge) => edge.provenance === "runtime") ?? [],
    rejectedEdgeIds: project.knowledgeGraph?.rejectedEdgeIds ?? []
  });
  const root = repositoryRoot(project);
  const graph = project.knowledgeGraph;
  const impactedIds = new Set();
  const matchedNodes = [];
  for (const file of files) {
    const variants = pathVariants(file, root);
    for (const node of graph.nodes ?? []) {
      if (!nodeMatchesFile(node, variants, root)) continue;
      matchedNodes.push(node);
      if (node.type === "contract") impactedIds.add(node.contractId ?? node.id);
      const traversal = traverseKnowledgeGraph(project, { nodeId: node.id, direction: "both", depth, minConfidence: 0.5 });
      for (const candidate of [traversal.focusNode, ...traversal.upstreamNodes, ...traversal.downstreamNodes].filter(Boolean)) {
        if (candidate.type === "contract") impactedIds.add(candidate.contractId ?? candidate.id);
      }
    }
    for (const contract of project.contracts ?? []) {
      if (nodeMatchesFile({ source: contract.implementation?.source, root: contract.implementation?.root }, variants, root)) impactedIds.add(contract.id);
    }
  }
  return {
    files: [...new Set(files.map(comparablePath))], matchedNodes: [...new Map(matchedNodes.map((node) => [node.id, node])).values()],
    contracts: (project.contracts ?? []).filter((contract) => impactedIds.has(contract.id))
  };
}

function verificationTask(project, contract) {
  project.tasks ??= [];
  const id = `task_verify_${hash([project.id, contract.id])}`;
  let task = project.tasks.find((entry) => entry.id === id);
  if (!task) {
    const now = new Date().toISOString();
    task = {
      id, projectId: project.id, title: `Impact verification · ${contract.method} ${contract.route}`,
      description: "Automatically generated by aipi-verify for revision-linked impact-radius verification.",
      diagnosis: "A linked implementation file changed and requires contract replay and schema verification.",
      source: "impact-radius-cli", status: "active", category: "verification", priority: "high",
      contractIds: [contract.id], requestIds: contract.sourceRequestIds ?? [], artifactIds: contract.sourceArtifactIds ?? [],
      findingIds: [], evidenceIds: [], runtimeEvidenceIds: [], verificationReceiptIds: [], verificationRunIds: [],
      acceptanceCriteria: ["Replay the impacted saved request.", "Verify zero unresolved contract drift.", "Persist a receipt at the current Git revision."],
      createdAt: now, updatedAt: now
    };
    project.tasks.push(task);
  }
  task.contractIds = [contract.id];
  return task;
}

const cell = (value) => String(value ?? "—").replaceAll("|", "\\|").replace(/\r?\n/g, " ");

export function formatReceiptTable(rows = []) {
  const header = "| Contract | Method / Path | Git Revision | Replay Status | Schema Drift | Receipt ID |";
  const divider = "|---|---|---|---|---|---|";
  const body = rows.map((row) => `| ${cell(row.contract)} | ${cell(row.methodPath)} | ${cell(row.gitRevision)} | ${cell(row.replayStatus)} | ${cell(row.schemaDrift)} | ${cell(row.receiptId)} |`);
  return [header, divider, ...body].join("\n");
}

export function verificationExitCode(rows = []) {
  return rows.some((row) => row.receiptResult === "Failed" || row.contractState === "Regressed") ? 1 : 0;
}

export async function runImpactVerification(options) {
  const initial = await loadState();
  const selected = initial.projects.find((project) => project.id === options.project || project.name === options.project)
    ?? (!options.project ? initial.projects.find((project) => project.id === initial.activeProjectId) : null);
  if (!selected) throw new Error(options.project ? `Project not found: ${options.project}` : "No active project is available.");
  const files = options.files.length ? options.files : await changedFilesForProject(selected);
  const rows = [];
  let impact = { files, matchedNodes: [], contracts: [] };

  await mutateState(async (state) => {
    const project = state.projects.find((entry) => entry.id === selected.id);
    if (!project) throw new Error(`Project disappeared while verification was starting: ${selected.id}`);
    impact = impactedContractsForFiles(project, files);
    for (const contract of impact.contracts) {
      const task = verificationTask(project, contract);
      const plan = ensureTaskVerificationPlan(project, task);
      const execution = await executeTaskVerificationPlan(project, task, {
        approveStateChangingReplays: options.approveStateChangingReplays,
        targetSnapshotHash: options.approveStateChangingReplays ? plan.targetSnapshotHash : undefined,
        executeApiReplay: (savedRequest) => executeSaved(executeRequest, project, savedRequest, { maxAttempts: 1 }),
        executeTestCommand: (command) => executeLinkedTestCommand(project, command)
      });
      const replay = execution.checkResults.find((entry) => entry.type === "api-replay");
      const diff = execution.checkResults.find((entry) => entry.type === "contract-diff");
      rows.push({
        contract: contract.name ?? contract.id, methodPath: `${contract.method} ${contract.route}`,
        gitRevision: execution.receipt.sourceRevision ?? projectGitRevision(project), replayStatus: replay?.status ?? "not planned",
        schemaDrift: diff?.status ?? "not planned", receiptId: execution.receipt.id,
        receiptResult: execution.receipt.result, contractState: contract.state
      });
    }
  });
  return { projectId: selected.id, impact, rows, exitCode: verificationExitCode(rows) };
}

function usage() {
  return `Usage: npm run aipi:verify -- --project <id> [--changed | --files file1,file2] [--receipt-output aipi-receipt.md] [--approve-state-changing-replays]\n\nThe receipt is also appended to GITHUB_STEP_SUMMARY when available. State-changing requests against non-local environments remain pending unless explicit approval is supplied.`;
}

export async function main(argv = process.argv.slice(2)) {
  try {
    const options = parseVerifyArgs(argv);
    if (options.help) { process.stdout.write(`${usage()}\n`); return 0; }
    const result = await runImpactVerification(options);
    process.stdout.write(`Impact-radius verification for ${result.projectId}\n\n`);
    process.stdout.write(`Changed files: ${result.impact.files.length}\nImpacted contracts: ${result.impact.contracts.length}\n\n`);
    if (result.rows.length) {
      const receipt = `## AIPI Verification Receipt\n\n${formatReceiptTable(result.rows)}\n\nSource: revision-linked local evidence; secret-bearing headers and payload fields remain redacted.\n`;
      process.stdout.write(`${formatReceiptTable(result.rows)}\n`);
      const destinations = [...new Set([options.receiptOutput, process.env.GITHUB_STEP_SUMMARY].filter(Boolean))];
      await Promise.all(destinations.map(async (destination) => {
        await fs.mkdir(path.dirname(path.resolve(destination)), { recursive: true });
        await fs.appendFile(destination, `${receipt}\n`, "utf8");
      }));
      if (process.env.GITHUB_OUTPUT) await fs.appendFile(process.env.GITHUB_OUTPUT, `receipt_status=${result.exitCode ? "failed" : "passed"}\ncontracts_touched=${result.rows.length}\n`, "utf8");
    }
    else process.stdout.write("No contracts were found in the changed-file impact radius.\n");
    return result.exitCode;
  } catch (error) {
    process.stderr.write(`aipi-verify: ${error.message}\n`);
    return 2;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = await main();
