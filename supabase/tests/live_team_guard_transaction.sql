begin;
do $accept$
begin
  if private.team_trial_end('2026-01-31 12:00:00+00'::timestamptz) <> '2026-04-30 12:00:00+00'::timestamptz then
    raise exception 'trial end-of-month assertion failed';
  end if;
  if has_table_privilege('authenticated','public.team_graph_nodes','select') or has_table_privilege('authenticated','public.team_graph_edges','select') then
    raise exception 'graph direct-read grant assertion failed';
  end if;
  if has_function_privilege('authenticated','public.publish_team_graph(uuid,jsonb,jsonb)','execute') or has_function_privilege('authenticated','public.review_team_graph_edge(uuid,boolean)','execute') then
    raise exception 'graph direct-write grant assertion failed';
  end if;
  if not has_table_privilege('service_role','public.team_workspace_projects','insert') then
    raise exception 'binding broker service grant assertion failed';
  end if;
end
$accept$;
insert into auth.users
  (id,instance_id,aud,role,email,encrypted_password,email_confirmed_at,
   raw_app_meta_data,raw_user_meta_data,created_at,updated_at)
values
  ('00000000-0000-4000-8000-00000000a711','00000000-0000-0000-0000-000000000000','authenticated','authenticated','live-write-owner@example.test','',now(),'{}','{}',now(),now()),
  ('00000000-0000-4000-8000-00000000a712','00000000-0000-0000-0000-000000000000','authenticated','authenticated','live-write-editor@example.test','',now(),'{}','{}',now(),now());
insert into public.organizations(id,owner_id,name)
values('00000000-0000-4000-8000-00000000a713','00000000-0000-4000-8000-00000000a711','Rollback-only live guard test');
insert into public.organization_memberships(organization_id,user_id,role)
values('00000000-0000-4000-8000-00000000a713','00000000-0000-4000-8000-00000000a712','developer');
insert into public.team_workspaces(id,organization_id,name,created_by)
values('00000000-0000-4000-8000-00000000a714','00000000-0000-4000-8000-00000000a713','Rollback-only workspace','00000000-0000-4000-8000-00000000a711');
insert into public.team_workspace_memberships(workspace_id,user_id,role)
values('00000000-0000-4000-8000-00000000a714','00000000-0000-4000-8000-00000000a712','developer');
set local role service_role;
select set_config('request.jwt.claim.sub','00000000-0000-4000-8000-00000000a712',true);
insert into public.team_tasks(workspace_id,external_id,title,created_by)
values('00000000-0000-4000-8000-00000000a714','task_guard_one','Allowed','00000000-0000-4000-8000-00000000a712');
reset role;
delete from public.team_workspace_memberships
where workspace_id='00000000-0000-4000-8000-00000000a714' and user_id='00000000-0000-4000-8000-00000000a712';
set local role service_role;
do $accept$
begin
  begin
    insert into public.team_tasks(workspace_id,external_id,title,created_by)
    values('00000000-0000-4000-8000-00000000a714','task_guard_two','Denied','00000000-0000-4000-8000-00000000a712');
    raise exception 'revoked workspace write was accepted';
  exception when insufficient_privilege then
    if sqlerrm <> 'WORKSPACE_WRITE_DENIED' then raise; end if;
  end;
end
$accept$;
reset role;
do $accept$
begin
  if (select count(*) from public.team_tasks where workspace_id='00000000-0000-4000-8000-00000000a714') <> 1 then
    raise exception 'rejected write left task row';
  end if;
end
$accept$;
rollback;
