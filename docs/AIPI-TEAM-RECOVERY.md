# Team schema recovery and verification

Project: `zwffmaxjbzuazopvorkv`. The SQL in `supabase/migrations` is the source
of truth; `supabase/schema.sql` is generated with `npm run schema:generate`.

On 20 October 2026, the checked-in migrations through
`20261021100000_organization_owner_bootstrap_read` were applied through the Supabase
Management API and recorded in `supabase_migrations.schema_migrations`.

The following live checks run inside explicit transactions and finish with
`ROLLBACK`, leaving no synthetic accounts or records:

- `supabase/verification/team_rls_rollback.sql`: owner, viewer, separate
  organization, and revoked membership visibility.
- `supabase/verification/team_restore_rollback.sql`: logical task, decision,
  and evidence snapshot, cascading delete, and restore order.
- `supabase/verification/team_operation_rollback.sql`: atomic task write,
  duplicate acknowledgment, version conflict rollback, and revoked device.
- `supabase/verification/team_snapshot_rollback.sql`: cursor recovery and
  organization-isolated snapshots.
- `supabase/verification/team_collaboration_rollback.sql`: two-user handoff,
  task and append deduplication, stale writes, and replay after pruning.
- `supabase/verification/team_workspace_feed_rollback.sql`: repository binding
  events, snapshots, and scheduled retention with a preserved cursor floor.
- `supabase/verification/team_impact_graph_rollback.sql`: graph membership,
  revision-pinned edges, and preserved human rejection.
- `supabase/verification/team_github_pr_rollback.sql`: signed-delivery database
  contract, deduplication, trusted CI receipts, and protected PR state.
- `supabase/verification/team_pilot_controls_rollback.sql`: seat, event-budget,
  expiry, and source-sharing enforcement.
- `supabase/verification/team_pilot_restore_rollback.sql`: ordered graph, PR,
  CI, and organization delete/restore drill using synthetic rolled-back data.
- `supabase/verification/team_first_organization_rollback.sql`: first owner
  `INSERT ... RETURNING`, owner membership/entitlement, and outsider isolation.

For a deploy, apply only missing migration versions in filename order, then
compare the ledger with the directory and rerun the rollback checks. If an
application release needs reversal, deploy the previous Worker version and use a
forward corrective migration. Do not drop team tables to roll back application
code: that would remove acknowledged records and change history. For data loss,
restore a verified database backup to a separate project, inspect organization
and auth settings, then cut over after verifying counts and RLS.

The project's Management API reported **zero managed backups and PITR disabled**
on 20 October 2026. The transactional logical restore check validates the
domain restore order; it is not a disaster-recovery backup. Before a paid pilot,
enable an appropriate Supabase backup plan or arrange an off-site logical dump,
then rehearse a restore to a separate project. Supabase's [backup guidance](https://supabase.com/docs/guides/platform/backups)
notes that Storage objects are outside database backups and require their own
recovery plan.

The daily `aipi-team-change-retention` pg_cron job runs at 03:15 UTC. It
prunes only a contiguous event prefix older than 30 days and retains accepted
operation acknowledgments. Inspect `cron.job` and `cron.job_run_details` when
investigating a stale cursor or retention delay. An expired device cursor
recovers from `get_team_snapshot`; do not manually delete retained
acknowledgments or advance `team_sync_floors` without a verified snapshot.

For the companion's M3 local migration, `workspace.json.before-team-sync.json`
is created atomically with mode `0600` before SQLite imports portable metadata.
The original JSON remains readable and authoritative; deleting a failed
`team-sync.sqlite` after preserving it permits a clean retry from that backup.
