-- Live acceptance check. Every synthetic row is rolled back at the end.
begin;

insert into auth.users (id) values
  ('11111111-1111-4111-8111-111111111111'),
  ('22222222-2222-4222-8222-222222222222'),
  ('33333333-3333-4333-8333-333333333333');
insert into public.organizations (id, owner_id, name) values
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '11111111-1111-4111-8111-111111111111', 'RLS test A'),
  ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', '22222222-2222-4222-8222-222222222222', 'RLS test B');
insert into public.organization_memberships (organization_id, user_id, role) values
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '33333333-3333-4333-8333-333333333333', 'viewer');
insert into public.team_workspaces (id, organization_id, name, created_by) values
  ('aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'A workspace', '11111111-1111-4111-8111-111111111111'),
  ('bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'B workspace', '22222222-2222-4222-8222-222222222222');
insert into public.team_tasks (id, workspace_id, external_id, title, created_by) values
  ('aaaaaaaa-3333-4333-8333-aaaaaaaaaaaa', 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa', 'task_rlsa', 'A task', '11111111-1111-4111-8111-111111111111'),
  ('bbbbbbbb-3333-4333-8333-bbbbbbbbbbbb', 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb', 'task_rlsb', 'B task', '22222222-2222-4222-8222-222222222222');
insert into public.team_decisions (workspace_id, task_id, body, created_by) values
  ('aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa', 'aaaaaaaa-3333-4333-8333-aaaaaaaaaaaa', 'A decision', '11111111-1111-4111-8111-111111111111'),
  ('bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb', 'bbbbbbbb-3333-4333-8333-bbbbbbbbbbbb', 'B decision', '22222222-2222-4222-8222-222222222222');
insert into public.team_evidence (workspace_id, task_id, kind, producer, created_by) values
  ('aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa', 'aaaaaaaa-3333-4333-8333-aaaaaaaaaaaa', 'verification', 'rls-test', '11111111-1111-4111-8111-111111111111'),
  ('bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb', 'bbbbbbbb-3333-4333-8333-bbbbbbbbbbbb', 'verification', 'rls-test', '22222222-2222-4222-8222-222222222222');

set local role authenticated;
select set_config('request.jwt.claim.sub', '11111111-1111-4111-8111-111111111111', true);
do $$ begin
  if (select count(*) from public.team_workspaces) <> 1 or
     (select count(*) from public.team_tasks) <> 1 or
     (select count(*) from public.team_decisions) <> 1 or
     (select count(*) from public.team_evidence) <> 1 then
    raise exception 'Owner can see an outside workspace or cannot see their own';
  end if;
  begin
    insert into public.team_decisions (workspace_id, body, created_by) values
      ('aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa', 'Forged author', '22222222-2222-4222-8222-222222222222');
    raise exception 'Forged decision author was accepted';
  exception when insufficient_privilege then null;
  end;
  begin
    update public.team_tasks set owner_id = '22222222-2222-4222-8222-222222222222'
    where id = 'aaaaaaaa-3333-4333-8333-aaaaaaaaaaaa';
    raise exception 'Outside organization task owner was accepted';
  exception when raise_exception then
    if sqlerrm <> 'Task owner must be a workspace organization member' then raise; end if;
  end;
end $$;

select set_config('request.jwt.claim.sub', '33333333-3333-4333-8333-333333333333', true);
do $$ begin
  if (select count(*) from public.team_workspaces) <> 1 or
     private.can_write_team_workspace('aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa') then
    raise exception 'Viewer access or write restriction failed';
  end if;
end $$;

select set_config('request.jwt.claim.sub', '22222222-2222-4222-8222-222222222222', true);
do $$ begin
  if (select count(*) from public.team_workspaces) <> 1 or
     (select count(*) from public.team_tasks where workspace_id = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa') <> 0 then
    raise exception 'Cross-organization isolation failed';
  end if;
end $$;

reset role;
delete from public.organization_memberships
where organization_id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
  and user_id = '33333333-3333-4333-8333-333333333333';
set local role authenticated;
select set_config('request.jwt.claim.sub', '33333333-3333-4333-8333-333333333333', true);
do $$ begin
  if (select count(*) from public.team_workspaces) <> 0 or
     (select count(*) from public.team_tasks) <> 0 then
    raise exception 'Revoked membership retained access';
  end if;
end $$;

rollback;
