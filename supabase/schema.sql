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
