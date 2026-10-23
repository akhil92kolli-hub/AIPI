-- INSERT ... RETURNING checks SELECT RLS before the owner-membership AFTER
-- trigger becomes visible to that check. Let an owner read their own row while
-- the membership is being initialized.
begin;
drop policy "members can read organizations" on public.organizations;
create policy "members can read organizations" on public.organizations
  for select to authenticated
  using (owner_id = (select auth.uid())
    or private.organization_role_for(id) is not null);
commit;
