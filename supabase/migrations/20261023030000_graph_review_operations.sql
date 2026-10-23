-- Review retries must not overwrite a later review. The Worker brokers current
-- source grants; this RPC serializes the graph write and its durable receipt.
begin;

alter table public.team_graph_edges add column version bigint not null default 1
  check (version > 0);

create function public.broker_review_team_graph_edge_operation(
  p_actor_id uuid, p_workspace_id uuid, p_device_id uuid,
  p_operation_id uuid, p_edge_id uuid, p_confirm boolean, p_base_version bigint
) returns jsonb language plpgsql set search_path = '' as $$
declare
  v_organization_id uuid;
  v_fingerprint text;
  v_existing public.team_accepted_operations%rowtype;
  v_edge public.team_graph_edges%rowtype;
begin
  perform private.assert_team_graph_editor(p_actor_id, p_workspace_id);
  select organization_id into v_organization_id from public.team_workspaces
    where id = p_workspace_id;
  if p_operation_id is null or p_device_id is null or p_edge_id is null or
     p_confirm is null or p_base_version is null or p_base_version < 1 then
    raise exception 'INVALID_GRAPH_REVIEW_OPERATION' using errcode = '22023';
  end if;
  if not exists (select 1 from public.team_devices d where d.id = p_device_id
    and d.organization_id = v_organization_id and d.user_id = p_actor_id
    and d.revoked_at is null) then
    raise exception 'DEVICE_REVOKED_OR_UNKNOWN' using errcode = '42501';
  end if;
  v_fingerprint := pg_catalog.md5(p_workspace_id::text || ':' ||
    p_edge_id::text || ':' || p_confirm::text || ':' || p_base_version::text);
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(v_organization_id::text, 0));
  select * into v_existing from public.team_accepted_operations a
    where a.organization_id = v_organization_id
      and a.operation_id = p_operation_id for update;
  if found then
    if v_existing.actor_id <> p_actor_id or v_existing.device_id <> p_device_id or
       v_existing.request_fingerprint is distinct from v_fingerprint or
       v_existing.ack_entity_type <> 'graph_edge' or
       v_existing.ack_entity_id <> p_edge_id then
      raise exception 'OPERATION_ID_REUSED' using errcode = '40001';
    end if;
    return pg_catalog.jsonb_build_object('id', p_edge_id,
      'confirmationState', case when p_confirm then 'confirmed' else 'rejected' end,
      'version', v_existing.ack_version, 'operationId', p_operation_id,
      'wasDuplicate', true);
  end if;

  select * into v_edge from public.team_graph_edges e
    where e.id = p_edge_id and e.workspace_id = p_workspace_id for update;
  if not found then raise exception 'GRAPH_EDGE_UNAVAILABLE' using errcode = '42501'; end if;
  if v_edge.version <> p_base_version then
    raise exception 'GRAPH_REVIEW_VERSION_CONFLICT' using errcode = '40001';
  end if;
  if exists (select 1 from public.team_graph_nodes n
    where n.id in (v_edge.from_node_id, v_edge.to_node_id)
      and not exists (select 1 from pg_catalog.jsonb_array_elements(v_edge.revision_set) pin
        where pin ->> 'projectKey' = n.project_key and
          pin ->> 'commit' = n.revision_commit)) then
    raise exception 'GRAPH_REVIEW_STALE_REVISION' using errcode = '40001';
  end if;
  update public.team_graph_edges set
    confirmation_state = case when p_confirm then 'confirmed' else 'rejected' end,
    reviewed_by = p_actor_id, reviewed_at = now(), version = version + 1
    where id = p_edge_id returning * into v_edge;
  insert into public.team_accepted_operations
    (organization_id, device_id, operation_id, actor_id,
     request_fingerprint, ack_entity_type, ack_entity_id, ack_version)
    values (v_organization_id, p_device_id, p_operation_id, p_actor_id,
      v_fingerprint, 'graph_edge', p_edge_id, v_edge.version);
  return pg_catalog.jsonb_build_object('id', p_edge_id,
    'confirmationState', v_edge.confirmation_state, 'version', v_edge.version,
    'operationId', p_operation_id, 'wasDuplicate', false);
end;
$$;

revoke all on function public.broker_review_team_graph_edge(uuid,uuid,uuid,boolean)
  from public, anon, authenticated, service_role;
revoke all on function public.review_team_graph_edge(uuid,boolean)
  from public, anon, authenticated, service_role;
revoke all on function public.broker_review_team_graph_edge_operation(uuid,uuid,uuid,uuid,uuid,boolean,bigint)
  from public, anon, authenticated;
grant execute on function public.broker_review_team_graph_edge_operation(uuid,uuid,uuid,uuid,uuid,boolean,bigint)
  to service_role;

commit;
