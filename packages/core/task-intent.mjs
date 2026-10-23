export const TASK_INTENTS = Object.freeze({
  "api-contract": { label: "Fix an API contract", description: "Link indexed routes, findings, replay evidence, and schema proof.", requiresContract: true, verification: "api" },
  "new-contract": { label: "Design a new API endpoint", description: "Create a Planned K Map contract and saved API request.", requiresContract: true, verification: "api" },
  "ui-component": { label: "Build UI / frontend", description: "Work on components, pages, client routes, interactions, and visual states without requiring a K Map contract.", requiresContract: false, verification: "ui" },
  "full-stack": { label: "Build a full-stack feature", description: "Bind frontend and backend context and enforce API replay when contracts are linked.", requiresContract: false, verification: "full-stack" },
  discovery: { label: "Refactor / discovery", description: "Investigate cross-cutting code, architecture, migrations, or technical debt.", requiresContract: false, verification: "evidence" },
  "commit-pr": { label: "Prepare commit & PR", description: "Compress working-tree changes and verified proof into an atomic commit and PR handoff.", requiresContract: false, verification: "receipt" },
  "deployment-automation": { label: "Deployment & release", description: "Check revision proof, environment health, and drift before deployment dispatch.", requiresContract: false, verification: "deployment" }
});

const LEGACY_INTENTS = Object.freeze({ "fix-contract": "api-contract", "ui-feature": "ui-component" });

export function normalizeTaskIntent(value, fallback = "api-contract") {
  const normalized = LEGACY_INTENTS[String(value ?? "")] ?? String(value ?? "");
  return TASK_INTENTS[normalized] ? normalized : fallback;
}

export const supportedTaskIntents = () => Object.keys(TASK_INTENTS);
export const taskIntentDefinition = (value) => TASK_INTENTS[normalizeTaskIntent(value)];
export const isUiTaskIntent = (value) => normalizeTaskIntent(value) === "ui-component";
export const isApiTaskIntent = (value) => ["api-contract", "new-contract"].includes(normalizeTaskIntent(value));

