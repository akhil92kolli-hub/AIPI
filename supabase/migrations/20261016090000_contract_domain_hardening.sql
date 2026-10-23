-- Canonical contract identity, JSON shape guards, lifecycle timestamps, and
-- explicit local-workspace/cloud-repository ownership.
alter table public.api_contracts add column if not exists direction text not null default 'request';
alter table public.api_contracts add constraint api_contracts_direction_check check (direction in ('request', 'response'));
alter table public.api_contracts add constraint api_contracts_schema_shape_check check (jsonb_typeof(schema) = 'object' and jsonb_typeof(schema -> 'fields') = 'array');
alter table public.api_contracts add constraint api_contracts_consumers_shape_check check (jsonb_typeof(consumers) = 'array');

alter table public.api_contract_versions add column if not exists direction text not null default 'request';
alter table public.api_contract_versions add constraint api_contract_versions_direction_check check (direction in ('request', 'response'));
alter table public.api_contract_versions add constraint api_contract_versions_schema_shape_check check (jsonb_typeof(schema) = 'object' and jsonb_typeof(schema -> 'fields') = 'array');
alter table public.api_contract_versions add constraint api_contract_versions_consumers_shape_check check (jsonb_typeof(consumers) = 'array');

alter table public.api_contracts drop constraint if exists api_contracts_organization_id_repository_method_route_key;
alter table public.api_contracts add constraint api_contracts_identity_key unique (organization_id, repository, method, route, direction);
alter table public.api_contract_versions drop constraint if exists api_contract_versions_organization_id_repository_method_route_content_hash_key;
alter table public.api_contract_versions add constraint api_contract_versions_identity_hash_key unique (organization_id, repository, method, route, direction, content_hash);

create index if not exists projects_owner_idx on public.projects (owner_id);
create index if not exists organizations_owner_idx on public.organizations (owner_id);
create index if not exists api_contracts_consumers_gin_idx on public.api_contracts using gin (consumers jsonb_path_ops);

create or replace function private.stamp_updated_at() returns trigger language plpgsql security invoker set search_path = '' as $$
begin
  new.updated_at := now();
  return new;
end;
$$;
revoke all on function private.stamp_updated_at() from public, anon, authenticated;
drop trigger if exists stamp_projects_updated_at on public.projects;
create trigger stamp_projects_updated_at before update on public.projects for each row execute function private.stamp_updated_at();
drop trigger if exists stamp_contracts_updated_at on public.api_contracts;
create trigger stamp_contracts_updated_at before update on public.api_contracts for each row execute function private.stamp_updated_at();

create table public.repositories (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  canonical_name text not null check (canonical_name = lower(canonical_name) and char_length(canonical_name) between 1 and 240),
  display_name text not null check (char_length(display_name) between 1 and 240),
  remote_url text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, canonical_name)
);
create index repositories_org_idx on public.repositories (organization_id);
alter table public.repositories enable row level security;
create policy "members can read repositories" on public.repositories for select to authenticated using (private.organization_role_for(organization_id) is not null);
create policy "developers can create repositories" on public.repositories for insert to authenticated with check (private.organization_role_for(organization_id) in ('owner', 'admin', 'developer'));
create policy "developers can update repositories" on public.repositories for update to authenticated using (private.organization_role_for(organization_id) in ('owner', 'admin', 'developer')) with check (private.organization_role_for(organization_id) in ('owner', 'admin', 'developer'));
create policy "admins can delete repositories" on public.repositories for delete to authenticated using (private.organization_role_for(organization_id) in ('owner', 'admin'));
grant select, insert, update, delete on public.repositories to authenticated;
create trigger stamp_repositories_updated_at before update on public.repositories for each row execute function private.stamp_updated_at();

alter table public.api_contracts add column if not exists repository_id uuid references public.repositories(id) on delete set null;
create index if not exists api_contracts_repository_id_idx on public.api_contracts (repository_id) where repository_id is not null;

create table public.workspace_project_bindings (
  owner_id uuid not null references auth.users(id) on delete cascade,
  local_project_id text not null,
  repository_id uuid not null references public.repositories(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (owner_id, local_project_id),
  unique (owner_id, repository_id)
);
alter table public.workspace_project_bindings enable row level security;
create policy "users manage their workspace bindings" on public.workspace_project_bindings for all to authenticated using ((select auth.uid()) = owner_id) with check ((select auth.uid()) = owner_id);
grant select, insert, update, delete on public.workspace_project_bindings to authenticated;

create or replace function public.capture_api_contract_version() returns trigger language plpgsql security invoker set search_path = '' as $$
declare version_hash text; version_id uuid;
begin
  version_hash := md5(jsonb_build_object('organization_id', new.organization_id, 'repository', new.repository, 'method', new.method, 'route', new.route, 'direction', new.direction, 'revision', new.revision, 'source_file', new.source_file, 'source_line', new.source_line, 'schema', new.schema, 'consumers', new.consumers)::text);
  select id into version_id from public.api_contract_versions where organization_id = new.organization_id and repository = new.repository and method = new.method and route = new.route and direction = new.direction and content_hash = version_hash;
  if version_id is null then
    begin
      insert into public.api_contract_versions (organization_id, contract_id, repository, method, route, direction, revision, source_file, source_line, schema, consumers, content_hash)
      values (new.organization_id, new.id, new.repository, new.method, new.route, new.direction, new.revision, new.source_file, new.source_line, new.schema, new.consumers, version_hash) returning id into version_id;
    exception when unique_violation then
      select id into version_id from public.api_contract_versions where organization_id = new.organization_id and repository = new.repository and method = new.method and route = new.route and direction = new.direction and content_hash = version_hash;
    end;
  end if;
  insert into public.registry_audit_events (organization_id, contract_version_id, event_type, repository, method, route, metadata)
  values (new.organization_id, version_id, 'contract.published', new.repository, new.method, new.route, jsonb_build_object('direction', new.direction, 'revision', new.revision, 'content_hash', version_hash));
  return new;
end;
$$;
revoke all on function public.capture_api_contract_version() from public, anon, authenticated;
drop trigger if exists capture_api_contract_version on public.api_contracts;
create trigger capture_api_contract_version after insert or update of direction, revision, source_file, source_line, schema, consumers on public.api_contracts for each row execute function public.capture_api_contract_version();
