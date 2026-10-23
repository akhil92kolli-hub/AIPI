# AIPI real-application relationship baseline

Scope: AIPI itself, as requested. This is a source-level sample of `ui/app.js`, `ui/workspace-explorer.js`, and `scripts/dashboard-server.mjs`, not a multi-application benchmark or runtime verification.

Reproduce with `node scripts/validate-aipi-relationships.mjs`. The script uses the production detector without updating projects, cached indexes, or task context.

## Original baseline

**0 linked caller–handler relationships** across the three sampled files. The UI file yielded three direct fetch calls, all dynamic; the shared explorer yielded no callers. Most application calls use the `api()` wrapper, which the detector does not resolve.

| Source-grounded example | Expected | Observed limitation |
| --- | --- | --- |
| API client calls `/api/send` | POST caller linked to POST server handler | Handler detected; wrapped caller missing |
| Vault initialization calls `/api/vault/initialize` | POST caller linked to POST handler | Wrapped caller missing; handler incorrectly classified GET |
| Explorer requests `/api/workspaces/:id/targets` | GET caller linked to parameterized route | Wrapper and regex route not represented as a usable link |
| Task context search `/api/projects/:id/tasks/search-context` | POST caller linked to parameterized handler | No complete relationship |
| Browser checks `location.pathname === '/dashboard'` | Client navigation, not an HTTP handler | Two false server endpoint detections |
| Server launch handler `/launch` | GET | Incorrectly classified OPTIONS |

No precision/recall percentage is claimed: these are manually inspected examples, not an exhaustive labeled corpus. No runtime proof was generated.

## Release gate before relationship-driven expansion

1. Bind HTTP method extraction to the same server conditional, not nearby unrelated text.
2. Exclude browser navigation comparisons from server-route discovery.
3. Resolve known wrappers through their actual definitions and preserve unresolved dynamic expressions. Do not assume any function named `api` is an HTTP client.
4. Support bounded parameterized server-route patterns and retain source/line provenance.
5. Add positive and negative regression cases for the examples above, then repeat this baseline. Do not label missing static links as proof that a backend is unused or absent.
6. Keep manual context selection and direct API testing operational while coverage is incomplete. Do not invent page-to-handler chains.

Cross-repository task binding remains a separate limitation: the picker can browse a workspace but currently binds targets only from the task's owning project. AIPI alone does not validate multi-application quality.

## Ticket result — source detection and Explore scanning

After the fixes, the same three-file sample contains 79 callers and 38 server routes. It yields **58 candidate caller–handler links across 28 handlers**, compared with zero before. These are static candidates, not runtime verification: AIPI's wrapper chooses its service origin dynamically, so the destination still needs confirmation.

- `/launch` is correctly GET and `/api/vault/initialize` correctly POST. Browser `/dashboard` comparisons no longer create server endpoints.
- Local wrapper chains are resolved through their function definitions and parameter forwarding. Shadowed names, strings, comments, unknown methods and overridden options do not become known HTTP calls.
- Anchored server regex routes with whole-segment parameters are recognized. Encoded whole-segment caller templates can produce candidate matches; arbitrary dynamic paths stay unresolved.
- Duplicate handlers and external origins are not joined by choosing the first matching path. Candidate links remain explicitly unconfirmed in the knowledge graph and related-context picker.
- Index cache version was incremented to rebuild previous detector results. Generated `.aipi` and `.api-forge` metadata is excluded from scans.
- Explore now scans all connected projects in the selected workspace or one selected project, reports per-project results, continues after failures, and supports stopping after the current project. It uses existing configured source folders and re-resolves selected targets after a refresh.

Verified with HTTP-source negative cases and real AIPI source assertions, workspace scan recovery/stop tests, the existing regression and knowledge-graph/workspace-route suites, application and extension builds, and a browser scan of an isolated three-project workspace followed by a single-project refresh.

Remaining bounds: injected HTTP clients across files (including the explorer's injected `api` parameter) are unresolved; optional/alternating server regex patterns are not expanded. The sample is not a full framework coverage benchmark. Cross-repository task context and live IDE execution remain subsequent tickets.
