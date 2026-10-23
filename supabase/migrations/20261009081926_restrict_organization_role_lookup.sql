-- A role lookup must never disclose another user's membership or role.
create or replace function private.organization_role_for(
  p_organization_id uuid,
  p_user_id uuid default auth.uid()
)
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
    and p_user_id = (select auth.uid())
$$;

revoke all on function private.organization_role_for(uuid, uuid) from public, anon;
grant execute on function private.organization_role_for(uuid, uuid) to authenticated;
