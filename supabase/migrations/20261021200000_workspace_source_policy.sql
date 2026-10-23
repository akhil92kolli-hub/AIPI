-- Sharing choices are workspace-specific; account defaults are only copied
-- into existing workspaces during migration.
begin;
create table public.team_workspace_source_policies (
  workspace_id uuid primary key references public.team_workspaces(id) on delete cascade,
  sharing_mode text not null default 'metadata_only'
    check (sharing_mode in ('metadata_only','snippets','full_source')),
  updated_by uuid references auth.users(id) on delete set null,
  updated_at timestamptz not null default now()
);
insert into public.team_workspace_source_policies(workspace_id,sharing_mode,updated_by)
select w.id,coalesce(p.sharing_mode,'metadata_only'),p.updated_by
from public.team_workspaces w left join public.team_source_policies p on p.organization_id=w.organization_id;
create function private.initialize_team_workspace_source_policy() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  insert into public.team_workspace_source_policies(workspace_id) values(new.id);
  return new;
end;
$$;
revoke all on function private.initialize_team_workspace_source_policy() from public,anon,authenticated;
create trigger a_initialize_team_workspace_source_policy after insert on public.team_workspaces
  for each row execute function private.initialize_team_workspace_source_policy();
alter table public.team_workspace_source_policies enable row level security;
create policy "members read workspace source policy" on public.team_workspace_source_policies
  for select to authenticated using(private.can_access_team_workspace(workspace_id));
create policy "workspace admins update source policy" on public.team_workspace_source_policies
  for update to authenticated
  using(private.workspace_role_for(workspace_id) in ('owner','admin'))
  with check(private.workspace_role_for(workspace_id) in ('owner','admin') and updated_by=(select auth.uid()));
grant select on public.team_workspace_source_policies to authenticated;
grant update(sharing_mode,updated_by,updated_at) on public.team_workspace_source_policies to authenticated;
revoke update(sharing_mode,updated_by,updated_at) on public.team_source_policies from authenticated;

create or replace function private.enforce_team_source_policy()
returns trigger language plpgsql security definer set search_path = '' as $$
declare v_mode text;
begin
  select sharing_mode into v_mode from public.team_workspace_source_policies
    where workspace_id=new.workspace_id;
  if v_mode is null then raise exception 'SOURCE_POLICY_MISSING' using errcode='42501'; end if;
  if v_mode='metadata_only' then
    if exists (select 1 from jsonb_object_keys(new.payload) as keys(key)
        where key not in ('summary','status','metrics','digest'))
      or char_length(coalesce(new.payload->>'summary',''))>1000
      or (new.payload ? 'metrics' and jsonb_typeof(new.payload->'metrics')<>'object')
      or char_length(new.payload::text)>4000 then
      raise exception 'SOURCE_SHARING_POLICY_DENIED' using errcode='42501'; end if;
  elsif v_mode='snippets' then
    if char_length(coalesce(new.payload->>'snippet',''))>4000 then
      raise exception 'SOURCE_SNIPPET_TOO_LARGE' using errcode='22023'; end if;
  end if;
  return new;
end;
$$;
commit;
