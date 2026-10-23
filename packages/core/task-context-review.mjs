import crypto from "node:crypto";
import { taskArtifacts } from "./task-context.mjs";
import { taskWorkspace } from "./task-workspace.mjs";
import { getWorkspaceTarget } from "./workspace-groups.mjs";

const text = (value, limit) => String(value ?? "").trim().slice(0, limit);
function references(project, input) {
  if(input.target_keys) {
    const state=taskWorkspace(project);
    if(!Array.isArray(input.target_keys)||input.target_keys.length>50 || !state?.workspaceGroups?.find(g=>g.id===input.workspace_group_id)?.projectIds.includes(project.id)) throw new Error('Choose a workspace containing the task owner.');
    return [...new Set(input.target_keys)].map(key=>{
      const t=getWorkspaceTarget(state,input.workspace_group_id,key).target;
      if(t.kind==='service')throw new Error('Select an API or source target.');
      return {id:t.ref.entityId,projectId:t.ref.projectId,targetRef:t.ref,targetKey:t.key,kind:t.kind,label:t.label,source:t.source,root:t.root,indexedAt:t.indexedAt};
    });
  }
  const catalogs = [
    ["artifact_ids", taskArtifacts(project)],
    ["contract_ids", (project.contracts ?? []).map(c => ({ id: c.id, kind: "api", label: `${c.method} ${c.route ?? c.normalizedPath}`, source: c.implementation?.source }))],
    ["request_ids", (project.requests ?? []).map(r => ({ id: r.id, kind: "request", label: r.name }))]
  ];
  return catalogs.flatMap(([key, entries]) => {
    const ids = input[key] ?? [];
    if (!Array.isArray(ids) || ids.length > 50) throw new Error("Select at most 50 references of each type.");
    return [...new Set(ids)].map(id => {
      const entry = entries.find(e => e.id === id);
      if (!entry) throw new Error(`Reference unavailable in this project: ${id}`);
      return { id, field: key, kind: entry.kind, label: entry.label, source: entry.source, root: entry.root, indexedAt: project.sourceContext?.lastScannedAt ?? null };
    });
  });
}
function criteria(input) {
  if (!Array.isArray(input ?? []) || (input ?? []).length > 20) throw new Error("Use at most 20 acceptance criteria.");
  return (input ?? []).map(c => text(c, 500)).filter(Boolean);
}
export function prepareTaskDraftContext(project, input) {
  const objective = text(input.objective, 4000), draftId = text(input.draft_id, 160);
  if (!objective || !draftId) throw new Error("A draft ID and objective are required.");
  const refs = references(project, input), acceptanceCriteria = criteria(input.acceptance_criteria);
  if (refs.length > 50) throw new Error("Select at most 50 total references.");
  const fingerprint = crypto.createHash("sha256").update(JSON.stringify([project.id, draftId, objective, refs, acceptanceCriteria])).digest("hex");
  const reviewId = `review_${fingerprint.slice(0, 24)}`;
  project.taskContextReviews ??= [];
  let review = project.taskContextReviews.find(r => r.reviewId === reviewId);
  if (!review) {
    review = { reviewId, draftId, summary: objective, references: refs, acceptanceCriteria, createdAt: new Date().toISOString() };
    project.taskContextReviews = [...project.taskContextReviews.slice(-49), review];
  }
  return structuredClone(review);
}
export function submitTaskContextReview(project, input) {
  const review = project.taskContextReviews?.find(r => r.reviewId === input.review_id);
  if (!review) throw new Error("Context review is unavailable. Prepare the current draft again.");
  const summary = text(input.summary, 2000);
  if (!summary) throw new Error("Explain the suggested context.");
  const refs = references(project, input);
  if (refs.length > 50) throw new Error("Suggest at most 50 total references.");
  review.suggestions = { summary, references: refs, acceptanceCriteria: criteria(input.acceptance_criteria), receivedAt: new Date().toISOString() };
  return { reviewId: review.reviewId, status: "awaiting-developer-review" };
}
export const TASK_CONTEXT_REVIEW_TOOLS = ["prepare_task_draft_context", "submit_task_context_review", "get_task_context_review"].map(name => ({
  name, description: name === "prepare_task_draft_context" ? "Prepare bounded context from explicit manual task draft inputs, without creating a task or executing checks." : name === "submit_task_context_review" ? "Return validated evidence suggestions to an existing task draft for developer review. Never creates another task or applies suggestions." : "Read agent suggestions for the exact prepared task draft.",
  inputSchema: { type: "object", required: ["project_id", ...(name === "prepare_task_draft_context" ? ["draft_id", "objective"] : ["review_id"])], properties: {
    project_id: { type: "string" }, draft_id: { type: "string", maxLength: 160 }, objective: { type: "string", maxLength: 4000 }, review_id: { type: "string" }, summary: { type: "string", maxLength: 2000 },
    workspace_group_id:{type:'string'},target_keys:{type:'array',maxItems:50,items:{type:'string'}},
    ...Object.fromEntries(["artifact_ids", "contract_ids", "request_ids"].map(key => [key, { type: "array", maxItems: 50, items: { type: "string" } }])), acceptance_criteria: { type: "array", maxItems: 20, items: { type: "string", maxLength: 500 } }
  }, additionalProperties: false }, annotations: { readOnlyHint: name === "get_task_context_review", destructiveHint: false, openWorldHint: false }
}));
