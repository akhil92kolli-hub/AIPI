-- A first-time authenticated user must be able to create an organization with
-- RETURNING, then see its owner membership and pilot entitlement.
begin;
insert into auth.users(id) values
  ('66666666-1111-4111-8111-666666666661'),
  ('66666666-1111-4111-8111-666666666662');
set local role authenticated;
select set_config('request.jwt.claim.sub','66666666-1111-4111-8111-666666666661',true);
do $$ declare v_id uuid; begin
  insert into public.organizations(owner_id,name)
    values ('66666666-1111-4111-8111-666666666661','First organization probe')
    returning id into v_id;
  if not exists (select 1 from public.organizations where id = v_id) then
    raise exception 'Owner could not read newly created organization'; end if;
  if not exists (select 1 from public.organization_memberships
    where organization_id = v_id and user_id = '66666666-1111-4111-8111-666666666661'
      and role = 'owner') then raise exception 'Owner membership missing'; end if;
  if not exists (select 1 from public.team_entitlements where organization_id = v_id)
    then raise exception 'Pilot entitlement missing'; end if;
end $$;
select set_config('request.jwt.claim.sub','66666666-1111-4111-8111-666666666662',true);
do $$ begin
  if exists (select 1 from public.organizations where name = 'First organization probe')
    then raise exception 'Nonmember can see organization'; end if;
end $$;
rollback;
