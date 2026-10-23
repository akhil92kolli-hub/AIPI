-- Team Context Foundation (M2)
-- This migration is additive. It introduces organization-scoped collaboration
-- records; the local companion remains the authority for checkout paths.

begin;

create table if not exists public.team_workspaces (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  name text not null check (char_length(name) between 1 and 120),
  description text,
  created_by uuid not null references auth.users(id) on delete restrict,
  version bigint not null default 1 check (version > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, name)
);

create table if not exists public.team_workspace_projects (
  workspace_id uuid not null references public.team_workspaces(id) on delete cascade,
  provider text not null default 'github' check (provider = 'github'),
  provider_repository_id text not null check (provider_repository_id ~ '^[1-9][0-9]{0,29}$'),
  repository text not null check (char_length(repository) between 1 and 240),
  remote_url text not null check (remote_url ~ '^https://github[.]com/[^/]+/[^/]+$'),
  project_key text not null check (project_key ~ '^prj_[A-Za-z0-9_-]{4,100}$'),
  repository_root text not null default '.' check (
    repository_root = '.' or repository_root ~ '^[A-Za-z0-9_.-]+(/[A-Za-z0-9_.-]+)*$'
  ),
  version bigint not null default 1 check (version > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (workspace_id, project_key),
  unique (workspace_id, provider, provider_repository_id, repository_root)
);

create table if not exists public.team_tasks (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.team_workspaces(id) on delete cascade,
  external_id text not null check (external_id ~ '^task_[A-Za-z0-9_-]{4,100}$'),
  title text not null check (char_length(title) between 1 and 500),
  description text not null default '',
  status text not null default 'open' check (status in ('proposed', 'open', 'in_progress', 'blocked', 'completed', 'archived')),
  owner_id uuid references auth.users(id) on delete set null,
  revision_set jsonb not null default '[]'::jsonb check (jsonb_typeof(revision_set) = 'array'),
  version bigint not null default 1 check (version > 0),
  created_by uuid not null references auth.users(id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, external_id)
);

create table if not exists public.team_decisions (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.team_workspaces(id) on delete cascade,
  task_id uuid references public.team_tasks(id) on delete cascade,
  body text not null check (char_length(body) between 1 and 16000),
  source_refs jsonb not null default '[]'::jsonb check (jsonb_typeof(source_refs) = 'array'),
  created_by uuid not null references auth.users(id) on delete restrict,
  created_at timestamptz not null default now()
);

create table if not exists public.team_evidence (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.team_workspaces(id) on delete cascade,
  task_id uuid references public.team_tasks(id) on delete cascade,
  kind text not null check (kind in ('declared', 'static', 'runtime', 'verification', 'ai_suggestion')),
  producer text not null check (char_length(producer) between 1 and 160),
  revision_set jsonb not null default '[]'::jsonb check (jsonb_typeof(revision_set) = 'array'),
  payload jsonb not null default '{}'::jsonb check (jsonb_typeof(payload) = 'object'),
  created_by uuid not null references auth.users(id) on delete restrict,
  created_at timestamptz not null default now()
);

create table if not exists public.team_devices (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  label text not null check (char_length(label) between 1 and 120),
  revoked_at timestamptz,
  created_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  unique (organization_id, user_id, label)
);

create table if not exists public.team_accepted_operations (
  organization_id uuid not null references public.organizations(id) on delete cascade,
  device_id uuid not null references public.team_devices(id) on delete cascade,
  operation_id uuid not null,
  actor_id uuid not null references auth.users(id) on delete restrict,
  accepted_at timestamptz not null default now(),
  primary key (organization_id, operation_id)
);

create table if not exists public.team_change_events (
  sequence bigint generated always as identity primary key,
  organization_id uuid not null references public.organizations(id) on delete cascade,
  workspace_id uuid references public.team_workspaces(id) on delete cascade,
  operation_id uuid,
  entity_type text not null check (entity_type in ('workspace', 'workspace_project', 'task', 'decision', 'evidence')),
  entity_id uuid,
  event_type text not null check (event_type in ('created', 'updated', 'deleted')),
  created_at timestamptz not null default now()
);

create index if not exists team_workspaces_organization_idx on public.team_workspaces (organization_id);
create index if not exists team_workspace_projects_repository_idx on public.team_workspace_projects (provider, provider_repository_id);
create index if not exists team_tasks_workspace_updated_idx on public.team_tasks (workspace_id, updated_at desc);
create index if not exists team_decisions_workspace_created_idx on public.team_decisions (workspace_id, created_at desc);
create index if not exists team_evidence_workspace_created_idx on public.team_evidence (workspace_id, created_at desc);
create index if not exists team_change_events_org_sequence_idx on public.team_change_events (organization_id, sequence);

create or replace function private.can_access_team_workspace(p_workspace_id uuid)
returns boolean language sql stable security invoker set search_path = '' as $$
  select exists (
    select 1 from public.team_workspaces workspace
    where workspace.id = p_workspace_id
      and private.organization_role_for(workspace.organization_id) is not null
  );
$$;
revoke all on function private.can_access_team_workspace(uuid) from public, anon;
grant execute on function private.can_access_team_workspace(uuid) to authenticated;

create or replace function private.can_write_team_workspace(p_workspace_id uuid)
returns boolean language sql stable security invoker set search_path = '' as $$
  select exists (
    select 1 from public.team_workspaces workspace
    where workspace.id = p_workspace_id
      and private.organization_role_for(workspace.organization_id) in ('owner', 'admin', 'developer')
  );
$$;
revoke all on function private.can_write_team_workspace(uuid) from public, anon;
grant execute on function private.can_write_team_workspace(uuid) to authenticated;

alter table public.team_workspaces enable row level security;
alter table public.team_workspace_projects enable row level security;
alter table public.team_tasks enable row level security;
alter table public.team_decisions enable row level security;
alter table public.team_evidence enable row level security;
alter table public.team_devices enable row level security;
alter table public.team_accepted_operations enable row level security;
alter table public.team_change_events enable row level security;

create policy "members read team workspaces" on public.team_workspaces for select to authenticated
  using (private.organization_role_for(organization_id) is not null);
create policy "developers create team workspaces" on public.team_workspaces for insert to authenticated
  with check (private.organization_role_for(organization_id) in ('owner', 'admin', 'developer') and created_by = (select auth.uid()));
create policy "developers update team workspaces" on public.team_workspaces for update to authenticated
  using (private.organization_role_for(organization_id) in ('owner', 'admin', 'developer'))
  with check (private.organization_role_for(organization_id) in ('owner', 'admin', 'developer'));

create policy "members read team workspace projects" on public.team_workspace_projects for select to authenticated
  using (private.can_access_team_workspace(workspace_id));
create policy "developers write team workspace projects" on public.team_workspace_projects for all to authenticated
  using (private.can_write_team_workspace(workspace_id))
  with check (private.can_write_team_workspace(workspace_id));

create policy "members read team tasks" on public.team_tasks for select to authenticated
  using (private.can_access_team_workspace(workspace_id));
create policy "developers write team tasks" on public.team_tasks for all to authenticated
  using (private.can_write_team_workspace(workspace_id))
  with check (private.can_write_team_workspace(workspace_id));

create policy "members read team decisions" on public.team_decisions for select to authenticated
  using (private.can_access_team_workspace(workspace_id));
create policy "developers write team decisions" on public.team_decisions for all to authenticated
  using (private.can_write_team_workspace(workspace_id))
  with check (private.can_write_team_workspace(workspace_id));

create policy "members read team evidence" on public.team_evidence for select to authenticated
  using (private.can_access_team_workspace(workspace_id));
create policy "developers write team evidence" on public.team_evidence for all to authenticated
  using (private.can_write_team_workspace(workspace_id))
  with check (private.can_write_team_workspace(workspace_id));

create policy "users manage own team devices" on public.team_devices for all to authenticated
  using (user_id = (select auth.uid()) and private.organization_role_for(organization_id) is not null)
  with check (user_id = (select auth.uid()) and private.organization_role_for(organization_id) is not null);
create policy "members read accepted operations" on public.team_accepted_operations for select to authenticated
  using (private.organization_role_for(organization_id) is not null);
create policy "active devices create own accepted operations" on public.team_accepted_operations for insert to authenticated
  with check (
    actor_id = (select auth.uid()) and exists (
      select 1 from public.team_devices device
      where device.id = device_id and device.user_id = (select auth.uid())
        and device.organization_id = team_accepted_operations.organization_id and device.revoked_at is null
    )
  );
create policy "members read team change events" on public.team_change_events for select to authenticated
  using (private.organization_role_for(organization_id) is not null);

grant select, insert, update, delete on public.team_workspaces, public.team_workspace_projects, public.team_tasks, public.team_decisions, public.team_evidence, public.team_devices to authenticated;
grant select, insert on public.team_accepted_operations, public.team_change_events to authenticated;

commit;
