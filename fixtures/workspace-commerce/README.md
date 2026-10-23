# Commerce workspace fixture

`state.mjs` supplies a deterministic three-project index for ownership, search and collision tests. Storefront and Orders deliberately reuse a native artifact ID; Orders and Payments deliberately reuse a contract/request ID and `POST /checkout`. The explorer must retain each owning project and service.

The frontend source represents an unfinished payment-error interaction. The indexed state is seeded test data, not evidence that the parser resolves the complete frontend/backend/provider chain. Full automatic relationship discovery and cross-project task verification remain subsequent MVP milestones.

Run `npm run preview:mvp` to start an isolated dashboard and two local HTTP simulators. It uses a new temporary data directory, copies these sources for safe inspection, and prints the preview URL. It does not read or migrate the normal AIPI workspace. POST `/checkout` with a positive `amount` returns 201; a missing/non-positive amount returns 422. The payment simulator returns a distinct service identifier. These endpoints only return fixture data and have no external side effects.

Stop the process with Ctrl-C. The temporary fixture data is retained at the printed directory for inspection; no user project is modified.
