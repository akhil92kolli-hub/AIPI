import fs from "node:fs/promises";
import path from "node:path";
import { sanitizeEvidencePayload } from "./security-redactor.mjs";

export const TEAM_MEMORY_VERSION = 1;

function teamRoot(project) {
  const root = project.sourceContext?.roots?.find((entry) => entry.kind === "workspace")?.path ?? project.sourceContext?.roots?.[0]?.path;
  return root ? path.resolve(root) : null;
}

async function readJson(file, fallback) {
  try { return JSON.parse(await fs.readFile(file, "utf8")); }
  catch (error) { if (error.code === "ENOENT") return fallback; throw error; }
}

async function writeJson(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(sanitizeEvidencePayload(value), null, 2)}\n`, { mode: 0o600 });
  await fs.rename(temporary, file);
}

function repositoryRequest(request) {
  return {
    id: request.id,
    contractId: request.contractId ?? null,
    name: request.name,
    method: request.method,
    url: request.url,
    params: request.params ?? [],
    headers: (request.headers ?? []).map((entry) => /authorization|cookie|token|secret|api.?key/i.test(entry.key) ? { ...entry, value: "" } : entry),
    auth: request.auth?.type && request.auth.type !== "none" ? { type: request.auth.type, placement: request.auth.placement, key: request.auth.key } : { type: "none" },
    body: request.body ?? { type: "json", content: "" },
    assertions: request.assertions ?? [],
    baselineAssertions: request.baselineAssertions ?? null,
    retry: request.retry ?? { enabled: false },
    docs: request.docs ?? "",
    origin: request.origin ?? "manual",
    bootstrapFingerprint: request.bootstrapFingerprint ?? null,
    sourceRevision: request.sourceRevision ?? null
  };
}

function sourceRevision(project) {
  return project.sourceContext?.gitRevision
    ?? project.sourceContext?.git?.find((entry) => entry.commit)?.commit
    ?? project.sourceContext?.lastScannedAt
    ?? "unindexed";
}

function teamMemoryDocument(project) {
  return {
    version: TEAM_MEMORY_VERSION,
    projectId: project.id,
    projectName: project.name,
    sourceRevision: sourceRevision(project),
    contracts: (project.contracts ?? []).map((contract) => ({
      id: contract.id,
      currentRevisionId: contract.currentRevisionId ?? null,
      state: contract.state ?? null,
      latestVerificationReceiptId: contract.latestVerificationReceiptId ?? null
    })),
    pinnedEdges: (project.knowledgeGraph?.pinnedEdges ?? project.knowledgeGraph?.edges?.filter((edge) => edge.confirmationState === "confirmed" && ["manual", "human-confirmed", "team-pin"].includes(edge.provenance)) ?? []).map((edge) => ({ ...edge })),
    runtimeEdges: (project.knowledgeGraph?.edges ?? []).filter((edge) => edge.confirmationState === "confirmed" && edge.provenance === "runtime").map((edge) => ({ ...edge })),
    rejectedEdgeIds: [...new Set(project.knowledgeGraph?.rejectedEdgeIds ?? [])],
    ignoredBlindSpotIds: [...new Set(project.knowledgeGraph?.ignoredBlindSpotIds ?? [])],
    verificationReceipts: (project.verificationReceipts ?? []).map((receipt) => ({ ...receipt }))
  };
}

export async function saveTeamMemory(project) {
  const root = teamRoot(project);
  if (!root) return { written: false, reason: "no-repository-root" };
  const file = path.join(root, ".aipi", "team-memory.json");
  await writeJson(file, teamMemoryDocument(project));
  return { written: true, file };
}

export async function hydrateProjectTeamMemory(project) {
  const root = teamRoot(project);
  if (!root) return { root: null, graphPins: [], requests: [], receipts: [], warnings: ["No repository root is configured."] };
  const directory = path.join(root, ".aipi");
  const warnings = [];
  const read = async (name, fallback) => {
    try { return await readJson(path.join(directory, name), fallback); }
    catch (error) { warnings.push(`${name}: ${error.message}`); return fallback; }
  };
  const [graphDocument, requestDocument, receiptDocument, teamDocument] = await Promise.all([
    read("graph-pins.json", { version: TEAM_MEMORY_VERSION, edges: [] }),
    read("saved-requests.json", { version: TEAM_MEMORY_VERSION, requests: [] }),
    read("verification-receipts.json", { version: TEAM_MEMORY_VERSION, receipts: [] }),
    read("team-memory.json", { version: TEAM_MEMORY_VERSION, contracts: [], verificationReceipts: [] })
  ]);
  project.requests ??= [];
  const requests = Array.isArray(requestDocument.requests) ? requestDocument.requests : [];
  for (const request of requests) {
    const index = (project.requests ?? []).findIndex((entry) => entry.id === request.id || (request.bootstrapFingerprint && entry.bootstrapFingerprint === request.bootstrapFingerprint));
    if (index < 0) project.requests.push({ ...request, projectId: project.id, origin: request.origin ?? "team-memory" });
  }
  const receipts = [
    ...(Array.isArray(teamDocument.verificationReceipts) ? teamDocument.verificationReceipts : []),
    ...(Array.isArray(receiptDocument.receipts) ? receiptDocument.receipts : [])
  ];
  project.verificationReceipts ??= [];
  // Repository files are contributor-controlled. Keep their receipts available
  // for inspection, but never let them set verified contract state on import.
  for (const receipt of receipts) if (!project.verificationReceipts.some((entry) => entry.id === receipt.id || (receipt.bootstrapFingerprint && entry.bootstrapFingerprint === receipt.bootstrapFingerprint))) project.verificationReceipts.push({ ...receipt, projectId: project.id, authority: "advisory" });
  const pinnedEdges = Array.isArray(teamDocument.pinnedEdges) ? teamDocument.pinnedEdges : [];
  // A repository JSON document cannot attest that a runtime observation ran.
  const runtimeEdges = [];
  const graphPins = [...new Map([...(Array.isArray(graphDocument.edges) ? graphDocument.edges : []), ...pinnedEdges].map((edge) => [edge.id, edge])).values()];
  return { root, graphPins, pinnedEdges: graphPins, runtimeEdges, rejectedEdgeIds: Array.isArray(teamDocument.rejectedEdgeIds) ? teamDocument.rejectedEdgeIds : [], ignoredBlindSpotIds: Array.isArray(teamDocument.ignoredBlindSpotIds) ? teamDocument.ignoredBlindSpotIds : [], requests, receipts, warnings };
}

export function applyProjectGraphPins(project, graphPins = []) {
  project.knowledgeGraph ??= { nodes: [], edges: [] };
  const edges = new Map((project.knowledgeGraph.edges ?? []).map((entry) => [entry.id, entry]));
  for (const pin of graphPins) {
    const from = pin.fromNodeId ?? pin.from;
    const to = pin.toNodeId ?? pin.to;
    if (!pin?.id || !from || !to) continue;
    edges.set(pin.id, { ...edges.get(pin.id), ...pin, from, to, provenance: "repository-declaration", confirmationState: "pending", confidence: 0, runtimeVerified: false });
  }
  project.knowledgeGraph.edges = [...edges.values()];
  return graphPins.length;
}

export async function syncProjectTeamMemory(project) {
  const root = teamRoot(project);
  if (!root) return { written: false, reason: "no-repository-root" };
  const directory = path.join(root, ".aipi");
  const currentSourceRevision = sourceRevision(project);
  const graphPins = (project.knowledgeGraph?.edges ?? []).filter((entry) => entry.confirmationState === "confirmed" && ["team-pin", "human-confirmed", "agent-confirmed", "manual"].includes(entry.provenance));
  project.knowledgeGraph ??= { nodes: [], edges: [] };
  project.knowledgeGraph.pinnedEdges = graphPins;
  const requests = (project.requests ?? []).filter((entry) => entry.contractId || entry.bootstrapFingerprint).map(repositoryRequest);
  const receipts = (project.verificationReceipts ?? []).map((receipt) => ({ ...receipt }));
  await Promise.all([
    writeJson(path.join(directory, "manifest.json"), { version: TEAM_MEMORY_VERSION, projectId: project.id, projectName: project.name, sourceRevision: currentSourceRevision, files: ["graph-pins.json", "saved-requests.json", "verification-receipts.json", "team-memory.json"] }),
    writeJson(path.join(directory, "graph-pins.json"), { version: TEAM_MEMORY_VERSION, projectId: project.id, sourceRevision: currentSourceRevision, edges: graphPins }),
    writeJson(path.join(directory, "saved-requests.json"), { version: TEAM_MEMORY_VERSION, projectId: project.id, sourceRevision: currentSourceRevision, requests }),
    writeJson(path.join(directory, "verification-receipts.json"), { version: TEAM_MEMORY_VERSION, projectId: project.id, sourceRevision: currentSourceRevision, receipts }),
    writeJson(path.join(directory, "team-memory.json"), teamMemoryDocument(project))
  ]);
  return { written: true, directory, graphPins: graphPins.length, requests: requests.length, receipts: receipts.length };
}

