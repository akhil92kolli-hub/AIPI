begin;
select plan(4);
grant insert,select on public.team_tasks to service_role;

insert into auth.users
  (id,instance_id,aud,role,email,encrypted_password,email_confirmed_at,
   raw_app_meta_data,raw_user_meta_data,created_at,updated_at)
values
  ('00000000-0000-4000-8000-000000000711','00000000-0000-0000-0000-000000000000','authenticated','authenticated','write-owner@example.test','',now(),'{}','{}',now(),now()),
  ('00000000-0000-4000-8000-000000000712','00000000-0000-0000-0000-000000000000','authenticated','authenticated','write-editor@example.test','',now(),'{}','{}',now(),now());
insert into public.organizations(id,owner_id,name)
values('00000000-0000-4000-8000-000000000713','00000000-0000-4000-8000-000000000711','Write guard test');
insert into public.organization_memberships(organization_id,user_id,role)
values('00000000-0000-4000-8000-000000000713','00000000-0000-4000-8000-000000000712','developer');
insert into public.team_workspaces(id,organization_id,name,created_by)
values('00000000-0000-4000-8000-000000000714','00000000-0000-4000-8000-000000000713','Write workspace','00000000-0000-4000-8000-000000000711');
insert into public.team_workspace_memberships(workspace_id,user_id,role)
values('00000000-0000-4000-8000-000000000714','00000000-0000-4000-8000-000000000712','developer');

set local role service_role;
select set_config('request.jwt.claim.sub','00000000-0000-4000-8000-000000000712',true);
insert into public.team_tasks(workspace_id,external_id,title,created_by)
  values('00000000-0000-4000-8000-000000000714','task_guard_one','Allowed','00000000-0000-4000-8000-000000000712');
select is((select count(*) from public.team_tasks where workspace_id='00000000-0000-4000-8000-000000000714'),1::bigint,
  'current workspace and organization editor can write through the broker');
reset role;
delete from public.team_workspace_memberships where workspace_id='00000000-0000-4000-8000-000000000714'
  and user_id='00000000-0000-4000-8000-000000000712';
set local role service_role;
select throws_ok($$insert into public.team_tasks(workspace_id,external_id,title,created_by)
  values('00000000-0000-4000-8000-000000000714','task_guard_two','Denied','00000000-0000-4000-8000-000000000712')$$,
  '42501','WORKSPACE_WRITE_DENIED','queued write is denied after workspace membership revocation');
reset role;
insert into public.team_workspace_memberships(workspace_id,user_id,role)
values('00000000-0000-4000-8000-000000000714','00000000-0000-4000-8000-000000000712','developer');
delete from public.organization_memberships where organization_id='00000000-0000-4000-8000-000000000713'
  and user_id='00000000-0000-4000-8000-000000000712';
set local role service_role;
select throws_ok($$insert into public.team_tasks(workspace_id,external_id,title,created_by)
  values('00000000-0000-4000-8000-000000000714','task_guard_three','Denied','00000000-0000-4000-8000-000000000712')$$,
  '42501','WORKSPACE_WRITE_DENIED','queued write is denied after organization membership revocation');
select is((select count(*) from public.team_tasks where workspace_id='00000000-0000-4000-8000-000000000714'),1::bigint,
  'rejected writes did not create task rows');

select * from finish();
rollback;
