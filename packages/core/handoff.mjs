import { newId } from "../../scripts/workspace-store.mjs";
import { redactRecord } from "./index.mjs";

function evidenceFiles(context = {}) {
  const values = [
    context.consumer && `${context.consumer.source}:${context.consumer.line}`,
    context.endpoint && `${context.endpoint.source}:${context.endpoint.line}`,
    ...(context.schemas ?? []).map((entry) => entry.source && `${entry.source}:${entry.line ?? 1}`),
    ...(context.integrations ?? []).map((entry) => entry.source && `${entry.source}:${entry.line ?? 1}`)
  ];
  return [...new Set(values.filter(Boolean))];
}

export function formatHandoff({ handoff, project, log, context = {}, diagnosis = {} }) {
  const result = log?.result ?? {};
  const files = handoff.evidence.files;
  const suggestions = diagnosis.suggestions ?? result.diagnosis?.suggestions ?? [];
  return [
    `## AIPI Handoff: ${handoff.title}`,
    "",
    "### Problem",
    handoff.summary,
    "",
    "### Evidence",
    `- Run: \`${log?.id ?? "not available"}\``,
    `- Request: \`${log?.method ?? ""} ${log?.url ?? ""}\``,
    `- Result: \`${result.status ? `HTTP ${result.status}` : result.error ?? "not available"}\``,
    ...(files.length ? files.map((file) => `- \`${file}\``) : ["- No source locations are available yet."]),
    "",
    "### Recommended action",
    ...(suggestions.length ? suggestions.map((entry, index) => `${index + 1}. ${entry}`) : [
      "1. Inspect the endpoint context and affected consumers.",
      "2. Compare the observed request with the source contract.",
      "3. Make the smallest safe correction.",
      "4. Generate or update a regression test.",
      "5. Re-run the request through AIPI and verify the result."
    ]),
    "",
    "### Constraints",
    "- Keep credentials, cookies, and full response bodies out of the handoff.",
    "- Preserve the existing route unless the evidence requires a route change.",
    "- Do not make state-changing requests without explicit authorization.",
    "",
    "### Suggested MCP actions",
    "- `get_endpoint_context`",
    "- `diff_contract`",
    "- `check_blast_radius`",
    "- `create_fix_plan`",
    "- `generate_regression_test`",
    "- `verify_changes`",
    "",
    `Handoff ID: \`${handoff.id}\``
  ].join("\n");
}

export function createHandoff({ project, log, context = {}, diagnosis = {} }) {
  const result = log?.result ?? {};
  const summary = diagnosis.summary
    ?? result.diagnosis?.summary
    ?? (result.status ? `Request returned HTTP ${result.status}.` : result.error ?? "AIPI recorded an issue that needs review.");
  const handoff = {
    id: newId("handoff"),
    projectId: project.id,
    logId: log?.id ?? null,
    status: "open",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    title: result.diagnosis?.category ?? (result.status ? `${log.method} ${log.url}` : "API integration issue"),
    summary,
    evidence: {
      files: evidenceFiles(context),
      status: result.status ?? null,
      diagnosis: redactRecord(result.diagnosis ?? diagnosis),
      contract: redactRecord(result.contractDiff ?? {})
    }
  };
  return { handoff, markdown: formatHandoff({ handoff, project, log, context, diagnosis }) };
}
