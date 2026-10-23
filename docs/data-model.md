# AIPI data ownership and lifecycle

Migrations in `supabase/migrations/` are the authoritative cloud schema. `supabase/schema.sql` is generated from them and is only a fresh-database bootstrap.

The local companion owns developer-workspace state: `WorkspaceProject → Environment → Service → Contract → ContractRevision → EvidenceRecord → Finding → Task → VerificationReceipt`. It is stored under the local AIPI data directory, protected by the OS credential vault, and is not uploaded by default.

The cloud tenancy layer is `Organization → Membership → Repository`. `WorkspaceProjectBinding` maps a user’s local project identifier to one canonical cloud repository. Contract publications and immutable revisions are team-cloud records only after an authenticated publish. Local task, evidence, run, and environment state remains local unless a future authenticated team-sync feature explicitly models and enables it.

Repository names and routes are normalized by `packages/contract-domain`. The database repository row provides the stable identity across display-name, URL, casing, move, or rename changes. Legacy contract rows can retain the normalized text key while they are progressively bound through `repository_id`.

`content_hash` is a deduplication identifier, not a security or authenticity proof. Verification receipts use their separately defined snapshot hashes for proof semantics.
