begin;
select plan(6);

insert into auth.users
  (id,instance_id,aud,role,email,encrypted_password,email_confirmed_at,
   raw_app_meta_data,raw_user_meta_data,created_at,updated_at)
values('00000000-0000-4000-8000-000000000651',
  '00000000-0000-0000-0000-000000000000','authenticated','authenticated',
  'review-owner@example.test','',now(),'{}','{}',now(),now());
insert into public.organizations(id,owner_id,name)
values('00000000-0000-4000-8000-000000000652',
  '00000000-0000-4000-8000-000000000651','Graph review operations');
insert into public.team_workspaces(id,organization_id,name,created_by)
values('00000000-0000-4000-8000-000000000653',
  '00000000-0000-4000-8000-000000000652','Review workspace',
  '00000000-0000-4000-8000-000000000651');
insert into public.team_workspace_projects(workspace_id,project_key)
values('00000000-0000-4000-8000-000000000653','prj_review_demo');
insert into public.team_devices(id,organization_id,user_id,label)
values('00000000-0000-4000-8000-000000000654',
  '00000000-0000-4000-8000-000000000652',
  '00000000-0000-4000-8000-000000000651','Review test device');

select ok(not has_function_privilege('authenticated',
  'public.broker_review_team_graph_edge_operation(uuid,uuid,uuid,uuid,uuid,boolean,bigint)',
  'EXECUTE'), 'review operation is service-broker only');

set local role service_role;
select public.broker_publish_team_graph(
  '00000000-0000-4000-8000-000000000651',
  '00000000-0000-4000-8000-000000000653',
  '[{"projectKey":"prj_review_demo","nodeKey":"GET /demo","kind":"contract","label":"Demo","revisionCommit":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"},
    {"projectKey":"prj_review_demo","nodeKey":"Demo caller","kind":"caller","label":"Caller","revisionCommit":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}]'::jsonb,
  '[{"fromProjectKey":"prj_review_demo","fromNodeKey":"GET /demo",
    "toProjectKey":"prj_review_demo","toNodeKey":"Demo caller",
    "relation":"consumed_by","evidenceKind":"static","evidenceKey":"test-edge",
    "revisionSet":[{"projectKey":"prj_review_demo","commit":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}]}]'::jsonb);

select is((public.broker_review_team_graph_edge_operation(
  '00000000-0000-4000-8000-000000000651',
  '00000000-0000-4000-8000-000000000653',
  '00000000-0000-4000-8000-000000000654',
  '00000000-0000-4000-8000-000000000655',
  (select id from public.team_graph_edges where evidence_key='test-edge'),true,1)
  ->>'version'), '2', 'first review advances the edge version');
select is((public.broker_review_team_graph_edge_operation(
  '00000000-0000-4000-8000-000000000651',
  '00000000-0000-4000-8000-000000000653',
  '00000000-0000-4000-8000-000000000654',
  '00000000-0000-4000-8000-000000000655',
  (select id from public.team_graph_edges where evidence_key='test-edge'),true,1)
  ->>'wasDuplicate'), 'true', 'lost acknowledgment retry does not repeat the review');
select throws_ok(format(
  'select public.broker_review_team_graph_edge_operation(%L::uuid,%L::uuid,%L::uuid,%L::uuid,%L::uuid,false,1)',
  '00000000-0000-4000-8000-000000000651',
  '00000000-0000-4000-8000-000000000653',
  '00000000-0000-4000-8000-000000000654',
  '00000000-0000-4000-8000-000000000656',
  (select id from public.team_graph_edges where evidence_key='test-edge')),
  '40001','GRAPH_REVIEW_VERSION_CONFLICT',
  'a delayed offline review cannot overwrite the current state');
select is((select confirmation_state || ':' || version from public.team_graph_edges
  where evidence_key='test-edge'), 'confirmed:2',
  'a rejected stale review leaves the accepted decision intact');
select throws_ok(format(
  'select public.broker_review_team_graph_edge_operation(%L::uuid,%L::uuid,%L::uuid,%L::uuid,%L::uuid,false,2)',
  '00000000-0000-4000-8000-000000000651',
  '00000000-0000-4000-8000-000000000653',
  '00000000-0000-4000-8000-000000000654',
  '00000000-0000-4000-8000-000000000655',
  (select id from public.team_graph_edges where evidence_key='test-edge')),
  '40001','OPERATION_ID_REUSED',
  'one operation ID cannot be reused for a different review');

select * from finish();
rollback;
