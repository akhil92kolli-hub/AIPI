import crypto from "node:crypto";
import { normalizeTaskIntent } from "./task-intent.mjs";

const hash = (value, length = 24) => crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, length);
const normalizeRoute = (value = "/") => {
  const path = String(value).replace(/^\{\{[^}]+\}\}/, "").split(/[?#]/)[0].replace(/:\w+|\{[^}]+\}/g, "{param}").replace(/\/$/, "");
  return path || "/";
};
const revisionFor = (project) => project.sourceContext?.gitRevision ?? project.sourceContext?.git?.find((entry) => entry.commit)?.commit ?? project.sourceContext?.lastScannedAt ?? "unindexed";
const edgeId = (type, fromNodeId, toNodeId) => `edge_${hash([type, fromNodeId, toNodeId])}`;
const words = (value) => new Set(String(value ?? "").toLowerCase().split(/[^a-z0-9]+/).filter((word) => word.length > 2));

function graphNode(id, type, label, detail, extra = {}) {
  return { id, type, label: label || id, detail: detail ?? null, ...extra };
}

function graphEdge(type, fromNodeId, toNodeId, sourceRevision, extra = {}) {
  return {
    id: edgeId(type, fromNodeId, toNodeId), fromNodeId, toNodeId, from: fromNodeId, to: toNodeId, type,
    provenance: "static", confidence: .8, sourceArtifactId: null, sourceRevision, confirmedBy: null,
    confirmationState: "inferred", stale: false, ...extra
  };
}

function mergeEdge(current, incoming) {
  if (!current) return incoming;
  const rank = { static: 1, "agent-inferred": 2, runtime: 3, manual: 4 };
  return (rank[incoming.provenance] ?? 0) >= (rank[current.provenance] ?? 0) ? { ...current, ...incoming } : { ...incoming, ...current };
}

function testMatchesContract(test, contract, endpoint) {
  if (test.endpointId && endpoint?.id === test.endpointId) return true;
  if (test.contractId === contract.id) return true;
  const haystack = `${test.name ?? ""} ${test.source ?? ""}`.toLowerCase();
  return normalizeRoute(contract.route).split("/").some((token) => token.length > 3 && haystack.includes(token.toLowerCase()));
}

export function findGraphBlindSpots(project) {
  const graph = project.knowledgeGraph ?? { nodes: [], edges: [] };
  const activeEdges = (graph.edges ?? []).filter((edge) => edge.confirmationState !== "rejected" && edge.confirmationState !== "pending" && !edge.stale);
  const blindSpots = [];
  for (const node of graph.nodes ?? []) {
    if (node.type === "route" && !activeEdges.some((edge) => edge.type === "CALLS" && (edge.toNodeId ?? edge.to) === node.id)) {
      blindSpots.push({ id: `blind_${hash(["route-missing-caller", node.id])}`, type: "route-missing-caller", nodeId: node.id, routeId: node.id, title: `${node.label} has no indexed caller`, intentionalCandidate: /webhook|health|callback/i.test(node.label), status: "open" });
    }
    if (node.type === "caller" && !activeEdges.some((edge) => edge.type === "CALLS" && (edge.fromNodeId ?? edge.from) === node.id)) {
      blindSpots.push({ id: `blind_${hash(["caller-missing-route", node.id])}`, type: "caller-missing-route", nodeId: node.id, title: `${node.label} has an unresolved route target`, status: "open" });
    }
    if (node.type === "contract" && !activeEdges.some((edge) => edge.type === "TESTED_BY" && (edge.fromNodeId ?? edge.from) === node.id)) {
      blindSpots.push({ id: `blind_${hash(["contract-missing-test", node.id])}`, type: "contract-missing-test", nodeId: node.id, contractId: node.id, title: `${node.label} has no indexed test`, status: "open" });
    }
  }
  for (const edge of activeEdges.filter((entry) => entry.stale)) {
    blindSpots.push({ id: `blind_${hash(["stale-edge", edge.id])}`, type: "stale-edge", edgeId: edge.id, nodeId: edge.fromNodeId ?? edge.from, targetNodeId: edge.toNodeId ?? edge.to, title: `${edge.type} relationship is stale`, status: "open" });
  }
  const ignored = new Set(graph.ignoredBlindSpotIds ?? []);
  return blindSpots.filter((spot) => !ignored.has(spot.id));
}

export function buildProjectKnowledgeGraph(project, teamMemory = {}) {
  const source = project.sourceContext ?? {};
  const revision = revisionFor(project);
  const nodes = new Map();
  const edges = new Map();
  const addNode = (node) => { if (node?.id) nodes.set(node.id, { ...nodes.get(node.id), ...node }); };
  const addEdge = (edge) => { if (edge?.fromNodeId && edge?.toNodeId) edges.set(edge.id, mergeEdge(edges.get(edge.id), edge)); };
  const endpoints = new Map((source.endpoints ?? []).map((entry) => [entry.id, entry]));
  const contracts = project.contracts ?? [];

  for (const contract of contracts) addNode(graphNode(contract.id, "contract", `${contract.method} ${contract.route}`, contract.implementation?.source ?? "Normalized contract", { contractId: contract.id, method: contract.method, route: contract.route, state: contract.state ?? contract.comparisonState ?? "Unknown" }));
  for (const endpoint of source.endpoints ?? []) {
    addNode(graphNode(endpoint.id, "route", `${endpoint.method} ${endpoint.path}`, `${endpoint.source ?? "Source unavailable"}${endpoint.line ? `:${endpoint.line}` : ""}`, { method: endpoint.method, route: endpoint.path, artifactId: `endpoint:${endpoint.id}` }));
    const handlerId = `handler_${hash([endpoint.root, endpoint.source, endpoint.line, endpoint.id])}`;
    addNode(graphNode(handlerId, "handler", endpoint.name ?? endpoint.functionName ?? endpoint.source ?? `${endpoint.method} handler`, `${endpoint.source ?? "Source unavailable"}${endpoint.line ? `:${endpoint.line}` : ""}`, { source: endpoint.source, line: endpoint.line, root: endpoint.root, artifactId: `endpoint:${endpoint.id}` }));
    addEdge(graphEdge("HANDLED_BY", endpoint.id, handlerId, revision, { confidence: endpoint.confidence ?? 1, sourceArtifactId: endpoint.id }));
    const contract = contracts.find((entry) => entry.sourceArtifactIds?.includes(endpoint.id) || (entry.method === endpoint.method && normalizeRoute(entry.route) === normalizeRoute(endpoint.path)));
    if (contract) addEdge(graphEdge("HANDLED_BY", contract.id, handlerId, revision, { confidence: endpoint.confidence ?? 1, sourceArtifactId: endpoint.id }));
  }
  for (const caller of source.frontendCalls ?? []) addNode(graphNode(caller.id, caller.kind === "component" ? "component" : "caller", caller.name ?? caller.source ?? `${caller.method ?? "API"} caller`, `${caller.source ?? "Source unavailable"}${caller.line ? `:${caller.line}` : ""}`, { source: caller.source, line: caller.line, root: caller.root, artifactId: `consumer:${caller.id}` }));
  for (const integration of source.integrations ?? []) {
    if (!integration.callId || !integration.endpointId) continue;
    addEdge(graphEdge("CALLS", integration.callId, integration.endpointId, revision, { confidence: integration.confidence ?? .65, sourceArtifactId: integration.id, confirmationState: integration.confirmationState ?? (integration.status === "healthy" ? "confirmed" : "inferred") }));
  }
  for (const schema of source.schemas ?? []) {
    addNode(graphNode(schema.id, "schema", schema.name ?? schema.source ?? "Schema", schema.source, { source: schema.source, line: schema.line, root: schema.root, artifactId: `schema:${schema.id}` }));
    const endpoint = endpoints.get(schema.endpointId) ?? (source.endpoints ?? []).find((entry) => schema.source && entry.source === schema.source);
    const contract = contracts.find((entry) => entry.sourceArtifactIds?.includes(endpoint?.id) || entry.schemaIds?.includes(schema.id));
    if (contract) addEdge(graphEdge("VALIDATED_BY", contract.id, schema.id, revision, { confidence: schema.confidence ?? .85, sourceArtifactId: schema.id }));
  }
  const artifacts = source.artifacts ?? [];
  for (const artifact of artifacts.filter((entry) => entry.kind === "test")) {
    addNode(graphNode(artifact.id, "test", artifact.name ?? artifact.source ?? "Test", artifact.source, { source: artifact.source, line: artifact.line, root: artifact.root, artifactId: `test:${artifact.id}` }));
    for (const contract of contracts) {
      const endpoint = (source.endpoints ?? []).find((entry) => contract.sourceArtifactIds?.includes(entry.id));
      if (testMatchesContract(artifact, contract, endpoint)) addEdge(graphEdge("TESTED_BY", contract.id, artifact.id, revision, { confidence: artifact.endpointId || artifact.contractId ? 1 : .65, sourceArtifactId: artifact.id }));
    }
  }
  for (const artifact of artifacts.filter((entry) => ["model", "database", "db-model"].includes(entry.kind))) {
    addNode(graphNode(artifact.id, "db-model", artifact.name ?? artifact.source ?? "Database model", artifact.source, { source: artifact.source, line: artifact.line, root: artifact.root, artifactId: `${artifact.kind}:${artifact.id}` }));
    for (const contract of contracts.filter((entry) => entry.implementation?.source && entry.implementation.source === artifact.source)) addEdge(graphEdge(["POST", "PUT", "PATCH", "DELETE"].includes(contract.method) ? "WRITES_TO" : "READS_FROM", contract.id, artifact.id, revision, { confidence: .7, sourceArtifactId: artifact.id }));
  }
  for (const task of project.tasks ?? []) {
    addNode(graphNode(task.id, "task", task.title, task.status, { taskId: task.id }));
    for (const contractId of task.contractIds ?? []) {
      if (contracts.some((contract) => contract.id === contractId)) addEdge(graphEdge("CREATED_TASK", contractId, task.id, revision, { provenance: task.source === "finding" ? "runtime" : "static", confidence: 1, confirmationState: "confirmed" }));
    }
  }
  for (const evidence of project.evidence ?? []) {
    addNode(graphNode(evidence.id, "evidence", evidence.type ?? "Evidence", evidence.recordedAt ?? evidence.sourceRevision, { evidenceId: evidence.id }));
    if (evidence.contractId) addEdge(graphEdge("OBSERVED_BY", evidence.contractId, evidence.id, evidence.sourceRevision ?? revision, { provenance: evidence.origin === "otel-live" ? "untrusted-observation" : "static", confidence: evidence.origin === "otel-live" ? 0 : 1, confirmationState: evidence.origin === "otel-live" ? "pending" : "confirmed" }));
  }
  for (const receipt of project.verificationReceipts ?? []) {
    addNode(graphNode(receipt.id, "receipt", "Receipt claim", receipt.verifiedAt ?? receipt.sourceRevision, { receiptId: receipt.id }));
    // A receipt-shaped record is not proof. Only the accepted coverage service
    // may promote a verified relationship after checking producer and scope.
  }

  const pins = teamMemory.pinnedEdges ?? teamMemory.graphPins ?? project.knowledgeGraph?.pinnedEdges ?? [];
  for (const pin of pins) {
    const fromNodeId = pin.fromNodeId ?? pin.from;
    const toNodeId = pin.toNodeId ?? pin.to;
    if (!fromNodeId || !toNodeId) continue;
    addEdge(graphEdge(pin.type ?? "CALLS", fromNodeId, toNodeId, pin.sourceRevision ?? revision, { ...pin, id: pin.id ?? edgeId(pin.type ?? "CALLS", fromNodeId, toNodeId), fromNodeId, toNodeId, from: fromNodeId, to: toNodeId, provenance: "manual-declaration", confidence: 0, confirmationState: "pending", stale: pin.sourceRevision !== revision }));
  }
  for (const runtimeEdge of teamMemory.runtimeEdges ?? []) {
    const fromNodeId = runtimeEdge.fromNodeId ?? runtimeEdge.from;
    const toNodeId = runtimeEdge.toNodeId ?? runtimeEdge.to;
    if (!fromNodeId || !toNodeId) continue;
    addEdge(graphEdge(runtimeEdge.type, fromNodeId, toNodeId, runtimeEdge.sourceRevision ?? revision, { ...runtimeEdge, fromNodeId, toNodeId, from: fromNodeId, to: toNodeId, provenance: "runtime", confidence: 1, confirmationState: "confirmed" }));
  }
  const rejected = new Set(teamMemory.rejectedEdgeIds ?? project.knowledgeGraph?.rejectedEdgeIds ?? []);
  for (const id of rejected) if (edges.has(id)) edges.set(id, { ...edges.get(id), confirmationState: "rejected" });
  for (const [id, edge] of edges) edges.set(id, { ...edge, stale: edge.sourceRevision !== revision });

  project.knowledgeGraph = {
    version: 1, indexedAt: source.lastScannedAt ?? project.knowledgeGraph?.indexedAt ?? new Date().toISOString(), sourceRevisions: [...new Set([revision, ...(source.git ?? []).map((entry) => entry.commit).filter(Boolean)])],
    nodes: [...nodes.values()].sort((a, b) => `${a.type}:${a.id}`.localeCompare(`${b.type}:${b.id}`)),
    edges: [...edges.values()].sort((a, b) => a.id.localeCompare(b.id)),
    unresolvedEdges: [], pinnedEdges: [...pins], rejectedEdgeIds: [...rejected], ignoredBlindSpotIds: [...new Set(teamMemory.ignoredBlindSpotIds ?? project.knowledgeGraph?.ignoredBlindSpotIds ?? [])]
  };
  project.knowledgeGraph.unresolvedEdges = findGraphBlindSpots(project);
  return project.knowledgeGraph;
}

export function traverseKnowledgeGraph(project, { nodeId, direction = "both", depth = 2, minConfidence = .5 } = {}) {
  const graph = project.knowledgeGraph ?? buildProjectKnowledgeGraph(project);
  const boundedDepth = Math.max(1, Math.min(5, Number(depth) || 2));
  const nodes = new Map(graph.nodes.map((node) => [node.id, node]));
  const eligible = graph.edges.filter((edge) => edge.confirmationState !== "rejected" && edge.confirmationState !== "pending" && !edge.stale && Number(edge.confidence ?? 0) >= Number(minConfidence));
  const walk = (mode) => {
    const discovered = new Map();
    const traversed = new Map();
    const visited = new Set([nodeId]);
    let frontier = new Set([nodeId]);
    for (let hop = 1; hop <= boundedDepth && frontier.size; hop += 1) {
      const next = new Set();
      for (const edge of eligible) {
        const from = edge.fromNodeId ?? edge.from;
        const to = edge.toNodeId ?? edge.to;
        if (!(mode === "downstream" ? frontier.has(from) : frontier.has(to))) continue;
        const candidate = mode === "downstream" ? to : from;
        traversed.set(edge.id, edge);
        if (visited.has(candidate)) continue;
        visited.add(candidate); next.add(candidate);
        if (nodes.has(candidate)) discovered.set(candidate, { ...nodes.get(candidate), depth: hop });
      }
      frontier = next;
    }
    return { nodes: [...discovered.values()], edges: [...traversed.values()] };
  };
  const upstream = direction === "downstream" ? { nodes: [], edges: [] } : walk("upstream");
  const downstream = direction === "upstream" ? { nodes: [], edges: [] } : walk("downstream");
  const selectedEdges = [...new Map([...upstream.edges, ...downstream.edges].map((edge) => [edge.id, edge])).values()];
  const selectedIds = new Set([nodeId, ...upstream.nodes.map((node) => node.id), ...downstream.nodes.map((node) => node.id)]);
  return { focusNode: nodes.get(nodeId) ?? null, upstreamNodes: upstream.nodes, downstreamNodes: downstream.nodes, edges: selectedEdges, impactRadiusCount: selectedIds.size - 1, blindSpots: (graph.unresolvedEdges ?? findGraphBlindSpots(project)).filter((spot) => selectedIds.has(spot.nodeId) || selectedIds.has(spot.targetNodeId)) };
}

export function promoteRuntimeEdge(project, { contractId, handlerFile, testFile, callerFile, dbModel, gitRevision, observedAt, runtimeEvidenceId } = {}) {
  const graph = project.knowledgeGraph ?? buildProjectKnowledgeGraph(project);
  const revision = gitRevision ?? revisionFor(project);
  const additions = [];
  const ensureTarget = (type, value) => {
    if (!value) return null;
    const comparable = (source) => String(source ?? "").replaceAll("\\", "/").replace(/^\.\//, "");
    const target = comparable(value);
    let node = graph.nodes.find((entry) => {
      if (entry.type !== type) return false;
      const candidate = comparable(entry.source ?? entry.label ?? entry.id);
      return candidate === target || candidate.endsWith(`/${target}`) || target.endsWith(`/${candidate}`);
    });
    if (!node) { node = graphNode(`${type}_${hash(value)}`, type, value, value, { source: value }); graph.nodes.push(node); }
    return node;
  };
  const promote = (type, target) => {
    if (!target || !contractId) return;
    const id = edgeId(type, contractId, target.id);
    const previous = graph.edges.find((edge) => edge.id === id || (edge.type === type && (edge.fromNodeId ?? edge.from) === contractId && (edge.toNodeId ?? edge.to) === target.id));
    const next = graphEdge(type, contractId, target.id, revision, { ...(previous ?? {}), id, provenance: "runtime", confidence: 1, confirmationState: "confirmed", stale: false, runtimeObservedAt: observedAt ?? new Date().toISOString(), runtimeEvidenceId: runtimeEvidenceId ?? previous?.runtimeEvidenceId ?? null });
    if (previous) Object.assign(previous, next); else graph.edges.push(next);
    additions.push(next);
  };
  promote("HANDLED_BY", ensureTarget("handler", handlerFile));
  promote("TESTED_BY", ensureTarget("test", testFile));
  const caller = ensureTarget("caller", callerFile);
  if (caller && contractId) {
    const contract = (project.contracts ?? []).find((entry) => entry.id === contractId);
    const route = graph.nodes.find((node) => node.type === "route" && (contract?.sourceArtifactIds?.includes(node.id) || (node.method === contract?.method && normalizeRoute(node.route) === normalizeRoute(contract?.route))));
    const targetId = route?.id ?? contractId;
    const id = edgeId("CALLS", caller.id, targetId);
    const previous = graph.edges.find((edge) => edge.id === id);
    const next = graphEdge("CALLS", caller.id, targetId, revision, { ...(previous ?? {}), id, provenance: "runtime", confidence: 1, confirmationState: "confirmed", stale: false, runtimeObservedAt: observedAt ?? new Date().toISOString(), runtimeEvidenceId: runtimeEvidenceId ?? previous?.runtimeEvidenceId ?? null });
    if (previous) Object.assign(previous, next); else graph.edges.push(next);
    additions.push(next);
  }
  promote("WRITES_TO", ensureTarget("db-model", dbModel));
  graph.unresolvedEdges = findGraphBlindSpots(project);
  return additions;
}

export function discoverTaskContext(project, task, { maxContracts = 3, tokenBudget = 2400 } = {}) {
  const graph = project.knowledgeGraph ?? buildProjectKnowledgeGraph(project);
  const queryWords = words(`${task.title ?? ""} ${task.description ?? ""} ${task.diagnosis ?? ""}`);
  const broad = !queryWords.size || /discover|test apis?|connect source|map apis?/i.test(`${task.title} ${task.description ?? ""}`);
  const intent = normalizeTaskIntent(task.intent, "discovery");
  const permitsAutomaticContracts = ["api-contract", "full-stack", "discovery"].includes(intent);
  const scored = (project.contracts ?? []).map((contract) => {
    const targetWords = words(`${contract.method} ${contract.route} ${contract.name ?? ""} ${contract.implementation?.source ?? ""}`);
    const lexical = [...queryWords].filter((word) => targetWords.has(word)).length;
    const openFindings = (project.findings ?? []).filter((finding) => finding.contractId === contract.id && !["resolved", "dismissed", "closed"].includes(finding.status)).length;
    const unverified = ["Verified", "verified"].includes(contract.state) ? 0 : 2;
    return { contract, lexical, score: lexical * 4 + openFindings * 3 + unverified + (broad ? 1 : 0) };
  }).filter((entry) => entry.score > 0).sort((a, b) => b.score - a.score || `${a.contract.method} ${a.contract.route}`.localeCompare(`${b.contract.method} ${b.contract.route}`));
  const explicitlyLinked = (task.contractIds ?? []).map((id) => (project.contracts ?? []).find((contract) => contract.id === id)).filter(Boolean);
  const inferredContracts = permitsAutomaticContracts
    ? scored.filter((entry) => broad || entry.lexical > 0).map((entry) => entry.contract)
    : [];
  const selectedContracts = [...new Map([...explicitlyLinked, ...inferredContracts].map((contract) => [contract.id, contract])).values()]
    .slice(0, Math.max(1, Math.min(3, maxContracts)));
  task.contractIds = [...new Set([...(task.contractIds ?? []), ...selectedContracts.map((contract) => contract.id)])];
  const traversals = selectedContracts.map((contract) => traverseKnowledgeGraph(project, { nodeId: contract.id, depth: 2 }));
  const explicitlyLinkedArtifacts = new Set(task.artifactIds ?? []);
  const artifactNodes = graph.nodes.filter((node) => explicitlyLinkedArtifacts.has(node.artifactId) || explicitlyLinkedArtifacts.has(node.id));
  const chainNodes = [...new Map([...traversals.flatMap((result) => [result.focusNode, ...result.upstreamNodes, ...result.downstreamNodes]), ...artifactNodes].filter(Boolean).map((node) => [node.id, node])).values()];
  task.affectedChainIds = chainNodes.map((node) => node.id);
  const includedArtifacts = chainNodes.filter((node) => node.artifactId).map((node) => node.artifactId);
  task.artifactIds = [...new Set([...(task.artifactIds ?? []), ...includedArtifacts])];
  const findings = (project.findings ?? []).filter((finding) => task.contractIds.includes(finding.contractId));
  const manifest = { taskId: task.id, contractIds: task.contractIds, affectedChainIds: task.affectedChainIds, artifactIds: task.artifactIds, findingIds: findings.map((finding) => finding.id), tokenBudget };
  let estimatedTokens = Math.ceil(Buffer.byteLength(JSON.stringify(manifest), "utf8") / 4);
  while (estimatedTokens > tokenBudget && manifest.artifactIds.length) { manifest.artifactIds.pop(); estimatedTokens = Math.ceil(Buffer.byteLength(JSON.stringify(manifest), "utf8") / 4); }
  const now = new Date().toISOString();
  task.contextStatus = "current";
  task.updatedAt = now;
  task.contextPack = { ...manifest, estimatedTokens, level: "working", sourceRevision: revisionFor(project), createdAt: task.contextPack?.createdAt ?? now, updatedAt: now };
  return { task, contextPack: task.contextPack, selectedContracts, chainNodes, blindSpots: graph.unresolvedEdges.filter((spot) => task.affectedChainIds.includes(spot.nodeId)) };
}
