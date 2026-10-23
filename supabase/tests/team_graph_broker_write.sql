begin;
select plan(6);

insert into auth.users
  (id,instance_id,aud,role,email,encrypted_password,email_confirmed_at,
   raw_app_meta_data,raw_user_meta_data,created_at,updated_at)
values
  ('00000000-0000-4000-8000-000000000611','00000000-0000-0000-0000-000000000000','authenticated','authenticated','graph-owner@example.test','',now(),'{}','{}',now(),now()),
  ('00000000-0000-4000-8000-000000000612','00000000-0000-0000-0000-000000000000','authenticated','authenticated','graph-editor@example.test','',now(),'{}','{}',now(),now());
insert into public.organizations(id,owner_id,name)
values('00000000-0000-4000-8000-000000000613','00000000-0000-4000-8000-000000000611','Graph broker test');
insert into public.organization_memberships(organization_id,user_id,role)
values('00000000-0000-4000-8000-000000000613','00000000-0000-4000-8000-000000000612','developer');
insert into public.team_workspaces(id,organization_id,name,created_by)
values('00000000-0000-4000-8000-000000000614','00000000-0000-4000-8000-000000000613','Graph workspace','00000000-0000-4000-8000-000000000611');
insert into public.team_workspace_memberships(workspace_id,user_id,role)
values('00000000-0000-4000-8000-000000000614','00000000-0000-4000-8000-000000000612','developer');
insert into public.team_workspace_projects(workspace_id,project_key)
values('00000000-0000-4000-8000-000000000614','prj_graph_demo');
insert into public.team_devices(id,organization_id,user_id,label)
values('00000000-0000-4000-8000-000000000618',
  '00000000-0000-4000-8000-000000000613',
  '00000000-0000-4000-8000-000000000612','Graph test device');

select ok(not has_function_privilege('authenticated','public.publish_team_graph(uuid,jsonb,jsonb)','EXECUTE'),
  'direct authenticated graph publication is revoked');
select ok(not has_function_privilege('authenticated','public.review_team_graph_edge(uuid,boolean)','EXECUTE'),
  'direct authenticated graph review is revoked');
select ok(not has_function_privilege('authenticated','public.broker_publish_team_graph(uuid,uuid,jsonb,jsonb)','EXECUTE'),
  'authenticated users cannot call the service broker');

set local role service_role;
select is((public.broker_publish_team_graph(
  '00000000-0000-4000-8000-000000000612',
  '00000000-0000-4000-8000-000000000614',
  '[{"projectKey":"prj_graph_demo","nodeKey":"GET /demo","kind":"contract","label":"Demo","revisionCommit":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}]'::jsonb,
  '[]'::jsonb)->>'nodesProcessed'), '1',
  'current developer can publish through the service broker');

reset role;
delete from public.team_workspace_memberships
where workspace_id='00000000-0000-4000-8000-000000000614'
  and user_id='00000000-0000-4000-8000-000000000612';
set local role service_role;
select throws_ok($$select public.broker_publish_team_graph(
  '00000000-0000-4000-8000-000000000612',
  '00000000-0000-4000-8000-000000000614','[]'::jsonb,'[]'::jsonb)$$,
  '42501','WORKSPACE_WRITE_DENIED',
  'queued graph publication is denied after workspace revocation');
select throws_ok($$select public.broker_review_team_graph_edge_operation(
  '00000000-0000-4000-8000-000000000612',
  '00000000-0000-4000-8000-000000000614',
  '00000000-0000-4000-8000-000000000618',
  '00000000-0000-4000-8000-000000000619',
  '00000000-0000-4000-8000-000000000615',true,1)$$,
  '42501','WORKSPACE_WRITE_DENIED',
  'queued graph review is denied after workspace revocation');

select * from finish();
rollback;
