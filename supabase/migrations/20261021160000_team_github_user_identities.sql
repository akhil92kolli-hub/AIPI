-- GitHub App OAuth identities are written only after the server exchanges an
-- authorization code and queries GitHub /user. Browser rows cannot assert IDs.
begin;
create table public.team_github_user_identities (
  user_id uuid primary key references auth.users(id) on delete cascade,
  github_user_id bigint not null unique check (github_user_id > 0),
  github_login text not null check (char_length(github_login) between 1 and 200),
  verified_at timestamptz not null default now()
);
alter table public.team_github_user_identities enable row level security;
create policy "users read their verified github identity" on public.team_github_user_identities
  for select to authenticated using (user_id = (select auth.uid()));
grant select on public.team_github_user_identities to authenticated;
revoke insert, update, delete on public.team_github_user_identities from authenticated;
commit;
