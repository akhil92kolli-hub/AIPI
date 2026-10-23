-- Email invitations are scoped to an organization and can be accepted only by
-- the authenticated, email-confirmed Supabase user with that exact address.
create table public.team_email_invitations (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  email text not null,
  role public.organization_role not null,
  invited_by uuid not null references auth.users(id),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default (now() + interval '7 days'),
  accepted_at timestamptz,
  accepted_by uuid references auth.users(id),
  constraint team_invite_email_normalized check (email = lower(btrim(email)) and length(email) <= 320),
  constraint team_invite_role check (role in ('admin', 'developer', 'viewer')),
  constraint team_invite_expiry check (expires_at > created_at),
  unique (organization_id, email)
);

create index team_email_invitations_recipient_idx on public.team_email_invitations (email, expires_at)
  where accepted_at is null;
create index team_email_invitations_inviter_idx on public.team_email_invitations (invited_by);
create index team_email_invitations_accepter_idx on public.team_email_invitations (accepted_by)
  where accepted_by is not null;

alter table public.team_email_invitations enable row level security;
revoke all on public.team_email_invitations from anon;
grant select, insert on public.team_email_invitations to authenticated;

create policy "team admins read invitations" on public.team_email_invitations
  for select to authenticated
  using (private.organization_role_for(organization_id) in ('owner', 'admin')
    or email = lower((select auth.jwt() ->> 'email')));

create policy "team admins create invitations" on public.team_email_invitations
  for insert to authenticated
  with check (private.organization_role_for(organization_id) in ('owner', 'admin')
    and invited_by = (select auth.uid()) and accepted_at is null and accepted_by is null);

-- The privileged part lives outside the exposed public schema. It performs
-- identity, expiry, and single-use checks while holding the invitation row lock.
create function private.accept_team_email_invitation(p_invitation_id uuid)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  v_invitation public.team_email_invitations%rowtype;
  v_user_email text;
  v_confirmed timestamptz;
begin
  if auth.uid() is null then raise exception 'Authentication required' using errcode = '28000'; end if;
  select lower(email), email_confirmed_at into v_user_email, v_confirmed
    from auth.users where id = auth.uid();
  if v_user_email is null or v_confirmed is null then
    raise exception 'A confirmed email account is required' using errcode = '42501';
  end if;
  select * into v_invitation from public.team_email_invitations
    where id = p_invitation_id for update;
  if not found or v_invitation.email <> v_user_email then
    raise exception 'Invitation not found for this account' using errcode = '42501';
  end if;
  if v_invitation.accepted_at is not null or v_invitation.expires_at <= now() then
    raise exception 'Invitation has expired or was already accepted' using errcode = '22023';
  end if;
  insert into public.organization_memberships (organization_id, user_id, role)
    values (v_invitation.organization_id, auth.uid(), v_invitation.role)
    on conflict (organization_id, user_id) do nothing;
  update public.team_email_invitations set accepted_at = now(), accepted_by = auth.uid()
    where id = p_invitation_id;
  return v_invitation.organization_id;
end;
$$;

revoke all on function private.accept_team_email_invitation(uuid) from public, anon;
grant execute on function private.accept_team_email_invitation(uuid) to authenticated;

create function public.accept_team_email_invitation(p_invitation_id uuid)
returns uuid language sql security invoker set search_path = '' as $$
  select private.accept_team_email_invitation(p_invitation_id)
$$;
revoke all on function public.accept_team_email_invitation(uuid) from public, anon;
grant execute on function public.accept_team_email_invitation(uuid) to authenticated;
