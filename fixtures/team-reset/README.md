# R0–R4 acceptance workspace

`fixture.json` fixes the identities and roles for the eventual Team release demonstration: one React app, two Python services, an external endpoint, two users, two devices, and an IDE agent. The source examples contain a deliberate cross-project dependency: the React checkout reads `total` from `POST /api/orders`; the Orders service calls Inventory. The external payment endpoint is contract-only and uses an intentionally invalid hostname.

The scenario changes the Orders response by removing `total`, then checks whether AIPI finds the caller, selects relevant tests, records revision-specific proof after repair, and invalidates proof when the PR head changes. Current R0/R1 tests use this as a fixed target; it is **not** a claim that R2–R4 have passed. GitHub repository IDs, user OAuth grants, commits, and receipts must be supplied by the integration environment before the end-to-end demonstration.
