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
