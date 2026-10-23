#!/usr/bin/env node

// Prefill GitHub's organization-owned App registration form. A human still
// completes registration and sets the webhook secret in GitHub's UI.
const base = new URL("https://github.com/organizations/AIPI-AI-Programming-Interface/settings/apps/new");
const fields = {
  name: "AIPI Team Connector",
  description: "Connect selected GitHub repositories to AIPI Team for task context, change evidence, and verification.",
  url: "https://aipi.website",
  "callback_urls[]": "https://app.aipi.website/team/github-callback",
  setup_url: "https://app.aipi.website/team",
  setup_on_update: "true",
  public: "true",
  request_oauth_on_install: "false",
  webhook_active: "true",
  webhook_url: "https://mcp.aipi.website/api/github/webhook",
  issues: "write",
  pull_requests: "read",
  checks: "read",
  contents: "read",
  metadata: "read",
};
for (const [key, value] of Object.entries(fields)) base.searchParams.append(key, value);
base.searchParams.append("events[]", "pull_request");
base.searchParams.append("events[]", "check_run");
console.log(base.href);
