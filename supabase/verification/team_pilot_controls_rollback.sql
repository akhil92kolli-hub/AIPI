-- Exercise the paid-pilot limits without retaining synthetic data.
begin;
insert into auth.users(id) values
 ('44444444-1111-4111-8111-444444444441'),
 ('44444444-1111-4111-8111-444444444442');
insert into public.organizations(id, owner_id, name) values
 ('44444444-2222-4222-8222-444444444441','44444444-1111-4111-8111-444444444441','Pilot control test');
insert into public.team_workspaces(id, organization_id, name, created_by) values
 ('44444444-3333-4333-8333-444444444441','44444444-2222-4222-8222-444444444441',
  'Pilot workspace','44444444-1111-4111-8111-444444444441');
insert into public.team_workspace_projects
 (workspace_id,project_key,provider_repository_id,repository,remote_url) values
 ('44444444-3333-4333-8333-444444444441','prj_pilot','88001','acme/pilot','https://github.com/acme/pilot');
update public.team_entitlements set seat_limit = 1
  where organization_id = '44444444-2222-4222-8222-444444444441';
set local role authenticated;
select set_config('request.jwt.claim.sub','44444444-1111-4111-8111-444444444441',true);
do $$ begin
  if (select seat_limit from public.team_entitlements where organization_id =
    '44444444-2222-4222-8222-444444444441') <> 1 then raise exception 'Entitlement missing'; end if;
end $$;
do $$ begin
  insert into public.organization_memberships(organization_id,user_id,role) values
    ('44444444-2222-4222-8222-444444444441','44444444-1111-4111-8111-444444444442','developer');
  raise exception 'Seat limit was bypassed';
exception when check_violation then
  if sqlerrm <> 'TEAM_SEAT_LIMIT' then raise; end if;
end $$;
reset role;
do $$ begin
  insert into public.team_evidence(workspace_id,kind,producer,payload,created_by) values
    ('44444444-3333-4333-8333-444444444441','static','test',
     '{"source":"private source text"}'::jsonb,'44444444-1111-4111-8111-444444444441');
  raise exception 'Source policy was bypassed';
exception when insufficient_privilege then
  if sqlerrm <> 'SOURCE_SHARING_POLICY_DENIED' then raise; end if;
end $$;
insert into public.team_evidence(workspace_id,kind,producer,payload,created_by) values
  ('44444444-3333-4333-8333-444444444441','static','test',
   '{"summary":"No source shared"}'::jsonb,'44444444-1111-4111-8111-444444444441');
set local role authenticated;
update public.team_source_policies set sharing_mode = 'snippets',
  updated_by = '44444444-1111-4111-8111-444444444441'
  where organization_id = '44444444-2222-4222-8222-444444444441';
reset role;
insert into public.team_evidence(workspace_id,kind,producer,payload,created_by) values
  ('44444444-3333-4333-8333-444444444441','static','test',
   '{"snippet":"public function"}'::jsonb,'44444444-1111-4111-8111-444444444441');
update public.team_entitlements set monthly_event_limit = 100,
  expires_at = now() - interval '1 second'
  where organization_id = '44444444-2222-4222-8222-444444444441';
do $$ begin
  insert into public.team_graph_nodes(workspace_id,project_key,node_key,kind,label,revision_commit,updated_by) values
    ('44444444-3333-4333-8333-444444444441','prj_pilot','GET /expired','contract','Expired',
     repeat('a',40),'44444444-1111-4111-8111-444444444441');
  raise exception 'Expired graph write was bypassed';
exception when insufficient_privilege then
  if sqlerrm <> 'TEAM_PLAN_EXPIRED' then raise; end if;
end $$;
do $$ begin
  insert into public.team_change_events(organization_id,workspace_id,entity_type,event_type) values
    ('44444444-2222-4222-8222-444444444441','44444444-3333-4333-8333-444444444441','task','created');
  raise exception 'Expired plan was bypassed';
exception when insufficient_privilege then
  if sqlerrm <> 'TEAM_PLAN_EXPIRED' then raise; end if;
end $$;
update public.team_entitlements set expires_at = now() + interval '1 day', monthly_event_limit = 100
  where organization_id = '44444444-2222-4222-8222-444444444441';
insert into public.team_usage_months(organization_id,month_start,accepted_events) values
  ('44444444-2222-4222-8222-444444444441',date_trunc('month',now() at time zone 'UTC')::date,100)
  on conflict (organization_id,month_start) do update set accepted_events=100;
do $$ begin
  insert into public.team_change_events(organization_id,workspace_id,entity_type,event_type) values
    ('44444444-2222-4222-8222-444444444441','44444444-3333-4333-8333-444444444441','task','created');
  raise exception 'Usage cap was bypassed';
exception when check_violation then
  if sqlerrm <> 'TEAM_USAGE_LIMIT' then raise; end if;
end $$;
rollback;
