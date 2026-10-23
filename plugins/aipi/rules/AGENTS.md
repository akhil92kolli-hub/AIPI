# AIPI Verification Rule

Before concluding a task that adds, modifies, or deprecates an API endpoint or schema:

1. Query AIPI with `get_context_pack_manifest` or `list_contract_evidence`.
2. Inspect the contract requirements and run `verify_contract_revision`.
3. If verification fails, correct the implementation and verify again until a passing receipt is issued.
4. Do not complete a contract-linked handoff without valid verification proof.
