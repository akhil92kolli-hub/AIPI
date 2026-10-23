---
name: aipi
description: Inspect repository APIs with AIPI's local companion, use bounded contract evidence, check registered cross-repository impact, and verify contract-linked changes.
---

# AIPI API intelligence

Use the local AIPI MCP companion to inspect the current repository. Prefer focused evidence tools over dumping entire files into context.

- Discover routes and schemas with `get_context_pack_manifest` or `list_contract_evidence` before changing an API.
- Check registered consumers with the blast-radius tool when changing a shared contract. Treat registry results as the known registered state, not a complete inventory.
- Run `verify_contract_revision` for every affected contract after implementation and resolve failures before finishing.
- Do not execute state-changing API requests without explicit user confirmation.
- Keep credentials and raw sensitive payloads private. Never claim verification succeeded without a passing receipt.
