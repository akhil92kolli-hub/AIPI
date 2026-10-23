-- Organization-isolated, revision-pinned cross-repository evidence graph.
begin;

create table public.team_graph_nodes (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.team_workspaces(id) on delete cascade,
  project_key text not null,
  node_key text not null check (char_length(node_key) between 1 and 500),
  kind text not null check (kind in ('contract','route','caller','test','task','schema')),
  label text not null check (char_length(label) between 1 and 500),
  source_ref text check (source_ref is null or char_length(source_ref) <= 1000),
  revision_commit text not null check (revision_commit ~ '^[0-9a-f]{40}$'),
  owner_id uuid references auth.users(id) on delete set null,
  updated_by uuid not null references auth.users(id) on delete restrict,
  updated_at timestamptz not null default now(),
  unique (workspace_id, project_key, node_key),
  foreign key (workspace_id, project_key)
    references public.team_workspace_projects(workspace_id, project_key) on delete cascade
);
create index team_graph_nodes_workspace_kind_idx on public.team_graph_nodes (workspace_id, kind);

create table public.team_graph_edges (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.team_workspaces(id) on delete cascade,
  from_node_id uuid not null references public.team_graph_nodes(id) on delete cascade,
  to_node_id uuid not null references public.team_graph_nodes(id) on delete cascade,
  relation text not null check (relation in ('consumed_by','tested_by','depends_on')),
  evidence_kind text not null check (evidence_kind in ('declared','static','runtime','ai_suggestion')),
  evidence_key text not null check (char_length(evidence_key) between 1 and 500),
  confirmation_state text not null default 'inferred'
    check (confirmation_state in ('inferred','suggested','confirmed','rejected')),
  revision_set jsonb not null check (jsonb_typeof(revision_set) = 'array'
    and jsonb_array_length(revision_set) between 1 and 32),
  source_refs jsonb not null default '[]'::jsonb check (jsonb_typeof(source_refs) = 'array'),
  required_checks jsonb not null default '[]'::jsonb check (jsonb_typeof(required_checks) = 'array'),
  reviewed_by uuid references auth.users(id) on delete set null,
  reviewed_at timestamptz,
  created_by uuid not null references auth.users(id) on delete restrict,
  created_at timestamptz not null default now(),
  unique (workspace_id, from_node_id, to_node_id, relation, evidence_kind, evidence_key),
  check (from_node_id <> to_node_id)
);
create index team_graph_edges_workspace_from_idx on public.team_graph_edges (workspace_id, from_node_id);
create index team_graph_edges_workspace_to_idx on public.team_graph_edges (workspace_id, to_node_id);

alter table public.team_graph_nodes enable row level security;
alter table public.team_graph_edges enable row level security;
create policy "members read graph nodes" on public.team_graph_nodes for select to authenticated
  using (private.can_access_team_workspace(workspace_id));
create policy "members read graph edges" on public.team_graph_edges for select to authenticated
  using (private.can_access_team_workspace(workspace_id));
grant select on public.team_graph_nodes, public.team_graph_edges to authenticated;

