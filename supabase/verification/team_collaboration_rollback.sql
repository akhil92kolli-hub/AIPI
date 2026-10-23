-- Two-user handoff, append deduplication, revision freshness, conflicts and revocation.
-- No records persist after this transaction.
begin;
insert into auth.users (id) values
 ('88888888-8888-4888-8888-888888888888'),
 ('99999999-9999-4999-8999-999999999999');
insert into public.organizations (id, owner_id, name) values
 ('aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa', '88888888-8888-4888-8888-888888888888', 'Handoff test');
insert into public.organization_memberships (organization_id, user_id, role) values
 ('aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa', '99999999-9999-4999-8999-999999999999', 'developer');
insert into public.team_workspaces (id, organization_id, name, created_by) values
 ('aaaaaaaa-2222-4222-8222-aaaaaaaaaaaa', 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa',
  'Handoff workspace', '88888888-8888-4888-8888-888888888888');
insert into public.team_workspace_projects
 (workspace_id, project_key, provider_repository_id, repository, remote_url) values
 ('aaaaaaaa-2222-4222-8222-aaaaaaaaaaaa', 'prj_handoff', '987654321',
  'acme/handoff', 'https://github.com/acme/handoff');
insert into public.team_devices (id, organization_id, user_id, label) values
 ('aaaaaaaa-3333-4333-8333-aaaaaaaaaaaa', 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa',
  '88888888-8888-4888-8888-888888888888', 'Owner device'),
 ('aaaaaaaa-4444-4444-8444-aaaaaaaaaaaa', 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa',
  '99999999-9999-4999-8999-999999999999', 'Teammate device');

set local role authenticated;
select set_config('request.jwt.claim.sub', '88888888-8888-4888-8888-888888888888', true);
do $$
declare v_task uuid; v_first record; v_duplicate record; v_context jsonb;
begin
  select task_id into v_task from public.apply_team_task_operation(
    'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa', 'aaaaaaaa-2222-4222-8222-aaaaaaaaaaaa',
    'aaaaaaaa-3333-4333-8333-aaaaaaaaaaaa', 'aaaaaaaa-5555-4555-8555-aaaaaaaaaaaa',
    'task_handoff', 'Trace checkout', 'Follow the route', 'open',
    '[{"projectKey":"prj_handoff","commit":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}]'::jsonb, 0);
  perform public.apply_team_task_context_operation(
    'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa', 'aaaaaaaa-2222-4222-8222-aaaaaaaaaaaa',
    'aaaaaaaa-3333-4333-8333-aaaaaaaaaaaa', 'aaaaaaaa-6666-4666-8666-aaaaaaaaaaaa',
    v_task, 1, '99999999-9999-4999-8999-999999999999',
    '[{"projectKey":"prj_handoff","target":"POST /checkout"}]'::jsonb,
    '["task_missing"]'::jsonb, '{"source":"workspace","reviewed":true}'::jsonb);
  select * into v_first from public.apply_team_append_operation(
    'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa', 'aaaaaaaa-2222-4222-8222-aaaaaaaaaaaa',
    'aaaaaaaa-3333-4333-8333-aaaaaaaaaaaa', 'aaaaaaaa-7777-4777-8777-aaaaaaaaaaaa',
    'decision', jsonb_build_object('taskId', v_task, 'body', 'Use the canonical checkout route',
      'sourceRefs', jsonb_build_array('src/checkout.ts:12')));
  select * into v_duplicate from public.apply_team_append_operation(
    'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa', 'aaaaaaaa-2222-4222-8222-aaaaaaaaaaaa',
    'aaaaaaaa-3333-4333-8333-aaaaaaaaaaaa', 'aaaaaaaa-7777-4777-8777-aaaaaaaaaaaa',
    'decision', jsonb_build_object('taskId', v_task, 'body', 'Use the canonical checkout route',
      'sourceRefs', jsonb_build_array('src/checkout.ts:12')));
  if v_first.was_duplicate or not v_duplicate.was_duplicate or
     v_first.entity_id <> v_duplicate.entity_id or v_first.change_sequence <> v_duplicate.change_sequence then
    raise exception 'Append operation was not idempotent'; end if;
  begin
    perform public.apply_team_task_operation(
      'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa', 'aaaaaaaa-2222-4222-8222-aaaaaaaaaaaa',
      'aaaaaaaa-3333-4333-8333-aaaaaaaaaaaa', 'aaaaaaaa-5555-4555-8555-aaaaaaaaaaaa',
      'task_handoff', 'Different task', 'Follow the route', 'open',
      '[{"projectKey":"prj_handoff","commit":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}]'::jsonb, 0);
    raise exception 'Reused task operation ID was accepted';
  exception when sqlstate '40001' then null; end;
  begin
    perform public.apply_team_append_operation(
      'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa', 'aaaaaaaa-2222-4222-8222-aaaaaaaaaaaa',
      'aaaaaaaa-3333-4333-8333-aaaaaaaaaaaa', 'aaaaaaaa-7777-4777-8777-aaaaaaaaaaaa',
      'decision', jsonb_build_object('taskId', v_task, 'body', 'Different decision'));
    raise exception 'Reused operation ID was accepted';
  exception when sqlstate '40001' then null; end;
  perform public.apply_team_append_operation(
    'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa', 'aaaaaaaa-2222-4222-8222-aaaaaaaaaaaa',
    'aaaaaaaa-3333-4333-8333-aaaaaaaaaaaa', 'aaaaaaaa-8888-4888-8888-aaaaaaaaaaaa',
    'evidence', jsonb_build_object('taskId', v_task, 'kind', 'verification',
      'producer', 'ci', 'revisionSet', jsonb_build_array(
        jsonb_build_object('projectKey', 'prj_handoff', 'commit', repeat('a', 40))),
      'payload', jsonb_build_object('summary', 'Pass')));
  perform public.apply_team_append_operation(
    'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa', 'aaaaaaaa-2222-4222-8222-aaaaaaaaaaaa',
    'aaaaaaaa-3333-4333-8333-aaaaaaaaaaaa', 'aaaaaaaa-9999-4999-8999-aaaaaaaaaaaa',
    'receipt', jsonb_build_object('taskId', v_task, 'result', 'passed',
      'summary', 'Replay passed', 'revisionSet', jsonb_build_array(
        jsonb_build_object('projectKey', 'prj_handoff', 'commit', repeat('a', 40)))));
  v_context := public.resolve_team_task_context('aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa', v_task, 10);
  if v_context #>> '{task,ownerId}' <> '99999999-9999-4999-8999-999999999999'
    or jsonb_array_length(v_context -> 'decisions') <> 1
    or jsonb_array_length(v_context -> 'unresolvedDependencies') <> 1
    or v_context #>> '{evidence,0,freshness}' <> 'current'
    or v_context #>> '{receipts,0,freshness}' <> 'current' then
    raise exception 'Resolved handoff context is incomplete'; end if;
  if jsonb_array_length(public.search_team_decisions(
      'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa', 'canonical', 10)) <> 1 then
    raise exception 'Decision search missed accepted decision'; end if;
  begin
    perform public.apply_team_task_context_operation(
      'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa', 'aaaaaaaa-2222-4222-8222-aaaaaaaaaaaa',
      'aaaaaaaa-3333-4333-8333-aaaaaaaaaaaa', 'bbbbbbbb-1111-4111-8111-bbbbbbbbbbbb',
      v_task, 1, null, '[]'::jsonb, '[]'::jsonb, '{}'::jsonb);
    raise exception 'Stale context version was accepted';
  exception when sqlstate '40001' then null; end;
