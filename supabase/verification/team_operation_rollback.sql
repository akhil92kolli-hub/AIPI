-- Live atomicity, duplicate, conflict and revocation check. No rows persist.
begin;
insert into auth.users (id) values ('55555555-5555-4555-8555-555555555555');
insert into public.organizations (id, owner_id, name) values
  ('dddddddd-dddd-4ddd-8ddd-dddddddddddd', '55555555-5555-4555-8555-555555555555', 'Operation test');
insert into public.team_workspaces (id, organization_id, name, created_by) values
  ('dddddddd-1111-4111-8111-dddddddddddd', 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', 'Operation workspace', '55555555-5555-4555-8555-555555555555');
insert into public.team_devices (id, organization_id, user_id, label) values
  ('dddddddd-2222-4222-8222-dddddddddddd', 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', '55555555-5555-4555-8555-555555555555', 'Operation test device');

set local role authenticated;
select set_config('request.jwt.claim.sub', '55555555-5555-4555-8555-555555555555', true);
do $$
declare first_write record; duplicate_write record;
begin
  select * into first_write from public.apply_team_task_operation(
    'dddddddd-dddd-4ddd-8ddd-dddddddddddd', 'dddddddd-1111-4111-8111-dddddddddddd',
    'dddddddd-2222-4222-8222-dddddddddddd', 'dddddddd-3333-4333-8333-dddddddddddd',
    'task_atomic', 'Atomic task', '', 'open', '[]'::jsonb, 0);
  select * into duplicate_write from public.apply_team_task_operation(
    'dddddddd-dddd-4ddd-8ddd-dddddddddddd', 'dddddddd-1111-4111-8111-dddddddddddd',
    'dddddddd-2222-4222-8222-dddddddddddd', 'dddddddd-3333-4333-8333-dddddddddddd',
    'task_atomic', 'Atomic task', '', 'open', '[]'::jsonb, 0);
  if first_write.was_duplicate or not duplicate_write.was_duplicate or
     first_write.change_sequence <> duplicate_write.change_sequence or
     (select count(*) from public.team_tasks where external_id = 'task_atomic') <> 1 or
     (select count(*) from public.team_change_events where operation_id = 'dddddddd-3333-4333-8333-dddddddddddd') <> 1 then
    raise exception 'Atomic operation or deduplication failed';
  end if;
  begin
    perform public.apply_team_task_operation(
      'dddddddd-dddd-4ddd-8ddd-dddddddddddd', 'dddddddd-1111-4111-8111-dddddddddddd',
      'dddddddd-2222-4222-8222-dddddddddddd', 'dddddddd-4444-4444-8444-dddddddddddd',
      'task_atomic', 'Stale update', '', 'open', '[]'::jsonb, 0);
    raise exception 'Expected a version conflict';
  exception when sqlstate '40001' then null;
  end;
  if exists (select 1 from public.team_accepted_operations where operation_id = 'dddddddd-4444-4444-8444-dddddddddddd') then
    raise exception 'Conflict left an accepted operation';
  end if;
end $$;

reset role;
update public.team_devices set revoked_at = now() where id = 'dddddddd-2222-4222-8222-dddddddddddd';
set local role authenticated;
do $$ begin
  begin
    update public.team_devices set revoked_at = null where id = 'dddddddd-2222-4222-8222-dddddddddddd';
    raise exception 'Device unrevocation was accepted';
  exception when raise_exception then
    if sqlerrm <> 'Team device identity and revocation are immutable' then raise; end if;
  end;
  begin
    perform public.apply_team_task_operation(
      'dddddddd-dddd-4ddd-8ddd-dddddddddddd', 'dddddddd-1111-4111-8111-dddddddddddd',
      'dddddddd-2222-4222-8222-dddddddddddd', 'dddddddd-5555-4555-8555-dddddddddddd',
      'task_atomic', 'Denied update', '', 'open', '[]'::jsonb, 1);
    raise exception 'Revoked device was accepted';
  exception when sqlstate '42501' then null;
  end;
end $$;
rollback;
