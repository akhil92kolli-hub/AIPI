begin;
select plan(7);

insert into auth.users(id,instance_id,aud,role,email,encrypted_password,email_confirmed_at,
  raw_app_meta_data,raw_user_meta_data,created_at,updated_at)
values('00000000-0000-4000-8000-000000000701','00000000-0000-0000-0000-000000000000',
  'authenticated','authenticated','deploy-owner@example.test','',now(),'{}','{}',now(),now());
insert into public.organizations(id,owner_id,name)
values('00000000-0000-4000-8000-000000000702','00000000-0000-4000-8000-000000000701','Deployment control');
insert into public.team_workspaces(id,organization_id,name,created_by)
values('00000000-0000-4000-8000-000000000703','00000000-0000-4000-8000-000000000702',
  'Deployment test','00000000-0000-4000-8000-000000000701');

select ok(not has_table_privilege('authenticated','public.team_deployment_cohorts','SELECT'),
  'deployment cohorts are not directly readable by a workspace member');
select ok(not has_function_privilege('authenticated',
  'public.apply_team_deployment_event(uuid,uuid,text,bigint,text,jsonb)','EXECUTE'),
  'deployment observations require the service broker');

set local role service_role;
insert into public.team_workspace_projects(workspace_id,project_key,provider_repository_id,repository,remote_url)
values('00000000-0000-4000-8000-000000000703','prj_deploy_demo','711','acme/deploy',
  'https://github.com/acme/deploy');

select is((public.apply_team_deployment_event(
  '00000000-0000-4000-8000-000000000704','00000000-0000-4000-8000-000000000703',
  'production',0,'test-controller',jsonb_build_object('projectKey','prj_deploy_demo',
    'sourceBindingId',(select source_id from public.team_source_bindings
      where workspace_id='00000000-0000-4000-8000-000000000703' and project_key='prj_deploy_demo'),
    'cohortId','stable','revision',repeat('a',40),'artifactDigest','sha256:'||repeat('b',64),'active',true))
  ->>'generation'),'1','first authenticated controller event advances generation');
select is((public.apply_team_deployment_event(
  '00000000-0000-4000-8000-000000000704','00000000-0000-4000-8000-000000000703',
  'production',0,'test-controller',jsonb_build_object('projectKey','prj_deploy_demo',
    'sourceBindingId',(select source_id from public.team_source_bindings
      where workspace_id='00000000-0000-4000-8000-000000000703' and project_key='prj_deploy_demo'),
    'cohortId','stable','revision',repeat('a',40),'artifactDigest','sha256:'||repeat('b',64),'active',true))
  ->>'duplicate'),'true','a lost acknowledgment retry is idempotent');
select throws_ok(format(
  'select public.apply_team_deployment_event(%L::uuid,%L::uuid,%L,0,%L,%L::jsonb)',
  '00000000-0000-4000-8000-000000000705','00000000-0000-4000-8000-000000000703',
  'production','test-controller',jsonb_build_object('projectKey','prj_deploy_demo',
    'sourceBindingId',(select source_id from public.team_source_bindings
      where workspace_id='00000000-0000-4000-8000-000000000703' and project_key='prj_deploy_demo'),
    'cohortId','canary','revision',repeat('c',40),'artifactDigest','sha256:'||repeat('d',64),'active',true)::text),
  '40001','DEPLOYMENT_GENERATION_CHANGED',
  'an out-of-order cohort event cannot overwrite a later generation');
select is((select generation::text from public.team_deployment_environments
  where workspace_id='00000000-0000-4000-8000-000000000703' and environment_id='production'),
  '1','rejected stale event does not advance deployment generation');
select is((public.apply_team_deployment_event(
  '00000000-0000-4000-8000-000000000705','00000000-0000-4000-8000-000000000703',
  'production',1,'test-controller',jsonb_build_object('projectKey','prj_deploy_demo',
    'sourceBindingId',(select source_id from public.team_source_bindings
      where workspace_id='00000000-0000-4000-8000-000000000703' and project_key='prj_deploy_demo'),
    'cohortId','canary','revision',repeat('c',40),'artifactDigest','sha256:'||repeat('d',64),'active',true))
  ->>'generation'),'2','a later rollout records a new active cohort');

select * from finish();
rollback;
