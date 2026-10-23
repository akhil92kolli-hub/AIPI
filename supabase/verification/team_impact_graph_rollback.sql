-- Cloud graph respects project identity, review, and organization isolation.
begin;
insert into auth.users (id) values
 ('44444444-1111-4111-8111-444444444444'),
 ('44444444-2222-4222-8222-444444444444'),
 ('44444444-3333-4333-8333-444444444444');
insert into public.organizations (id, owner_id, name) values
 ('44444444-4444-4444-8444-444444444444', '44444444-1111-4111-8111-444444444444', 'Impact test');
insert into public.organization_memberships (organization_id, user_id, role) values
 ('44444444-4444-4444-8444-444444444444', '44444444-2222-4222-8222-444444444444', 'viewer');
insert into public.team_workspaces (id, organization_id, name, created_by) values
 ('44444444-5555-4555-8555-444444444444', '44444444-4444-4444-8444-444444444444',
  'Impact workspace', '44444444-1111-4111-8111-444444444444');
insert into public.team_workspace_projects
 (workspace_id, project_key, provider_repository_id, repository, remote_url) values
 ('44444444-5555-4555-8555-444444444444', 'prj_provider', '91001', 'acme/provider', 'https://github.com/acme/provider'),
 ('44444444-5555-4555-8555-444444444444', 'prj_consumer', '91002', 'acme/consumer', 'https://github.com/acme/consumer');
set local role authenticated;
select set_config('request.jwt.claim.sub', '44444444-1111-4111-8111-444444444444', true);
do $$ declare v_result jsonb; v_edge uuid;
begin
  v_result := public.publish_team_graph('44444444-5555-4555-8555-444444444444',
    '[{"projectKey":"prj_provider","nodeKey":"POST /checkout","kind":"contract","label":"POST /checkout","revisionCommit":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"},
      {"projectKey":"prj_consumer","nodeKey":"src/pay.ts:12","kind":"caller","label":"Pay caller","revisionCommit":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"}]'::jsonb,
    '[{"fromProjectKey":"prj_provider","fromNodeKey":"POST /checkout","toProjectKey":"prj_consumer","toNodeKey":"src/pay.ts:12","relation":"consumed_by","evidenceKind":"static","evidenceKey":"src/pay.ts:12@bbbb","revisionSet":[{"projectKey":"prj_provider","commit":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"},{"projectKey":"prj_consumer","commit":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"}],"sourceRefs":["src/pay.ts:12"],"requiredChecks":["consumer-unit"]}]'::jsonb);
  if v_result ->> 'edgesProcessed' <> '1' then raise exception 'Graph not published'; end if;
  select id into v_edge from public.team_graph_edges where workspace_id = '44444444-5555-4555-8555-444444444444';
  perform public.review_team_graph_edge(v_edge, false);
  perform public.publish_team_graph('44444444-5555-4555-8555-444444444444', '[]'::jsonb,
    '[{"fromProjectKey":"prj_provider","fromNodeKey":"POST /checkout","toProjectKey":"prj_consumer","toNodeKey":"src/pay.ts:12","relation":"consumed_by","evidenceKind":"static","evidenceKey":"src/pay.ts:12@bbbb","revisionSet":[{"projectKey":"prj_provider","commit":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}]}]'::jsonb);
  if (select confirmation_state from public.team_graph_edges where id = v_edge) <> 'rejected' then
    raise exception 'Automated republish overwrote human rejection'; end if;
end $$;
select set_config('request.jwt.claim.sub', '44444444-2222-4222-8222-444444444444', true);
do $$ begin
  if (select count(*) from public.team_graph_edges) <> 1 then raise exception 'Viewer cannot read graph'; end if;
  begin
    perform public.publish_team_graph('44444444-5555-4555-8555-444444444444', '[]'::jsonb, '[]'::jsonb);
    raise exception 'Viewer published graph';
  exception when insufficient_privilege then null; end;
end $$;
select set_config('request.jwt.claim.sub', '44444444-3333-4333-8333-444444444444', true);
do $$ begin
  if (select count(*) from public.team_graph_edges) <> 0 then raise exception 'Outsider read graph'; end if;
end $$;
rollback;
