-- Trial expiry also gates graph mutation, which does not emit sync change events.
begin;
create function private.assert_team_plan_active(p_organization_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare v_expiry timestamptz;
begin
  select expires_at into v_expiry from public.team_entitlements
    where organization_id = p_organization_id;
  if not found or (v_expiry is not null and v_expiry <= now()) then
    raise exception 'TEAM_PLAN_EXPIRED' using errcode = '42501'; end if;
end;
$$;
revoke all on function private.assert_team_plan_active(uuid) from public, anon, authenticated;
create function private.enforce_team_graph_plan()
returns trigger language plpgsql security definer set search_path = '' as $$
declare v_organization_id uuid;
begin
  select organization_id into v_organization_id from public.team_workspaces
    where id = new.workspace_id;
  perform private.assert_team_plan_active(v_organization_id);
  return new;
end;
$$;
revoke all on function private.enforce_team_graph_plan() from public, anon, authenticated;
create trigger enforce_team_graph_node_plan before insert or update on public.team_graph_nodes
  for each row execute function private.enforce_team_graph_plan();
create trigger enforce_team_graph_edge_plan before insert or update on public.team_graph_edges
  for each row execute function private.enforce_team_graph_plan();
commit;
