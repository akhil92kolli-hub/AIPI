-- Binding updates are visible through snapshots and the ordered change feed.
begin;
insert into auth.users (id) values ('55555555-5555-4555-8555-555555555555');
insert into public.organizations (id, owner_id, name) values
  ('55555555-1111-4111-8111-555555555555', '55555555-5555-4555-8555-555555555555', 'Binding feed test');
insert into public.team_workspaces (id, organization_id, name, created_by) values
  ('55555555-2222-4222-8222-555555555555', '55555555-1111-4111-8111-555555555555',
   'Binding workspace', '55555555-5555-4555-8555-555555555555');
insert into public.team_workspace_projects
  (workspace_id, project_key, provider_repository_id, repository, remote_url) values
  ('55555555-2222-4222-8222-555555555555', 'prj_binding', '123456789',
   'acme/binding', 'https://github.com/acme/binding');
set local role authenticated;
select set_config('request.jwt.claim.sub', '55555555-5555-4555-8555-555555555555', true);
do $$
declare v_snapshot jsonb; v_page jsonb;
begin
  v_snapshot := public.get_team_snapshot('55555555-1111-4111-8111-555555555555');
  if jsonb_array_length(v_snapshot -> 'entities') <> 1
    or v_snapshot #>> '{entities,0,payload,projects,0,projectKey}' <> 'prj_binding' then
    raise exception 'Snapshot omitted repository binding'; end if;
  v_page := public.get_team_change_page('55555555-1111-4111-8111-555555555555', 0, 100);
  if jsonb_array_length(v_page -> 'events') <> 2
    or v_page #>> '{events,1,payload,projects,0,projectKey}' <> 'prj_binding' then
    raise exception 'Workspace binding change was not emitted'; end if;
  delete from public.team_workspace_projects where workspace_id = '55555555-2222-4222-8222-555555555555'
    and project_key = 'prj_binding';
  v_page := public.get_team_change_page('55555555-1111-4111-8111-555555555555', 0, 100);
  if jsonb_array_length(v_page -> 'events') <> 3
    or jsonb_array_length(v_page #> '{events,2,payload,projects}') <> 0 then
    raise exception 'Binding removal was not emitted'; end if;
end $$;
reset role;
update public.team_change_events set created_at = now() - interval '31 days'
  where organization_id = '55555555-1111-4111-8111-555555555555';
do $$ begin
  if private.prune_team_change_events_daily() < 3 or
    (select floor_sequence from public.team_sync_floors
      where organization_id = '55555555-1111-4111-8111-555555555555') < 3 then
    raise exception 'Scheduled retention did not preserve the cursor floor'; end if;
end $$;
rollback;
