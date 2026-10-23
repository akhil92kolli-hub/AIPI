begin;

select plan(3);

insert into auth.users (
  id, instance_id, aud, role, email, encrypted_password,
  email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at
) values
  ('00000000-0000-4000-8000-000000000101', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'role-owner@example.test', '', now(), '{}'::jsonb, '{}'::jsonb, now(), now()),
  ('00000000-0000-4000-8000-000000000102', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'role-viewer@example.test', '', now(), '{}'::jsonb, '{}'::jsonb, now(), now());

insert into public.organizations (id, owner_id, name)
values ('00000000-0000-4000-8000-000000000201', '00000000-0000-4000-8000-000000000101', 'Role lookup regression');

insert into public.organization_memberships (organization_id, user_id, role)
values ('00000000-0000-4000-8000-000000000201', '00000000-0000-4000-8000-000000000102', 'viewer');

set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-000000000101', true);

select is(
  private.organization_role_for('00000000-0000-4000-8000-000000000201', '00000000-0000-4000-8000-000000000101'),
  'owner'::public.organization_role,
  'a user can read their own organization role'
);
select ok(
  private.organization_role_for('00000000-0000-4000-8000-000000000201', '00000000-0000-4000-8000-000000000102') is null,
  'a user cannot inspect another member role'
);

select set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-000000000102', true);
select is(
  private.organization_role_for('00000000-0000-4000-8000-000000000201'),
  'viewer'::public.organization_role,
  'RLS callers still resolve their role through the default user argument'
);

select * from finish();
rollback;
