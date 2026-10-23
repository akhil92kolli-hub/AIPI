# AIPI release checklist

Complete and record each gate against the exact commit and package version being released.

## Security and database

- [ ] OAuth protected-resource metadata advertises the Supabase Auth issuer ending in `/auth/v1`.
- [ ] Organization role lookup only returns the caller's own role; regression test passes.
- [ ] Apply migrations to an isolated Supabase test project and run `supabase test db`.
- [ ] Verify owner, admin, developer, and viewer access for reads, writes, retention-policy changes, and retention application.
- [ ] Verify a user from another organization cannot read or modify organization data.

## Runtime and product

- [ ] `npm test`, `npm run test:package`, and `npm run validate` pass.
- [ ] Cross-platform CI passes on Linux, macOS, and Windows for the release commit.
- [ ] Browser walkthrough covers setup, navigation, a successful request, a failed request, and timeline/error details.
- [ ] Against the deployed test environment, verify sign-in, MCP authentication, pairing, expiry, reconnect, and failure handling.
- [ ] Confirm deployed Worker and dashboard configuration match the release commit; no production secret values are included in logs or artifacts.
- [ ] Complete a small developer pilot and resolve release-blocking onboarding and error-message issues.

## Package and documentation

- [ ] README, hosted installation guide, and package metadata match the release version and actual install flow.
- [ ] Review the packed tarball and confirm generated bundles and required dashboard assets are present.
- [ ] Document known limitations and any unsupported request transports or cloud flows.
- [ ] Publish only after every required gate above passes; record the npm version, commit SHA, CI run, and deployment version.
