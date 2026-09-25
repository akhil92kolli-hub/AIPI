create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  display_name text,
  created_at timestamptz not null default now()
);

create table if not exists public.projects (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  name text not null check (char_length(name) between 1 and 120),
  description text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.profiles enable row level security;
alter table public.projects enable row level security;
create policy "profiles are self-readable" on public.profiles for select using (auth.uid() = id);
create policy "profiles are self-writable" on public.profiles for insert with check (auth.uid() = id);
create policy "projects are owner-readable" on public.projects for select using (auth.uid() = owner_id);
create policy "projects are owner-writable" on public.projects for all using (auth.uid() = owner_id) with check (auth.uid() = owner_id);

create table if not exists public.organizations (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  name text not null check (char_length(name) between 1 and 120),
  created_at timestamptz not null default now()
);

create table if not exists public.api_contracts (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  repository text not null check (char_length(repository) between 1 and 240),
  method text not null check (method in ('GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS')),
  route text not null check (route like '/%'),
  revision text not null default 'working-tree',
  source_file text,
  source_line integer check (source_line is null or source_line > 0),
  schema jsonb not null default '{"fields": []}'::jsonb,
  consumers jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, repository, method, route)
);

create index if not exists api_contracts_route_idx on public.api_contracts (organization_id, method, route);

alter table public.organizations enable row level security;
alter table public.api_contracts enable row level security;

create policy "organization owners can read" on public.organizations for select to authenticated using ((select auth.uid()) = owner_id);
create policy "organization owners can create" on public.organizations for insert to authenticated with check ((select auth.uid()) = owner_id);
create policy "organization owners can update" on public.organizations for update to authenticated using ((select auth.uid()) = owner_id) with check ((select auth.uid()) = owner_id);
create policy "organization owners can delete" on public.organizations for delete to authenticated using ((select auth.uid()) = owner_id);
create policy "organization owners can read contracts" on public.api_contracts for select to authenticated using (exists (select 1 from public.organizations where organizations.id = api_contracts.organization_id and organizations.owner_id = (select auth.uid())));
create policy "organization owners can create contracts" on public.api_contracts for insert to authenticated with check (exists (select 1 from public.organizations where organizations.id = api_contracts.organization_id and organizations.owner_id = (select auth.uid())));
create policy "organization owners can update contracts" on public.api_contracts for update to authenticated using (exists (select 1 from public.organizations where organizations.id = api_contracts.organization_id and organizations.owner_id = (select auth.uid()))) with check (exists (select 1 from public.organizations where organizations.id = api_contracts.organization_id and organizations.owner_id = (select auth.uid())));
create policy "organization owners can delete contracts" on public.api_contracts for delete to authenticated using (exists (select 1 from public.organizations where organizations.id = api_contracts.organization_id and organizations.owner_id = (select auth.uid())));

grant select, insert, update, delete on public.organizations to authenticated;
grant select, insert, update, delete on public.api_contracts to authenticated;

create table if not exists public.api_contract_versions (
  id uuid primary key default gen_random_uuid(), organization_id uuid not null references public.organizations(id) on delete cascade,
  contract_id uuid references public.api_contracts(id) on delete set null, repository text not null, method text not null,
  route text not null, revision text not null, source_file text, source_line integer, schema jsonb not null, consumers jsonb not null,
  content_hash text not null check (char_length(content_hash) = 32), published_by uuid default auth.uid() references auth.users(id) on delete set null,
  created_at timestamptz not null default now(), unique (organization_id, repository, method, route, content_hash)
);
create index if not exists api_contract_versions_lookup_idx on public.api_contract_versions (organization_id, repository, method, route, created_at desc);
create index if not exists api_contract_versions_publisher_idx on public.api_contract_versions (published_by) where published_by is not null;

create table if not exists public.registry_audit_events (
  id uuid primary key default gen_random_uuid(), organization_id uuid not null references public.organizations(id) on delete cascade,
  contract_version_id uuid references public.api_contract_versions(id) on delete set null, event_type text not null,
  repository text not null, method text not null, route text not null, actor_id uuid default auth.uid() references auth.users(id) on delete set null,
  metadata jsonb not null default '{}'::jsonb, created_at timestamptz not null default now()
);
create index if not exists registry_audit_events_org_created_idx on public.registry_audit_events (organization_id, created_at desc);
create index if not exists registry_audit_events_actor_idx on public.registry_audit_events (actor_id) where actor_id is not null;

alter table public.api_contract_versions enable row level security;
alter table public.registry_audit_events enable row level security;
create policy "organization owners can read contract versions" on public.api_contract_versions for select to authenticated using (exists (select 1 from public.organizations where organizations.id = api_contract_versions.organization_id and organizations.owner_id = (select auth.uid())));
create policy "organization owners can publish contract versions" on public.api_contract_versions for insert to authenticated with check (exists (select 1 from public.organizations where organizations.id = api_contract_versions.organization_id and organizations.owner_id = (select auth.uid())));
create policy "organization owners can read registry audit" on public.registry_audit_events for select to authenticated using (exists (select 1 from public.organizations where organizations.id = registry_audit_events.organization_id and organizations.owner_id = (select auth.uid())));
create policy "organization owners can append registry audit" on public.registry_audit_events for insert to authenticated with check (exists (select 1 from public.organizations where organizations.id = registry_audit_events.organization_id and organizations.owner_id = (select auth.uid())));
grant select, insert on public.api_contract_versions to authenticated;
grant select, insert on public.registry_audit_events to authenticated;

create or replace function public.capture_api_contract_version() returns trigger language plpgsql security invoker set search_path = '' as $$
declare version_hash text; version_id uuid;
begin
  version_hash := md5(jsonb_build_object('organization_id', new.organization_id, 'repository', new.repository, 'method', new.method, 'route', new.route, 'revision', new.revision, 'source_file', new.source_file, 'source_line', new.source_line, 'schema', new.schema, 'consumers', new.consumers)::text);
  select id into version_id from public.api_contract_versions where organization_id = new.organization_id and repository = new.repository and method = new.method and route = new.route and content_hash = version_hash;
  if version_id is null then
    begin
      insert into public.api_contract_versions (organization_id, contract_id, repository, method, route, revision, source_file, source_line, schema, consumers, content_hash)
      values (new.organization_id, new.id, new.repository, new.method, new.route, new.revision, new.source_file, new.source_line, new.schema, new.consumers, version_hash) returning id into version_id;
    exception when unique_violation then
      select id into version_id from public.api_contract_versions where organization_id = new.organization_id and repository = new.repository and method = new.method and route = new.route and content_hash = version_hash;
    end;
  end if;
  insert into public.registry_audit_events (organization_id, contract_version_id, event_type, repository, method, route, metadata)
  values (new.organization_id, version_id, 'contract.published', new.repository, new.method, new.route, jsonb_build_object('revision', new.revision, 'content_hash', version_hash));
  return new;
end;
$$;
revoke all on function public.capture_api_contract_version() from public, anon, authenticated;
drop trigger if exists capture_api_contract_version on public.api_contracts;
create trigger capture_api_contract_version after insert or update of revision, source_file, source_line, schema, consumers on public.api_contracts for each row execute function public.capture_api_contract_version();
