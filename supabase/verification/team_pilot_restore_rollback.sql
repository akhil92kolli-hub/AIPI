-- Synthetic delete and ordered logical restore of M5-M7 records.
begin;
insert into auth.users(id) values ('55555555-1111-4111-8111-555555555551');
insert into public.organizations(id,owner_id,name) values
  ('55555555-2222-4222-8222-555555555551','55555555-1111-4111-8111-555555555551','Restore pilot');
insert into public.team_workspaces(id,organization_id,name,created_by) values
  ('55555555-3333-4333-8333-555555555551','55555555-2222-4222-8222-555555555551',
   'Restore workspace','55555555-1111-4111-8111-555555555551');
insert into public.team_workspace_projects
  (workspace_id,project_key,provider_repository_id,repository,remote_url) values
  ('55555555-3333-4333-8333-555555555551','prj_restore','88001','acme/restore','https://github.com/acme/restore');
insert into public.team_graph_nodes
  (id,workspace_id,project_key,node_key,kind,label,revision_commit,updated_by) values
  ('55555555-4444-4444-8444-555555555551','55555555-3333-4333-8333-555555555551',
   'prj_restore','GET /restore','contract','Restore',repeat('a',40),'55555555-1111-4111-8111-555555555551'),
  ('55555555-4444-4444-8444-555555555552','55555555-3333-4333-8333-555555555551',
   'prj_restore','src/client.ts:1','caller','Client',repeat('a',40),'55555555-1111-4111-8111-555555555551');
insert into public.team_graph_edges
  (workspace_id,from_node_id,to_node_id,relation,evidence_kind,evidence_key,revision_set,created_by) values
  ('55555555-3333-4333-8333-555555555551','55555555-4444-4444-8444-555555555551',
   '55555555-4444-4444-8444-555555555552','consumed_by','static','restore',
   '[{"projectKey":"prj_restore","commit":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}]'::jsonb,
   '55555555-1111-4111-8111-555555555551');
insert into public.team_github_installations(installation_id,organization_id,account_login,connected_by) values
  (988001,'55555555-2222-4222-8222-555555555551','acme','55555555-1111-4111-8111-555555555551');
insert into public.team_ci_producers(organization_id,app_id,name,environment,configured_by) values
  ('55555555-2222-4222-8222-555555555551',777001,'CI','ci','55555555-1111-4111-8111-555555555551');
insert into public.team_pull_requests
  (organization_id,workspace_id,installation_id,provider_repository_id,repository,number,title,state,head_sha,base_sha) values
  ('55555555-2222-4222-8222-555555555551','55555555-3333-4333-8333-555555555551',
   988001,'88001','acme/restore',7,'Restore PR','open',repeat('a',40),repeat('b',40));
insert into public.team_ci_receipts
  (organization_id,provider_repository_id,check_run_id,producer_app_id,check_name,environment,head_sha,conclusion,source_url) values
  ('55555555-2222-4222-8222-555555555551','88001',677001,777001,'unit','ci',
   repeat('a',40),'success','https://github.com/acme/restore/actions/runs/1');
create temp table pilot_restore_copy on commit drop as
select (select row_to_json(o) from public.organizations o where id='55555555-2222-4222-8222-555555555551') as organization,
 (select row_to_json(w) from public.team_workspaces w where id='55555555-3333-4333-8333-555555555551') as workspace,
 (select row_to_json(p) from public.team_workspace_projects p where project_key='prj_restore') as project,
 (select jsonb_agg(to_jsonb(n)) from public.team_graph_nodes n where workspace_id='55555555-3333-4333-8333-555555555551') as nodes,
 (select jsonb_agg(to_jsonb(e)) from public.team_graph_edges e where workspace_id='55555555-3333-4333-8333-555555555551') as edges,
 (select row_to_json(i) from public.team_github_installations i where installation_id=988001) as installation,
 (select row_to_json(c) from public.team_ci_producers c where app_id=777001) as producer,
 (select row_to_json(p) from public.team_pull_requests p where number=7) as pr,
 (select row_to_json(r) from public.team_ci_receipts r where check_run_id=677001) as receipt;
set local role authenticated;
select set_config('request.jwt.claim.sub','55555555-1111-4111-8111-555555555551',true);
delete from public.organizations where id='55555555-2222-4222-8222-555555555551';
reset role;
do $$ begin
 if exists (select 1 from public.team_graph_nodes where workspace_id='55555555-3333-4333-8333-555555555551')
   or exists (select 1 from public.team_pull_requests where provider_repository_id='88001')
   then raise exception 'Organization delete left team records'; end if;
end $$;
-- Restore parent, workspace and project before dependent graph and PR records.
insert into public.organizations select (json_populate_record(null::public.organizations,organization)).* from pilot_restore_copy;
insert into public.team_workspaces select (json_populate_record(null::public.team_workspaces,workspace)).* from pilot_restore_copy;
insert into public.team_workspace_projects select (json_populate_record(null::public.team_workspace_projects,project)).* from pilot_restore_copy;
insert into public.team_graph_nodes select (jsonb_populate_record(null::public.team_graph_nodes,value)).*
  from pilot_restore_copy, jsonb_array_elements(nodes) value;
insert into public.team_graph_edges select (jsonb_populate_record(null::public.team_graph_edges,value)).*
  from pilot_restore_copy, jsonb_array_elements(edges) value;
insert into public.team_github_installations select (json_populate_record(null::public.team_github_installations,installation)).* from pilot_restore_copy;
insert into public.team_ci_producers select (json_populate_record(null::public.team_ci_producers,producer)).* from pilot_restore_copy;
insert into public.team_pull_requests select (json_populate_record(null::public.team_pull_requests,pr)).* from pilot_restore_copy;
insert into public.team_ci_receipts select (json_populate_record(null::public.team_ci_receipts,receipt)).* from pilot_restore_copy;
do $$ begin
 if (select count(*) from public.team_graph_nodes where workspace_id='55555555-3333-4333-8333-555555555551') <> 2
   or (select count(*) from public.team_graph_edges where workspace_id='55555555-3333-4333-8333-555555555551') <> 1
   or (select count(*) from public.team_pull_requests where provider_repository_id='88001') <> 1
   or (select count(*) from public.team_ci_receipts where check_run_id=677001) <> 1
   then raise exception 'Logical restore did not reconstruct pilot records'; end if;
end $$;
rollback;
