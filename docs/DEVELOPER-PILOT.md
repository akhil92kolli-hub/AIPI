# AIPI developer pilot

Use this checklist with a small group of developers before widening the release. Ask each participant to use a disposable repository or a copy of the sample fixture; do not send production credentials or real customer payloads.

## Pilot setup

- Share the [installation guide](https://aipi.website/install) and the `fixtures/next-contract-mismatch` sample project.
- Ask participants to use Node.js 22 or newer and record their OS, Node version, IDE, and AIPI version.
- Ask them to follow the install flow without live coaching. Note every point where they pause, retry, or ask for help.
- Have them run setup, open the dashboard, navigate to the sample project, inspect the detected contract mismatch, and run the included checks.
- Have them send one successful request to a local test endpoint and one request to a deliberately unavailable endpoint. Confirm that success details and actionable failure text are visible in the timeline.
- If testing cloud pairing, use a dedicated test organization and throwaway account. Confirm the consent, pairing, reconnect, and expiry behavior; do not use the production organization.

## Feedback to collect

1. Where did setup or project selection feel unclear?
2. Which error required outside help to understand or fix?
3. Did the dashboard make it clear what stayed on the developer's machine and what pairing sends to the cloud?
4. Could the participant find and interpret the request result and timeline?
5. What documentation or IDE instructions were missing?
6. Would they use AIPI again, and what would need to change first?

Record reproducible steps, expected and actual behavior, OS/Node/IDE versions, and sanitized logs. Triage issues before publishing a wider release; never include access tokens, credentials, source code, or unredacted response bodies in feedback.