create function public.publish_team_graph(
  p_workspace_id uuid, p_nodes jsonb, p_edges jsonb
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_actor uuid := auth.uid();
  v_organization_id uuid;
  v_node jsonb;
  v_edge jsonb;
  v_from uuid;
  v_to uuid;
  v_nodes integer := 0;
  v_edges integer := 0;
begin
  select w.organization_id into v_organization_id from public.team_workspaces w
    where w.id = p_workspace_id;
  if v_actor is null or v_organization_id is null or
    private.organization_role_for(v_organization_id) not in ('owner','admin','developer') then
    raise exception 'GRAPH_WRITE_DENIED' using errcode = '42501'; end if;
  if jsonb_typeof(p_nodes) <> 'array' or jsonb_typeof(p_edges) <> 'array'
    or jsonb_array_length(p_nodes) > 200 or jsonb_array_length(p_edges) > 500
    or octet_length(p_nodes::text) + octet_length(p_edges::text) > 1048576 then
    raise exception 'INVALID_GRAPH_BATCH' using errcode = '22023'; end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(v_organization_id::text, 0));
  for v_node in select value from jsonb_array_elements(p_nodes) loop
    if coalesce(v_node ->> 'projectKey','') !~ '^prj_[A-Za-z0-9_-]{4,100}$'
      or coalesce(v_node ->> 'revisionCommit','') !~ '^[0-9a-f]{40}$'
      or coalesce(v_node ->> 'kind','') not in ('contract','route','caller','test','task','schema')
      or char_length(coalesce(v_node ->> 'nodeKey','')) not between 1 and 500
      or char_length(coalesce(v_node ->> 'label','')) not between 1 and 500
      or not exists (select 1 from public.team_workspace_projects p
        where p.workspace_id = p_workspace_id and p.project_key = v_node ->> 'projectKey') then
      raise exception 'INVALID_GRAPH_NODE' using errcode = '22023'; end if;
    if nullif(v_node ->> 'ownerId','') is not null and not exists (
      select 1 from public.organization_memberships m where m.organization_id = v_organization_id
        and m.user_id = (v_node ->> 'ownerId')::uuid) then
      raise exception 'GRAPH_OWNER_OUTSIDE_ORGANIZATION' using errcode = '42501'; end if;
    insert into public.team_graph_nodes
      (workspace_id, project_key, node_key, kind, label, source_ref,
       revision_commit, owner_id, updated_by)
    values (p_workspace_id, v_node ->> 'projectKey', v_node ->> 'nodeKey',
      v_node ->> 'kind', v_node ->> 'label', nullif(v_node ->> 'sourceRef',''),
      v_node ->> 'revisionCommit', nullif(v_node ->> 'ownerId','')::uuid, v_actor)
    on conflict (workspace_id, project_key, node_key) do update
      set kind = excluded.kind, label = excluded.label, source_ref = excluded.source_ref,
        revision_commit = excluded.revision_commit, owner_id = excluded.owner_id,
        updated_by = v_actor, updated_at = now();
    v_nodes := v_nodes + 1;
  end loop;
  for v_edge in select value from jsonb_array_elements(p_edges) loop
    if coalesce(v_edge ->> 'relation','') not in ('consumed_by','tested_by','depends_on')
      or coalesce(v_edge ->> 'evidenceKind','') not in ('declared','static','runtime','ai_suggestion')
      or char_length(coalesce(v_edge ->> 'evidenceKey','')) not between 1 and 500
      or jsonb_typeof(v_edge -> 'revisionSet') <> 'array'
      or jsonb_array_length(v_edge -> 'revisionSet') not between 1 and 32
      or jsonb_typeof(coalesce(v_edge -> 'sourceRefs','[]'::jsonb)) <> 'array'
      or jsonb_typeof(coalesce(v_edge -> 'requiredChecks','[]'::jsonb)) <> 'array'
      or jsonb_array_length(coalesce(v_edge -> 'sourceRefs','[]'::jsonb)) > 100
      or jsonb_array_length(coalesce(v_edge -> 'requiredChecks','[]'::jsonb)) > 50 then
      raise exception 'INVALID_GRAPH_EDGE' using errcode = '22023'; end if;
    select id into v_from from public.team_graph_nodes n where n.workspace_id = p_workspace_id
      and n.project_key = v_edge ->> 'fromProjectKey' and n.node_key = v_edge ->> 'fromNodeKey';
    select id into v_to from public.team_graph_nodes n where n.workspace_id = p_workspace_id
      and n.project_key = v_edge ->> 'toProjectKey' and n.node_key = v_edge ->> 'toNodeKey';
    if v_from is null or v_to is null or v_from = v_to then
      raise exception 'GRAPH_ENDPOINT_OUTSIDE_WORKSPACE' using errcode = '22023'; end if;
    insert into public.team_graph_edges
      (workspace_id, from_node_id, to_node_id, relation, evidence_kind,
       evidence_key, confirmation_state, revision_set, source_refs, required_checks, created_by)
    values (p_workspace_id, v_from, v_to, v_edge ->> 'relation',
      v_edge ->> 'evidenceKind', v_edge ->> 'evidenceKey',
      case when v_edge ->> 'evidenceKind' = 'ai_suggestion' then 'suggested' else 'inferred' end,
      v_edge -> 'revisionSet', coalesce(v_edge -> 'sourceRefs','[]'::jsonb),
      coalesce(v_edge -> 'requiredChecks','[]'::jsonb), v_actor)
    on conflict (workspace_id, from_node_id, to_node_id, relation, evidence_kind, evidence_key)
      do nothing;
    v_edges := v_edges + 1;
  end loop;
  return jsonb_build_object('nodesProcessed',v_nodes,'edgesProcessed',v_edges);
end;
$$;
revoke all on function public.publish_team_graph(uuid,jsonb,jsonb) from public, anon;
grant execute on function public.publish_team_graph(uuid,jsonb,jsonb) to authenticated;

create function public.review_team_graph_edge(p_edge_id uuid, p_confirm boolean)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_actor uuid := auth.uid(); v_workspace uuid; v_org uuid; v_edge public.team_graph_edges%rowtype;
begin
  select e.workspace_id, w.organization_id into v_workspace, v_org
    from public.team_graph_edges e join public.team_workspaces w on w.id = e.workspace_id
    where e.id = p_edge_id;
  if v_actor is null or v_org is null or
    private.organization_role_for(v_org) not in ('owner','admin','developer') then
    raise exception 'GRAPH_REVIEW_DENIED' using errcode = '42501'; end if;
  update public.team_graph_edges set confirmation_state = case when p_confirm then 'confirmed' else 'rejected' end,
    reviewed_by = v_actor, reviewed_at = now()
    where id = p_edge_id returning * into v_edge;
  return jsonb_build_object('id',v_edge.id,'confirmationState',v_edge.confirmation_state,
    'reviewedBy',v_edge.reviewed_by,'reviewedAt',v_edge.reviewed_at);
end;
$$;
revoke all on function public.review_team_graph_edge(uuid,boolean) from public, anon;
grant execute on function public.review_team_graph_edge(uuid,boolean) to authenticated;
commit;
