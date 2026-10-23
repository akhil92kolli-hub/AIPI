const baseProperties = { project_id: { type: "string" } };

export const AIPI_DAILY_MCP_TOOL_DEFINITIONS = [
  {
    name: 'aipi_get_cross_repo_contracts', title: 'Inspect cross-repository contracts for a file or symbol',
    description: 'Read bounded indexed source and declared dependency references before editing. Unproven links remain advisory; missing links do not imply safety.',
    inputSchema: { type: 'object', required: ['workspace_id', 'project_id', 'file_or_symbol'], properties: {
      workspace_id: { type: 'string' }, project_id: { type: 'string' }, file_or_symbol: { type: 'string', minLength: 1, maxLength: 500 },
      limit: { type: 'integer', minimum: 1, maximum: 20, default: 10 }
    }, additionalProperties: false }
  },
  {
    name: 'aipi_check_impact', title: 'Assess current registered Git change',
    description: 'Assess a registered local Git diff and report potential consumers and missing proof. Raw caller-supplied diff text is not authoritative and this tool cannot publish or verify.',
    inputSchema: { type: 'object', required: ['workspace_id', 'project_id', 'base_ref'], properties: {
      workspace_id: { type: 'string' }, project_id: { type: 'string' }, base_ref: { type: 'string' }, head_ref: { type: 'string' },
      mode: { type: 'string', enum: ['working-tree', 'staged', 'unstaged', 'commits'], default: 'working-tree' },
      root_index: { type: 'integer', minimum: 0, maximum: 31, default: 0 }, limit: { type: 'integer', minimum: 1, maximum: 50, default: 20 }
    }, additionalProperties: false }
  },
  {
    name: 'aipi_get_handoff', title: 'Get bounded consumer repair handoff',
    description: 'Read a prepared handoff by exact ID or task ID within a named workspace and consumer project. A PR or issue reference must first be resolved to an AIPI task or handoff.',
    inputSchema: { type: 'object', required: ['workspace_id', 'project_id'], properties: {
      workspace_id: { type: 'string' }, project_id: { type: 'string' }, handoff_id: { type: 'string' }, task_id: { type: 'string' }
    }, additionalProperties: false }
  }
].map(definition => ({ ...definition, annotations: { openWorldHint: false, readOnlyHint: true, destructiveHint: false, idempotentHint: true } }));

export const WORKSPACE_MCP_TOOL_DEFINITIONS = [
  {
    name: "get_workspace_manifest", title: "Get portable workspace manifest",
    description: "Read the portable team workspace declaration. It excludes local paths, credentials, and access grants.",
    inputSchema: { type: "object", required: ["workspace_id"], properties: { workspace_id: { type: "string", pattern: "^wsg_[A-Za-z0-9_-]{8,100}$" } }, additionalProperties: false }
  },
  {
    name: "list_workspace_checkouts", title: "List local workspace checkouts",
    description: "List this device's verified checkout mappings for a workspace. Results are local-only and never shared through the manifest.",
    inputSchema: { type: "object", required: ["workspace_id"], properties: { workspace_id: { type: "string", pattern: "^wsg_[A-Za-z0-9_-]{8,100}$" } }, additionalProperties: false }
  }
].map(definition => ({ ...definition, annotations: { openWorldHint: false, readOnlyHint: true, destructiveHint: false, idempotentHint: true } }));

export const KNOWLEDGE_GRAPH_MCP_TOOL_DEFINITIONS = [
  {
    name: "search_knowledge_graph", title: "Search project knowledge graph",
    description: "Search typed Knowledge Graph nodes without reading entire repository files.",
    inputSchema: { type: "object", required: ["project_id", "query"], properties: { ...baseProperties, query: { type: "string", minLength: 1, maxLength: 240 }, limit: { type: "integer", minimum: 1, maximum: 50, default: 20 } }, additionalProperties: false }
  },
  ...[["traverse_upstream", "upstream"], ["traverse_downstream", "downstream"]].map(([name, direction]) => ({
    name, title: `Traverse graph ${direction}`,
    description: `Traverse up to five ${direction} relationship hops from a typed graph node.`,
    inputSchema: { type: "object", required: ["project_id", "node_id"], properties: { ...baseProperties, node_id: { type: "string" }, depth: { type: "integer", minimum: 1, maximum: 5, default: 2 }, min_confidence: { type: "number", minimum: 0, maximum: 1, default: .5 } }, additionalProperties: false }
  })),
  {
    name: "find_graph_blind_spots", title: "Find graph blind spots",
    description: "List routes without callers, unresolved callers, contracts without tests, and stale relationships.",
    inputSchema: { type: "object", required: ["project_id"], properties: { ...baseProperties, limit: { type: "integer", minimum: 1, maximum: 100, default: 50 } }, additionalProperties: false }
  }
].map((definition) => ({ ...definition, annotations: { openWorldHint: false, readOnlyHint: true, destructiveHint: false, idempotentHint: true } }));
