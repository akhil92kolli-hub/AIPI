-- A workspace editor may publish/review a GitHub-bound graph only through the
-- Worker after a current user + App repository check. Recheck AIPI roles under
-- row locks in the service transaction so removal wins over queued work.
begin;
grant usage on schema private to service_role;

revoke execute on function public.publish_team_graph(uuid,jsonb,jsonb) from authenticated;
revoke execute on function public.review_team_graph_edge(uuid,boolean) from authenticated;
grant execute on function public.publish_team_graph(uuid,jsonb,jsonb) to service_role;
grant execute on function public.review_team_graph_edge(uuid,boolean) to service_role;

create function private.assert_team_graph_editor(p_actor_id uuid,p_workspace_id uuid)
returns void language plpgsql set search_path = '' as $$
declare v_organization_id uuid; v_workspace_role text; v_organization_role text;
begin
  if current_user <> 'service_role' then
    raise exception 'GRAPH_BROKER_REQUIRED' using errcode='42501';
  end if;
  select organization_id into v_organization_id from public.team_workspaces
    where id=p_workspace_id for update;
  if v_organization_id is null then raise exception 'WORKSPACE_UNAVAILABLE' using errcode='42501'; end if;
  select role into v_workspace_role from public.team_workspace_memberships
    where workspace_id=p_workspace_id and user_id=p_actor_id for share;
  select role into v_organization_role from public.organization_memberships
    where organization_id=v_organization_id and user_id=p_actor_id for share;
  if v_workspace_role not in ('owner','admin','developer') or
     v_organization_role not in ('owner','admin','developer') or
     v_workspace_role is null or v_organization_role is null then
    raise exception 'WORKSPACE_WRITE_DENIED' using errcode='42501';
  end if;
end;
$$;
revoke all on function private.assert_team_graph_editor(uuid,uuid) from public,anon,authenticated;
grant execute on function private.assert_team_graph_editor(uuid,uuid) to service_role;

create function public.broker_publish_team_graph(
  p_actor_id uuid,p_workspace_id uuid,p_nodes jsonb,p_edges jsonb
) returns jsonb language plpgsql set search_path = '' as $$
declare v_previous_sub text; v_result jsonb;
begin
  perform private.assert_team_graph_editor(p_actor_id,p_workspace_id);
  v_previous_sub := current_setting('request.jwt.claim.sub',true);
  perform set_config('request.jwt.claim.sub',p_actor_id::text,true);
  v_result := public.publish_team_graph(p_workspace_id,p_nodes,p_edges);
  perform set_config('request.jwt.claim.sub',coalesce(v_previous_sub,''),true);
  return v_result;
end;
$$;
revoke all on function public.broker_publish_team_graph(uuid,uuid,jsonb,jsonb)
  from public,anon,authenticated;
grant execute on function public.broker_publish_team_graph(uuid,uuid,jsonb,jsonb) to service_role;

create function public.broker_review_team_graph_edge(
  p_actor_id uuid,p_workspace_id uuid,p_edge_id uuid,p_confirm boolean
) returns jsonb language plpgsql set search_path = '' as $$
declare v_previous_sub text; v_result jsonb;
begin
  perform private.assert_team_graph_editor(p_actor_id,p_workspace_id);
  if not exists(select 1 from public.team_graph_edges
    where id=p_edge_id and workspace_id=p_workspace_id) then
    raise exception 'GRAPH_EDGE_UNAVAILABLE' using errcode='42501';
  end if;
  v_previous_sub := current_setting('request.jwt.claim.sub',true);
  perform set_config('request.jwt.claim.sub',p_actor_id::text,true);
  v_result := public.review_team_graph_edge(p_edge_id,p_confirm);
  perform set_config('request.jwt.claim.sub',coalesce(v_previous_sub,''),true);
  return v_result;
end;
$$;
revoke all on function public.broker_review_team_graph_edge(uuid,uuid,uuid,boolean)
  from public,anon,authenticated;
grant execute on function public.broker_review_team_graph_edge(uuid,uuid,uuid,boolean) to service_role;

commit;
