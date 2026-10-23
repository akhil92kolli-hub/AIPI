-- Signed-delivery handler's database contract: dedup, scoped PRs and trusted CI.
begin;
insert into auth.users(id) values ('33333333-1111-4111-8111-333333333333');
insert into public.organizations(id, owner_id, name) values
 ('33333333-2222-4222-8222-333333333333', '33333333-1111-4111-8111-333333333333', 'PR test');
insert into public.team_workspaces(id, organization_id, name, created_by) values
 ('33333333-3333-4333-8333-333333333333', '33333333-2222-4222-8222-333333333333',
  'PR workspace', '33333333-1111-4111-8111-333333333333');
insert into public.team_workspace_projects
 (workspace_id, project_key, provider_repository_id, repository, remote_url) values
 ('33333333-3333-4333-8333-333333333333', 'prj_provider', '81001', 'acme/provider', 'https://github.com/acme/provider');
insert into public.team_tasks(id,workspace_id,external_id,title,created_by) values
 ('33333333-7777-4777-8777-333333333333','33333333-3333-4333-8333-333333333333',
  'task_pr_demo','Update checkout','33333333-1111-4111-8111-333333333333');
insert into public.team_github_installations(installation_id, organization_id, account_login, connected_by) values
 (91001, '33333333-2222-4222-8222-333333333333', 'acme', '33333333-1111-4111-8111-333333333333');
insert into public.team_ci_producers(organization_id, app_id, name, environment, configured_by) values
 ('33333333-2222-4222-8222-333333333333', 71001, 'trusted-ci', 'ci', '33333333-1111-4111-8111-333333333333');
set local role service_role;
do $$ declare v_result jsonb; begin
  v_result := public.apply_team_github_webhook('33333333-4444-4444-8444-333333333333', 'pull_request',
    '{"installation":{"id":91001},"repository":{"id":81001,"full_name":"acme/provider"},"action":"opened","number":12,"pull_request":{"title":"Update checkout","state":"open","merged":false,"head":{"sha":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"},"base":{"sha":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"}}}'::jsonb);
  if v_result ->> 'processed' <> '1' then raise exception 'PR delivery not applied'; end if;
  v_result := public.apply_team_github_webhook('33333333-4444-4444-8444-333333333333', 'pull_request',
    '{"installation":{"id":91001},"repository":{"id":81001},"action":"opened"}'::jsonb);
  if v_result ->> 'duplicate' <> 'true' then raise exception 'Delivery was not deduplicated'; end if;
  perform public.apply_team_github_webhook('33333333-5555-4555-8555-333333333333', 'check_run',
    '{"installation":{"id":91001},"repository":{"id":81001},"action":"completed","check_run":{"id":61001,"app":{"id":71001},"name":"provider-unit","head_sha":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","conclusion":"success","html_url":"https://github.com/acme/provider/actions/runs/1"}}'::jsonb);
  perform public.apply_team_github_webhook('33333333-6666-4666-8666-333333333333', 'check_run',
    '{"installation":{"id":91001},"repository":{"id":81001},"action":"completed","check_run":{"id":61002,"app":{"id":99999},"name":"untrusted","head_sha":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","conclusion":"success","html_url":"https://github.com/acme/provider/actions/runs/2"}}'::jsonb);
  if (select count(*) from public.team_ci_receipts) <> 1 then
    raise exception 'Untrusted CI producer was accepted'; end if;
end $$;
reset role;
set local role authenticated;
select set_config('request.jwt.claim.sub','33333333-1111-4111-8111-333333333333',true);
do $$ declare v_pr uuid; begin
  select id into v_pr from public.team_pull_requests where number = 12;
  perform public.set_team_pr_target(v_pr,'prj_provider','POST /checkout',
    '[{"projectKey":"prj_provider","commit":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}]'::jsonb);
  perform public.set_team_pr_task(v_pr,'33333333-7777-4777-8777-333333333333');
  if (select task_id from public.team_pull_requests where id = v_pr) <>
    '33333333-7777-4777-8777-333333333333'::uuid then raise exception 'PR task was not saved'; end if;
  if (select changed_node_key from public.team_pull_requests where id = v_pr) <> 'POST /checkout' then
    raise exception 'PR target was not saved'; end if;
  begin
    update public.team_pull_requests set head_sha = repeat('c',40) where id = v_pr;
  exception when insufficient_privilege then null; end;
  if (select head_sha from public.team_pull_requests where id = v_pr) <> repeat('a',40) then
    raise exception 'User forged GitHub head'; end if;
end $$;
rollback;
