---
name: aipi
description: Inspect AIPI API contracts, contract history, registry audit events, organization access, retention settings, and the registered blast radius of proposed API changes. Use for AIPI cloud contract-governance work; use the separately installed local companion for repository source inspection or local request replay.
---

# AIPI contract intelligence

Use the AIPI MCP tools to work with contract metadata available to the authenticated account.

- Ask for the organization when it is not already clear from the conversation or connected context.
- Call `list_contracts` to discover registered providers and consumers. Treat its results as the registry's known state, not a complete inventory of every real-world dependency.
- Call `check_blast_radius` before a proposed provider schema change. Report the returned status, field changes, affected repositories, and exact source locations. If the result is `unverified`, say that no registered baseline exists; never convert that result into a safety claim.
- Use `list_contract_versions` and `list_registry_audit` when provenance, publication history, or recent registry activity matters.
- Register or update a contract only when the user supplied or approved the contract and its known consumers. Describe the write before calling `register_contract` when the request is ambiguous.
- Organization membership and retention-policy tools operate on cloud governance data. Do not apply retention unless the user explicitly asks, the scope is clear, and `confirm` is true; report what was deleted.
- Do not claim that the remote plugin can inspect private local source, replay local requests, or access unregistered repositories. Those capabilities require the AIPI local companion.