end $$;

select set_config('request.jwt.claim.sub', '99999999-9999-4999-8999-999999999999', true);
do $$
declare v_task uuid; v_page jsonb;
begin
  select id into v_task from public.team_tasks where external_id = 'task_handoff';
  if public.resolve_team_task_context('aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa', v_task, 10)
    #>> '{task,title}' <> 'Trace checkout' then
    raise exception 'Teammate could not resume task'; end if;
  perform public.apply_team_append_operation(
    'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa', 'aaaaaaaa-2222-4222-8222-aaaaaaaaaaaa',
    'aaaaaaaa-4444-4444-8444-aaaaaaaaaaaa', 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb',
    'comment', jsonb_build_object('taskId', v_task, 'body', 'I can take this next'));
  v_page := public.get_team_change_page('aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa', 0, 100);
  if v_page ->> 'expired' <> 'false' or jsonb_array_length(v_page -> 'events') <> 8 then
    raise exception 'Change feed omitted a handoff record'; end if;
end $$;

reset role;
update public.team_devices set revoked_at = now() where id = 'aaaaaaaa-4444-4444-8444-aaaaaaaaaaaa';
set local role authenticated;
do $$ begin
  begin
    perform public.apply_team_append_operation(
      'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa', 'aaaaaaaa-2222-4222-8222-aaaaaaaaaaaa',
      'aaaaaaaa-4444-4444-8444-aaaaaaaaaaaa', 'bbbbbbbb-3333-4333-8333-bbbbbbbbbbbb',
      'comment', '{"body":"Denied"}'::jsonb);
    raise exception 'Revoked device appended a comment';
  exception when insufficient_privilege then null; end;
end $$;
reset role;
update public.team_change_events set created_at = now() - interval '31 days'
  where organization_id = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
set local role authenticated;
select set_config('request.jwt.claim.sub', '88888888-8888-4888-8888-888888888888', true);
do $$
declare v_task uuid; v_pruned record; v_replay record; v_append record; v_floor bigint;
begin
  select id into v_task from public.team_tasks where external_id = 'task_handoff';
  select * into v_pruned from public.prune_team_change_events(
    'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa', now(), 100);
  if v_pruned.deleted_count <> 8 or v_pruned.floor_sequence < 8 then
    raise exception 'Retention did not retire the contiguous event prefix'; end if;
  if public.get_team_change_page('aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa', 0, 100)
    ->> 'expired' <> 'true' then raise exception 'Expired cursor not detected'; end if;
  select * into v_replay from public.apply_team_task_operation(
    'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa', 'aaaaaaaa-2222-4222-8222-aaaaaaaaaaaa',
    'aaaaaaaa-3333-4333-8333-aaaaaaaaaaaa', 'aaaaaaaa-5555-4555-8555-aaaaaaaaaaaa',
    'task_handoff', 'Trace checkout', 'Follow the route', 'open',
    '[{"projectKey":"prj_handoff","commit":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}]'::jsonb, 0);
  select * into v_append from public.apply_team_append_operation(
    'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa', 'aaaaaaaa-2222-4222-8222-aaaaaaaaaaaa',
    'aaaaaaaa-3333-4333-8333-aaaaaaaaaaaa', 'aaaaaaaa-7777-4777-8777-aaaaaaaaaaaa',
    'decision', jsonb_build_object('taskId', v_task, 'body', 'Use the canonical checkout route',
      'sourceRefs', jsonb_build_array('src/checkout.ts:12')));
  if not v_replay.was_duplicate or not v_append.was_duplicate or
    (select count(*) from public.team_tasks where id = v_task) <> 1 then
    raise exception 'Acknowledgment was lost after event retention'; end if;
  v_floor := (public.get_team_snapshot('aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa') ->> 'cursor')::bigint;
  if v_floor < v_pruned.floor_sequence then raise exception 'Snapshot cursor fell behind floor'; end if;
end $$;
rollback;
