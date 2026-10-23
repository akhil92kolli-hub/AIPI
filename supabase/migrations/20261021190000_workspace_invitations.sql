-- A Team invitation grants membership in one workspace. Legacy account-only
-- invitations remain valid for compatibility, but new UI supplies workspace_id.
begin;
drop trigger enforce_team_seat_limit on public.organization_memberships;
alter table public.team_email_invitations add column workspace_id uuid;
alter table public.team_email_invitations add constraint team_invitation_workspace_org_fkey
  foreign key (organization_id,workspace_id)
  references public.team_workspaces(organization_id,id) on delete cascade;
alter table public.team_email_invitations drop constraint team_email_invitations_organization_id_email_key;
create unique index team_invitation_workspace_email_idx on public.team_email_invitations(workspace_id,email)
  where workspace_id is not null and accepted_at is null;
create unique index team_invitation_legacy_email_idx on public.team_email_invitations(organization_id,email)
  where workspace_id is null and accepted_at is null;

drop policy "team admins read invitations" on public.team_email_invitations;
create policy "workspace admins read invitations" on public.team_email_invitations
  for select to authenticated using (
    email=lower((select auth.jwt()->>'email')) or
    (workspace_id is not null and private.workspace_role_for(workspace_id) in ('owner','admin')) or
    (workspace_id is null and private.organization_role_for(organization_id) in ('owner','admin')));
drop policy "team admins create invitations" on public.team_email_invitations;
create policy "workspace admins create invitations" on public.team_email_invitations
  for insert to authenticated with check (
    invited_by=(select auth.uid()) and accepted_at is null and accepted_by is null and
    ((workspace_id is not null and private.workspace_role_for(workspace_id) in ('owner','admin')) or
     (workspace_id is null and private.organization_role_for(organization_id) in ('owner','admin'))));

create or replace function private.accept_team_email_invitation(p_invitation_id uuid)
returns uuid language plpgsql security definer set search_path = '' as $$
declare v_invitation public.team_email_invitations%rowtype;
  v_user_email text; v_confirmed timestamptz;
begin
  if auth.uid() is null then raise exception 'Authentication required' using errcode='28000'; end if;
  select lower(email),email_confirmed_at into v_user_email,v_confirmed
    from auth.users where id=auth.uid();
  if v_user_email is null or v_confirmed is null then
    raise exception 'A confirmed email account is required' using errcode='42501'; end if;
  select * into v_invitation from public.team_email_invitations where id=p_invitation_id for update;
  if not found or v_invitation.email<>v_user_email then
    raise exception 'Invitation not found for this account' using errcode='42501'; end if;
  if v_invitation.accepted_at is not null or v_invitation.expires_at<=now() then
    raise exception 'Invitation has expired or was already accepted' using errcode='22023'; end if;
  insert into public.organization_memberships(organization_id,user_id,role)
    values(v_invitation.organization_id,auth.uid(),v_invitation.role)
    on conflict(organization_id,user_id) do nothing;
  if v_invitation.workspace_id is not null then
    insert into public.team_workspace_memberships(workspace_id,user_id,role)
      values(v_invitation.workspace_id,auth.uid(),v_invitation.role::text)
      on conflict(workspace_id,user_id) do nothing;
  end if;
  update public.team_email_invitations set accepted_at=now(),accepted_by=auth.uid()
    where id=p_invitation_id;
  return v_invitation.organization_id;
end;
$$;

create function private.enforce_team_workspace_seat_limit() returns trigger
language plpgsql security definer set search_path = '' as $$
declare v_limit integer; v_count integer;
begin
  if new.role='owner' then return new; end if;
  select seat_limit into v_limit from public.team_workspace_subscriptions
    where workspace_id=new.workspace_id for update;
  if v_limit is null then raise exception 'TEAM_ENTITLEMENT_MISSING' using errcode='42501'; end if;
  select count(*) into v_count from public.team_workspace_memberships
    where workspace_id=new.workspace_id;
  if v_count>=v_limit then raise exception 'TEAM_SEAT_LIMIT' using errcode='23514'; end if;
  return new;
end;
$$;
revoke all on function private.enforce_team_workspace_seat_limit() from public,anon,authenticated;
create trigger enforce_team_workspace_seat_limit before insert on public.team_workspace_memberships
  for each row execute function private.enforce_team_workspace_seat_limit();
create function public.remove_team_workspace_member(p_workspace_id uuid,p_user_id uuid)
returns boolean language plpgsql security definer set search_path = '' as $$
declare v_actor_role text; v_target_role text;
begin
  v_actor_role:=private.workspace_role_for(p_workspace_id);
  select role into v_target_role from public.team_workspace_memberships
    where workspace_id=p_workspace_id and user_id=p_user_id for update;
  if v_actor_role not in ('owner','admin') or v_target_role is null or
     v_target_role='owner' or (v_target_role='admin' and v_actor_role<>'owner') then
    raise exception 'WORKSPACE_MEMBERSHIP_CHANGE_DENIED' using errcode='42501';
  end if;
  delete from public.team_workspace_memberships
    where workspace_id=p_workspace_id and user_id=p_user_id;
  return true;
end;
$$;
revoke all on function public.remove_team_workspace_member(uuid,uuid) from public,anon;
grant execute on function public.remove_team_workspace_member(uuid,uuid) to authenticated;
commit;
