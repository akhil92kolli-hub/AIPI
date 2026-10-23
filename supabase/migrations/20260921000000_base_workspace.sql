-- Base account-owned workspace tables. Migrations are the authoritative schema.
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
drop policy if exists "profiles are self-readable" on public.profiles;
drop policy if exists "profiles are self-writable" on public.profiles;
drop policy if exists "profiles can create themselves" on public.profiles;
drop policy if exists "projects are owner-readable" on public.projects;
drop policy if exists "projects are owner-writable" on public.projects;
create policy "profiles are self-readable" on public.profiles for select using ((select auth.uid()) = id);
create policy "profiles can create themselves" on public.profiles for insert with check ((select auth.uid()) = id);
create policy "projects are owner-readable" on public.projects for select using ((select auth.uid()) = owner_id);
create policy "projects are owner-writable" on public.projects for all using ((select auth.uid()) = owner_id) with check ((select auth.uid()) = owner_id);

grant select, insert, update on public.profiles to authenticated;
grant select, insert, update, delete on public.projects to authenticated;
