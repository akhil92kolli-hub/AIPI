-- Proves task writes require the RPC and snapshots honor organization access.
-- This entire verification transaction is rolled back.
begin;
insert into auth.users (id) values
  ('66666666-6666-4666-8666-666666666666'),
  ('77777777-7777-4777-8777-777777777777');
insert into public.organizations (id, owner_id, name) values
  ('eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', '66666666-6666-4666-8666-666666666666', 'Snapshot test');
insert into public.team_workspaces (id, organization_id, name, created_by) values
  ('eeeeeeee-1111-4111-8111-eeeeeeeeeeee', 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
   'Snapshot workspace', '66666666-6666-4666-8666-666666666666');
insert into public.team_devices (id, organization_id, user_id, label) values
  ('eeeeeeee-2222-4222-8222-eeeeeeeeeeee', 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
   '66666666-6666-4666-8666-666666666666', 'Snapshot device');
insert into public.team_sync_floors (organization_id, floor_sequence) values
  ('eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', 100000000);

set local role authenticated;
select set_config('request.jwt.claim.sub', '66666666-6666-4666-8666-666666666666', true);
do $$
declare v_snapshot jsonb;
begin
  begin
    insert into public.team_tasks (workspace_id, external_id, title, created_by) values
      ('eeeeeeee-1111-4111-8111-eeeeeeeeeeee', 'task_direct', 'Bypass',
       '66666666-6666-4666-8666-666666666666');
    raise exception 'Direct task insert was accepted';
  exception when insufficient_privilege then null;
  end;

  perform public.apply_team_task_operation(
    'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', 'eeeeeeee-1111-4111-8111-eeeeeeeeeeee',
    'eeeeeeee-2222-4222-8222-eeeeeeeeeeee', 'eeeeeeee-3333-4333-8333-eeeeeeeeeeee',
    'task_snap', 'Snapshot task', '', 'open', '[]'::jsonb, 0);
  v_snapshot := public.get_team_snapshot('eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee');
  if (v_snapshot ->> 'cursor')::bigint < 100000000 or
     jsonb_array_length(v_snapshot -> 'entities') <> 2 or
     not exists (select 1 from jsonb_array_elements(v_snapshot -> 'entities') item
       where item ->> 'entityType' = 'task' and item #>> '{payload,title}' = 'Snapshot task') then
    raise exception 'Snapshot does not include the accepted task and workspace';
  end if;
end $$;

select set_config('request.jwt.claim.sub', '77777777-7777-4777-8777-777777777777', true);
do $$ begin
  begin
    perform public.get_team_snapshot('eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee');
    raise exception 'Outsider could read the snapshot';
  exception when insufficient_privilege then null;
  end;
end $$;
rollback;
