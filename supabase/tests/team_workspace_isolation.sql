begin;
select plan(15);

insert into auth.users
  (id,instance_id,aud,role,email,encrypted_password,email_confirmed_at,
   raw_app_meta_data,raw_user_meta_data,created_at,updated_at)
values
  ('00000000-0000-4000-8000-000000000301','00000000-0000-0000-0000-000000000000','authenticated','authenticated','workspace-owner@example.test','',now(),'{}','{}',now(),now()),
  ('00000000-0000-4000-8000-000000000302','00000000-0000-0000-0000-000000000000','authenticated','authenticated','workspace-viewer@example.test','',now(),'{}','{}',now(),now());
insert into public.organizations(id,owner_id,name)
values('00000000-0000-4000-8000-000000000401','00000000-0000-4000-8000-000000000301','Workspace isolation test');
insert into public.organization_memberships(organization_id,user_id,role)
values('00000000-0000-4000-8000-000000000401','00000000-0000-4000-8000-000000000302','viewer');
insert into public.team_workspaces(id,organization_id,name,created_by)
values
 ('00000000-0000-4000-8000-000000000501','00000000-0000-4000-8000-000000000401','Shared','00000000-0000-4000-8000-000000000301'),
 ('00000000-0000-4000-8000-000000000502','00000000-0000-4000-8000-000000000401','Private','00000000-0000-4000-8000-000000000301');
insert into public.team_workspace_memberships(workspace_id,user_id,role)
values('00000000-0000-4000-8000-000000000501','00000000-0000-4000-8000-000000000302','viewer');

select is((select count(*) from public.team_workspace_subscriptions
  where organization_id='00000000-0000-4000-8000-000000000401'),2::bigint,
  'each workspace receives its own subscription');
select is((select trial_started_at from public.team_workspace_subscriptions
  where workspace_id='00000000-0000-4000-8000-000000000501'),
  (select created_at from public.team_workspaces
   where id='00000000-0000-4000-8000-000000000501'),
  'workspace creation fixes trial activation time');
select is((select trial_ends_at from public.team_workspace_subscriptions
  where workspace_id='00000000-0000-4000-8000-000000000501'),
  (select private.team_trial_end(created_at) from public.team_workspaces
   where id='00000000-0000-4000-8000-000000000501'),
  'new workspace receives three calendar months');
select is(private.team_trial_end('2026-01-31 12:00:00+00'::timestamptz),
  '2026-04-30 12:00:00+00'::timestamptz,
  'end-of-month trial activation clamps to the last day');
select is(private.team_trial_end('2026-11-30 12:00:00+00'::timestamptz),
  '2027-02-28 12:00:00+00'::timestamptz,
  'February trial expiry clamps without resetting on reconnect');
select is((select count(*) from public.team_workspace_source_policies
  where workspace_id in ('00000000-0000-4000-8000-000000000501','00000000-0000-4000-8000-000000000502')),2::bigint,
  'each workspace receives its own source policy');

set local role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-4000-8000-000000000302',true);
select is((select count(*) from public.team_workspaces
  where organization_id='00000000-0000-4000-8000-000000000401'),1::bigint,
  'organization membership alone cannot read another workspace');
select ok(not private.can_access_team_workspace('00000000-0000-4000-8000-000000000502'),
  'workspace access helper denies an unjoined workspace');
select is((select count(*) from jsonb_array_elements(
  public.get_team_snapshot('00000000-0000-4000-8000-000000000401')->'entities') as elements(value)
  where elements.value->>'entityType'='workspace'),1::bigint,
  'security-definer snapshot excludes the other workspace');
select ok(not has_table_privilege('authenticated','public.team_github_installations','INSERT'),
  'direct installation grants remain blocked');
select ok(not has_table_privilege('authenticated','public.team_github_user_identities','INSERT'),
  'GitHub identity can only be linked by the verified broker');

reset role;
set local role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-4000-8000-000000000301',true);
select throws_ok($$insert into public.team_workspace_projects
  (workspace_id,project_key,provider,provider_repository_id,repository,remote_url)
  values ('00000000-0000-4000-8000-000000000501','prj_direct_demo','github',
    '4567890','example/direct','https://github.com/example/direct')$$,
  '42501','GITHUB_BINDING_BROKER_REQUIRED',
  'direct database writes cannot assert GitHub repository binding');

reset role;
set local role service_role;
select throws_ok($$select public.bind_team_repository_project(
  '00000000-0000-4000-8000-000000000302',
  '00000000-0000-4000-8000-000000000502','prj_private_demo','1234567',
  'example/private','https://github.com/example/private','.')$$,
  '42501','WORKSPACE_WRITE_DENIED',
  'service broker cannot bind a repository for a nonmember');
select is((public.bind_team_repository_project(
  '00000000-0000-4000-8000-000000000301',
  '00000000-0000-4000-8000-000000000501','prj_owner_demo','1234568',
  'example/shared','https://github.com/example/shared','.') ->> 'provider_repository_id'),
  '1234568','service broker binds a project for the workspace owner');
select throws_ok($$select public.bind_team_repository_project(
  '00000000-0000-4000-8000-000000000301',
  '00000000-0000-4000-8000-000000000501','prj_owner_demo','7654321',
  'example/other','https://github.com/example/other','.')$$,
  '40001','PROJECT_REPOSITORY_CONFLICT',
  'an existing project cannot silently switch GitHub repositories');

select * from finish();
rollback;
