begin;

-- Source facts never enter the workspace-wide changes/snapshot feed. The
-- worker rechecks the caller's current repository grant on every read.
alter table public.team_source_bindings
  add constraint team_source_bindings_project_identity_unique unique(workspace_id, source_id, project_key);
create table public.team_source_fact_partitions (
  workspace_id uuid not null,
  project_key text not null,
  source_id text not null,
  revision_commit text not null check (revision_commit ~ '^[0-9a-f]{40}$'),
  path text not null check (char_length(path) between 1 and 500),
  analyzer_version text not null check (analyzer_version in ('openapi-json-v1','generated-client-v1')),
  content_hash text not null check (content_hash ~ '^[0-9a-f]{64}$'),
  fact_hash text not null check (fact_hash ~ '^[0-9a-f]{64}$'),
  facts jsonb not null check (jsonb_typeof(facts) = 'object' and octet_length(facts::text) <= 131072),
  indexed_at timestamptz not null default now(),
  primary key (workspace_id, source_id, revision_commit, path, analyzer_version),
  foreign key (workspace_id, source_id, project_key)
    references public.team_source_bindings(workspace_id, source_id, project_key) on delete cascade
);
create index team_source_facts_project_idx on public.team_source_fact_partitions(workspace_id, project_key, source_id, revision_commit);
alter table public.team_source_fact_partitions enable row level security;
revoke all on public.team_source_fact_partitions from public, anon, authenticated;
grant select, insert on public.team_source_fact_partitions to service_role;

-- Immutability makes a revision-pinned fact reusable across devices. A
-- mismatched re-analysis must be investigated rather than silently replacing
-- evidence already handed to another client.
create function private.reject_source_fact_change() returns trigger language plpgsql set search_path = '' as $$
begin
  raise exception 'SOURCE_FACT_IMMUTABLE' using errcode = '42501';
end $$;
revoke all on function private.reject_source_fact_change() from public;
create trigger source_fact_immutable before update on public.team_source_fact_partitions
  for each row execute function private.reject_source_fact_change();
commit;
