-- Exercise the domain restore order inside a transaction. No rows persist.
begin;
insert into auth.users (id) values ('44444444-4444-4444-8444-444444444444');
insert into public.organizations (id, owner_id, name) values
  ('cccccccc-cccc-4ccc-8ccc-cccccccccccc', '44444444-4444-4444-8444-444444444444', 'Restore test');
insert into public.team_workspaces (id, organization_id, name, created_by) values
  ('cccccccc-1111-4111-8111-cccccccccccc', 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', 'Restore workspace', '44444444-4444-4444-8444-444444444444');
insert into public.team_tasks (id, workspace_id, external_id, title, created_by) values
  ('cccccccc-2222-4222-8222-cccccccccccc', 'cccccccc-1111-4111-8111-cccccccccccc', 'task_restore', 'Restore task', '44444444-4444-4444-8444-444444444444');
insert into public.team_decisions (id, workspace_id, task_id, body, created_by) values
  ('cccccccc-3333-4333-8333-cccccccccccc', 'cccccccc-1111-4111-8111-cccccccccccc', 'cccccccc-2222-4222-8222-cccccccccccc', 'Restore decision', '44444444-4444-4444-8444-444444444444');
insert into public.team_evidence (id, workspace_id, task_id, kind, producer, created_by) values
  ('cccccccc-4444-4444-8444-cccccccccccc', 'cccccccc-1111-4111-8111-cccccccccccc', 'cccccccc-2222-4222-8222-cccccccccccc', 'verification', 'restore-test', '44444444-4444-4444-8444-444444444444');

create temp table restore_tasks on commit drop as select * from public.team_tasks where id = 'cccccccc-2222-4222-8222-cccccccccccc';
create temp table restore_decisions on commit drop as select * from public.team_decisions where id = 'cccccccc-3333-4333-8333-cccccccccccc';
create temp table restore_evidence on commit drop as select * from public.team_evidence where id = 'cccccccc-4444-4444-8444-cccccccccccc';
delete from public.team_tasks where id = 'cccccccc-2222-4222-8222-cccccccccccc';
do $$ begin
  if exists (select 1 from public.team_decisions where id = 'cccccccc-3333-4333-8333-cccccccccccc') or
     exists (select 1 from public.team_evidence where id = 'cccccccc-4444-4444-8444-cccccccccccc') then
    raise exception 'Task cascade did not remove child records';
  end if;
end $$;
insert into public.team_tasks select * from restore_tasks;
insert into public.team_decisions select * from restore_decisions;
insert into public.team_evidence select * from restore_evidence;
do $$ begin
  if (select count(*) from public.team_tasks where id = 'cccccccc-2222-4222-8222-cccccccccccc') <> 1 or
     (select count(*) from public.team_decisions where id = 'cccccccc-3333-4333-8333-cccccccccccc') <> 1 or
     (select count(*) from public.team_evidence where id = 'cccccccc-4444-4444-8444-cccccccccccc') <> 1 then
    raise exception 'Team record restore failed';
  end if;
end $$;
rollback;
