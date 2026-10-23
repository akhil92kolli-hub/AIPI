# K-Map screen and route contract

The inventory is a searchable list of expandable contracts, not a three-column workspace. Expand a row for source references; open the contract workspace for focused work.

| Screen | Route under `/projects/:projectId` |
| --- | --- |
| Contract inventory | `/kmaps?view=overview` |
| API Test launcher | `/kmaps?view=test` |
| Collections | `/kmaps?view=collections` |
| Records and receipts | `/kmaps?view=records` |
| Contract overview | `/kmaps/contracts/:contractId` |
| Implementation | `/kmaps/contracts/:contractId?view=implementation` |
| API Test | `/kmaps/contracts/:contractId/test` |
| Evidence list | `/kmaps/contracts/:contractId?view=evidence` |
| Evidence detail | `/kmaps/contracts/:contractId/evidence/:evidenceId` |
| Tasks & Proof | `/kmaps/contracts/:contractId?view=tasks` |
| Repository K-Map | `/tools` |

Contract tabs remain in Contracts & Evidence navigation. Query-based tabs support reload and browser history, including the IDE hash transport. Old graph URLs remain compatibility aliases; the visible name is K-Map.

## Reference integrity

The shared chain resolver includes all matched endpoint declarations and their indexed callers. Frontend components/pages in a caller's file are labeled same-file candidates, not confirmed dependency edges. Schema, database and test references require explicit index relationships. Unresolved groups remain visible and explain the index gap. References include source root, file, line, native ID, available detection metadata and index timestamp. The IDE can open indexed source locations.

## Generate Task

Tasks & Proof generates a Proposed task with contract, request, artifact and evidence links plus verification gates. An existing active contract task is reused. A linked finding uses the finding-draft flow; without a recorded failure, the draft explicitly asks the developer to confirm intended behavior. Generation does not execute requests, change source code or dispatch an agent.

## Remaining indexing work

The index does not yet provide complete transitive import/component, schema-to-handler, database and test edges for every framework. The UI must not invent those relationships. Future index adapters should populate explicit relationships with provenance and revision identity before presenting them as established chain links.
