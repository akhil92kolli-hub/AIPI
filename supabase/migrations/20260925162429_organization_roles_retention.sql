create schema if not exists private;
revoke all on schema private from public, anon;
grant usage on schema private to authenticated;

create type public.organization_role as enum ('owner', 'admin', 'developer', 'viewer');

create table public.organization_memberships (
  organization_id uuid not null references public.organizations(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role public.organization_role not null default 'viewer',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (organization_id, user_id)
);

create index organization_memberships_user_org_idx
  on public.organization_memberships (user_id, organization_id);

insert into public.organization_memberships (organization_id, user_id, role)
select id, owner_id, 'owner'::public.organization_role from public.organizations
on conflict (organization_id, user_id) do update set role = 'owner';

create or replace function private.organization_role_for(p_organization_id uuid, p_user_id uuid default auth.uid())
returns public.organization_role
language sql
stable
security definer
set search_path = ''
as $$
  select membership.role
  from public.organization_memberships as membership
  where membership.organization_id = p_organization_id
    and membership.user_id = p_user_id
$$;

revoke all on function private.organization_role_for(uuid, uuid) from public, anon;
grant execute on function private.organization_role_for(uuid, uuid) to authenticated;

create or replace function private.add_organization_owner_membership()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.organization_memberships (organization_id, user_id, role)
  values (new.id, new.owner_id, 'owner')
  on conflict (organization_id, user_id) do update set role = 'owner', updated_at = now();
  return new;
end;
$$;

revoke all on function private.add_organization_owner_membership() from public, anon, authenticated;
drop trigger if exists add_organization_owner_membership on public.organizations;
create trigger add_organization_owner_membership
after insert on public.organizations
for each row execute function private.add_organization_owner_membership();

create or replace function private.prevent_organization_owner_change()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if new.owner_id is distinct from old.owner_id then
    raise exception 'Organization ownership transfer is not enabled; use the audited ownership-transfer workflow';
  end if;
  return new;
end;
$$;

revoke all on function private.prevent_organization_owner_change() from public, anon, authenticated;
drop trigger if exists prevent_organization_owner_change on public.organizations;
create trigger prevent_organization_owner_change
before update of owner_id on public.organizations
for each row execute function private.prevent_organization_owner_change();

alter table public.organization_memberships enable row level security;
revoke all on public.organization_memberships from anon;
grant select, insert, update, delete on public.organization_memberships to authenticated;

create policy "members can read organization memberships"
on public.organization_memberships for select to authenticated
using (private.organization_role_for(organization_id) is not null);

create policy "admins can invite organization members"
on public.organization_memberships for insert to authenticated
with check (
  private.organization_role_for(organization_id) in ('owner', 'admin')
  and role <> 'owner'
);

create policy "admins can update organization members"
on public.organization_memberships for update to authenticated
using (private.organization_role_for(organization_id) in ('owner', 'admin') and role <> 'owner')
with check (private.organization_role_for(organization_id) in ('owner', 'admin') and role <> 'owner');

create policy "admins can remove organization members"
on public.organization_memberships for delete to authenticated
using (private.organization_role_for(organization_id) in ('owner', 'admin') and role <> 'owner');

drop policy if exists "organization owners can read" on public.organizations;
drop policy if exists "organization owners can create" on public.organizations;
drop policy if exists "organization owners can update" on public.organizations;
drop policy if exists "organization owners can delete" on public.organizations;
create policy "members can read organizations" on public.organizations for select to authenticated
using (private.organization_role_for(id) is not null);
create policy "users can create organizations" on public.organizations for insert to authenticated
with check ((select auth.uid()) = owner_id);
create policy "owners and admins can update organizations" on public.organizations for update to authenticated
using (private.organization_role_for(id) in ('owner', 'admin'))
with check (private.organization_role_for(id) in ('owner', 'admin'));
create policy "owners can delete organizations" on public.organizations for delete to authenticated
using (private.organization_role_for(id) = 'owner');

drop policy if exists "organization owners can read contracts" on public.api_contracts;
drop policy if exists "organization owners can create contracts" on public.api_contracts;
drop policy if exists "organization owners can update contracts" on public.api_contracts;
drop policy if exists "organization owners can delete contracts" on public.api_contracts;
create policy "members can read contracts" on public.api_contracts for select to authenticated
using (private.organization_role_for(organization_id) is not null);
create policy "developers can create contracts" on public.api_contracts for insert to authenticated
with check (private.organization_role_for(organization_id) in ('owner', 'admin', 'developer'));
create policy "developers can update contracts" on public.api_contracts for update to authenticated
using (private.organization_role_for(organization_id) in ('owner', 'admin', 'developer'))
with check (private.organization_role_for(organization_id) in ('owner', 'admin', 'developer'));
create policy "admins can delete contracts" on public.api_contracts for delete to authenticated
using (private.organization_role_for(organization_id) in ('owner', 'admin'));

drop policy if exists "organization owners can read contract versions" on public.api_contract_versions;
drop policy if exists "organization owners can publish contract versions" on public.api_contract_versions;
drop policy if exists "organization owners can read registry audit" on public.registry_audit_events;
drop policy if exists "organization owners can append registry audit" on public.registry_audit_events;
create policy "members can read contract versions" on public.api_contract_versions for select to authenticated
using (private.organization_role_for(organization_id) is not null);
create policy "developers can publish contract versions" on public.api_contract_versions for insert to authenticated
with check (private.organization_role_for(organization_id) in ('owner', 'admin', 'developer'));
create policy "members can read registry audit" on public.registry_audit_events for select to authenticated
using (private.organization_role_for(organization_id) is not null);
create policy "developers can append registry audit" on public.registry_audit_events for insert to authenticated
with check (private.organization_role_for(organization_id) in ('owner', 'admin', 'developer'));

create table public.organization_retention_policies (
  organization_id uuid primary key references public.organizations(id) on delete cascade,
  contract_version_days integer not null default 365 check (contract_version_days between 7 and 3650),
  audit_event_days integer not null default 365 check (audit_event_days between 7 and 3650),
  updated_by uuid not null default auth.uid() references auth.users(id) on delete restrict,
  updated_at timestamptz not null default now()
);

create index organization_retention_updated_by_idx
  on public.organization_retention_policies (updated_by);

create or replace function private.stamp_retention_policy()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  new.updated_by := auth.uid();
  new.updated_at := now();
  return new;
end;
$$;
revoke all on function private.stamp_retention_policy() from public, anon, authenticated;
create trigger stamp_retention_policy before insert or update on public.organization_retention_policies
for each row execute function private.stamp_retention_policy();

alter table public.organization_retention_policies enable row level security;
revoke all on public.organization_retention_policies from anon;
grant select, insert, update on public.organization_retention_policies to authenticated;

create policy "members can read retention policy"
on public.organization_retention_policies for select to authenticated
using (private.organization_role_for(organization_id) is not null);
create policy "admins can create retention policy"
on public.organization_retention_policies for insert to authenticated
with check (private.organization_role_for(organization_id) in ('owner', 'admin'));
create policy "admins can update retention policy"
on public.organization_retention_policies for update to authenticated
using (private.organization_role_for(organization_id) in ('owner', 'admin'))
with check (private.organization_role_for(organization_id) in ('owner', 'admin'));

create or replace function public.apply_organization_retention(p_organization_id uuid)
returns table (deleted_versions bigint, deleted_audit_events bigint)
language plpgsql
security definer
set search_path = ''
as $$
declare
  policy_record public.organization_retention_policies%rowtype;
begin
  if private.organization_role_for(p_organization_id) not in ('owner', 'admin') then
    raise exception 'Only organization owners and admins can apply retention';
  end if;
  select * into policy_record
  from public.organization_retention_policies
  where organization_id = p_organization_id;
  if not found then
    policy_record.contract_version_days := 365;
    policy_record.audit_event_days := 365;
  end if;

  delete from public.registry_audit_events
  where organization_id = p_organization_id
    and created_at < now() - make_interval(days => policy_record.audit_event_days);
  get diagnostics deleted_audit_events = row_count;

  with ranked as (
    select id, row_number() over (partition by repository, method, route order by created_at desc) as version_rank
    from public.api_contract_versions
    where organization_id = p_organization_id
  )
  delete from public.api_contract_versions as versions
  using ranked
  where versions.id = ranked.id
    and ranked.version_rank > 1
    and versions.created_at < now() - make_interval(days => policy_record.contract_version_days);
  get diagnostics deleted_versions = row_count;
  return next;
end;
$$;

revoke all on function public.apply_organization_retention(uuid) from public, anon;
grant execute on function public.apply_organization_retention(uuid) to authenticated;
