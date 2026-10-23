-- Workspace membership is separate from account membership. Existing account
-- members retain access to existing workspaces; new workspaces begin with their creator.
begin;
create table public.team_workspace_memberships (
  workspace_id uuid not null references public.team_workspaces(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null check (role in ('owner','admin','developer','viewer')),
  created_at timestamptz not null default now(),
  primary key (workspace_id,user_id)
);
create index team_workspace_memberships_user_idx on public.team_workspace_memberships(user_id,workspace_id);
insert into public.team_workspace_memberships(workspace_id,user_id,role)
select w.id,m.user_id,m.role from public.team_workspaces w
join public.organization_memberships m on m.organization_id=w.organization_id
on conflict (workspace_id,user_id) do nothing;
create function private.initialize_team_workspace_owner() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  insert into public.team_workspace_memberships(workspace_id,user_id,role)
  values (new.id,new.created_by,'owner');
  return new;
end;
$$;
revoke all on function private.initialize_team_workspace_owner() from public,anon,authenticated;
create trigger a_initialize_team_workspace_owner after insert on public.team_workspaces
  for each row execute function private.initialize_team_workspace_owner();
create function private.workspace_role_for(p_workspace_id uuid) returns text
language sql stable security definer set search_path = '' as $$
  select m.role from public.team_workspace_memberships m
  join public.team_workspaces w on w.id=m.workspace_id
  where m.workspace_id=p_workspace_id and m.user_id=(select auth.uid())
    and private.organization_role_for(w.organization_id) is not null
  limit 1
$$;
revoke all on function private.workspace_role_for(uuid) from public,anon;
grant execute on function private.workspace_role_for(uuid) to authenticated;
create or replace function private.can_access_team_workspace(p_workspace_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select private.workspace_role_for(p_workspace_id) is not null
$$;
create or replace function private.can_write_team_workspace(p_workspace_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select private.workspace_role_for(p_workspace_id) in ('owner','admin','developer')
$$;
alter table public.team_workspace_memberships enable row level security;
create policy "members read workspace members" on public.team_workspace_memberships
  for select to authenticated using (user_id=(select auth.uid()) or
    private.workspace_role_for(workspace_id) in ('owner','admin'));
grant select on public.team_workspace_memberships to authenticated;
revoke insert,update,delete on public.team_workspace_memberships from authenticated;
drop policy "members read team workspaces" on public.team_workspaces;
create policy "workspace members read team workspaces" on public.team_workspaces
  for select to authenticated using (private.can_access_team_workspace(id));
drop policy "developers update team workspaces" on public.team_workspaces;
create policy "workspace editors update team workspaces" on public.team_workspaces
  for update to authenticated using (private.can_write_team_workspace(id))
  with check (private.can_write_team_workspace(id));
drop policy "members read team change events" on public.team_change_events;
create policy "workspace members read team change events" on public.team_change_events
  for select to authenticated using (workspace_id is not null and private.can_access_team_workspace(workspace_id));
drop policy "members read accepted operations" on public.team_accepted_operations;
create policy "actors read own accepted operations" on public.team_accepted_operations
  for select to authenticated using (actor_id=(select auth.uid()));
-- CI receipts have no workspace key. Brokered, repository-scoped reads are required.
revoke select on public.team_ci_receipts from authenticated;
create function private.guard_team_workspace_scoped_write() returns trigger
language plpgsql set search_path = '' as $$
declare v_workspace_id uuid;
begin
  v_workspace_id := case when tg_op='DELETE' then old.workspace_id else new.workspace_id end;
  if (select auth.uid()) is null then
    if (select auth.role()) = 'service_role' then
      if tg_op='DELETE' then return old; else return new; end if;
    end if;
    raise exception 'AUTH_REQUIRED' using errcode='28000';
  end if;
  if not private.can_write_team_workspace(v_workspace_id) then
    raise exception 'WORKSPACE_WRITE_DENIED' using errcode='42501';
  end if;
  if tg_op='UPDATE' and not private.can_write_team_workspace(old.workspace_id) then
    raise exception 'WORKSPACE_WRITE_DENIED' using errcode='42501';
  end if;
  if tg_op='DELETE' then return old; else return new; end if;
end;
$$;
revoke all on function private.guard_team_workspace_scoped_write() from public,anon,authenticated;
create trigger guard_workspace_task_write before insert or update or delete on public.team_tasks
  for each row execute function private.guard_team_workspace_scoped_write();
create trigger guard_workspace_decision_write before insert or update or delete on public.team_decisions
  for each row execute function private.guard_team_workspace_scoped_write();
create trigger guard_workspace_evidence_write before insert or update or delete on public.team_evidence
  for each row execute function private.guard_team_workspace_scoped_write();
create trigger guard_workspace_comment_write before insert or update or delete on public.team_comments
  for each row execute function private.guard_team_workspace_scoped_write();
create trigger guard_workspace_receipt_write before insert or update or delete on public.team_receipts
  for each row execute function private.guard_team_workspace_scoped_write();
create trigger guard_workspace_graph_node_write before insert or update or delete on public.team_graph_nodes
  for each row execute function private.guard_team_workspace_scoped_write();
create trigger guard_workspace_graph_edge_write before insert or update or delete on public.team_graph_edges
  for each row execute function private.guard_team_workspace_scoped_write();
create trigger guard_workspace_pr_write before insert or update or delete on public.team_pull_requests
  for each row execute function private.guard_team_workspace_scoped_write();

-- Replace organization-wide SECURITY DEFINER reads with workspace filters.
create or replace function public.get_team_snapshot(p_organization_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_snapshot jsonb;
begin
  if auth.uid() is null then
    raise exception 'AUTH_REQUIRED' using errcode = '28000';
  end if;
  if private.organization_role_for(p_organization_id) is null then
    raise exception 'ORGANIZATION_ACCESS_DENIED' using errcode = '42501';
  end if;

  -- The high-water mark and rows are read by one statement under one MVCC
  -- snapshot. An event committed later will remain available to cursor pulls.
  with entities as (
    select 'workspace'::text as entity_type, w.id as entity_id,
      public.team_workspace_sync_payload(w.id) as payload
    from public.team_workspaces w where w.organization_id = p_organization_id and private.can_access_team_workspace(w.id)
    union all
    select 'task', t.id,
      jsonb_build_object('id', t.id, 'workspaceId', t.workspace_id,
        'externalId', t.external_id, 'title', t.title, 'description', t.description,
        'status', t.status, 'ownerId', t.owner_id, 'revisionSet', t.revision_set,
        'scope', t.scope, 'dependencies', t.dependencies, 'provenance', t.provenance,
        'version', t.version, 'updatedAt', t.updated_at)
    from public.team_tasks t join public.team_workspaces w on w.id = t.workspace_id
    where w.organization_id = p_organization_id and private.can_access_team_workspace(w.id)
    union all
    select 'decision', d.id,
      jsonb_build_object('id', d.id, 'workspaceId', d.workspace_id,
        'taskId', d.task_id, 'body', d.body, 'sourceRefs', d.source_refs,
        'supersedesId', d.supersedes_id,
        'createdBy', d.created_by, 'createdAt', d.created_at)
    from public.team_decisions d join public.team_workspaces w on w.id = d.workspace_id
    where w.organization_id = p_organization_id and private.can_access_team_workspace(w.id)
    union all
    select 'evidence', e.id,
      jsonb_build_object('id', e.id, 'workspaceId', e.workspace_id,
        'taskId', e.task_id, 'kind', e.kind, 'producer', e.producer,
        'revisionSet', e.revision_set, 'payload', e.payload,
        'createdBy', e.created_by, 'createdAt', e.created_at)
    from public.team_evidence e join public.team_workspaces w on w.id = e.workspace_id
    where w.organization_id = p_organization_id and private.can_access_team_workspace(w.id)
    union all
    select 'comment', c.id,
      jsonb_build_object('id', c.id, 'workspaceId', c.workspace_id,
        'taskId', c.task_id, 'body', c.body, 'createdBy', c.created_by,
        'createdAt', c.created_at)
    from public.team_comments c join public.team_workspaces w on w.id = c.workspace_id
    where w.organization_id = p_organization_id and private.can_access_team_workspace(w.id)
    union all
    select 'receipt', r.id,
      jsonb_build_object('id', r.id, 'workspaceId', r.workspace_id,
        'taskId', r.task_id, 'result', r.result, 'summary', r.summary,
        'revisionSet', r.revision_set, 'sourceRefs', r.source_refs,
        'createdBy', r.created_by, 'createdAt', r.created_at)
    from public.team_receipts r join public.team_workspaces w on w.id = r.workspace_id
    where w.organization_id = p_organization_id and private.can_access_team_workspace(w.id)
  ), bounded as (
    select * from entities order by entity_type, entity_id limit 10001
  )
  select jsonb_build_object(
    'cursor', greatest(
      (select coalesce(max(sequence), 0) from public.team_change_events
        where organization_id = p_organization_id),
      (select coalesce(floor_sequence, 0) from public.team_sync_floors
        where organization_id = p_organization_id)),
    'entities', coalesce(jsonb_agg(jsonb_build_object(
      'entityType', b.entity_type, 'entityId', b.entity_id, 'payload', b.payload)
      order by b.entity_type, b.entity_id), '[]'::jsonb))
  into v_snapshot from bounded b;
  if jsonb_array_length(v_snapshot -> 'entities') > 10000 then
    raise exception 'TEAM_SNAPSHOT_TOO_LARGE' using errcode = '54000';
  end if;
  return v_snapshot;
end;
$$;

create or replace function public.get_team_change_page(
  p_organization_id uuid, p_after bigint, p_limit integer default 100
)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_result jsonb;
begin
  if auth.uid() is null then raise exception 'AUTH_REQUIRED' using errcode = '28000'; end if;
  if private.organization_role_for(p_organization_id) is null then
    raise exception 'ORGANIZATION_ACCESS_DENIED' using errcode = '42501'; end if;
  if p_after < 0 or p_limit not between 1 and 100 then
    raise exception 'INVALID_CHANGE_CURSOR' using errcode = '22023'; end if;
  -- Floor and page are read under one MVCC snapshot, including during pruning.
  with floor as (
    select coalesce((select floor_sequence from public.team_sync_floors
      where organization_id = p_organization_id), 0) as sequence
  ), rows as (
    select e.* from public.team_change_events e
      where e.organization_id = p_organization_id and e.sequence > p_after
        and e.workspace_id is not null and private.can_access_team_workspace(e.workspace_id)
      order by e.sequence asc limit p_limit + 1
  ), page as (
    select * from rows order by sequence asc limit p_limit
  )
  select jsonb_build_object('expired', p_after < floor.sequence,
    'events', coalesce((select jsonb_agg(jsonb_build_object(
      'sequence', e.sequence, 'organization_id', e.organization_id,
      'workspace_id', e.workspace_id, 'operation_id', e.operation_id,
      'entity_type', e.entity_type, 'entity_id', e.entity_id,
      'event_type', e.event_type, 'payload', e.payload, 'created_at', e.created_at)
      order by e.sequence) from page e), '[]'::jsonb),
    'nextCursor', coalesce((select max(sequence) from page), p_after),
    'hasMore', (select count(*) > p_limit from rows))
    into v_result from floor;
  return v_result;
end;
$$;

create or replace function public.resolve_team_task_context(
  p_organization_id uuid, p_task_id uuid, p_limit integer default 25
)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_result jsonb;
begin
  if auth.uid() is null then raise exception 'AUTH_REQUIRED' using errcode = '28000'; end if;
  if private.organization_role_for(p_organization_id) is null then
    raise exception 'ORGANIZATION_ACCESS_DENIED' using errcode = '42501'; end if;
  if p_limit not between 1 and 50 then raise exception 'INVALID_CONTEXT_LIMIT' using errcode = '22023'; end if;
  select jsonb_build_object(
    'task', jsonb_build_object('id', t.id, 'externalId', t.external_id,
      'workspaceId', t.workspace_id, 'title', t.title, 'description', t.description,
      'status', t.status, 'ownerId', t.owner_id, 'revisionSet', t.revision_set,
      'scope', t.scope, 'dependencies', t.dependencies, 'provenance', t.provenance,
      'version', t.version, 'updatedAt', t.updated_at),
    'workspace', jsonb_build_object('id', w.id, 'name', w.name, 'organizationId', w.organization_id),
    'projects', coalesce((select jsonb_agg(jsonb_build_object('projectKey', p.project_key,
      'repository', p.repository, 'remoteUrl', p.remote_url, 'repositoryRoot', p.repository_root))
      from public.team_workspace_projects p where p.workspace_id = w.id), '[]'::jsonb),
    'unresolvedDependencies', coalesce((select jsonb_agg(dep.value)
      from jsonb_array_elements_text(t.dependencies) dep(value)
      where not exists (select 1 from public.team_tasks other
        where other.workspace_id = t.workspace_id and other.external_id = dep.value
          and other.status = 'completed')), '[]'::jsonb),
    'decisions', coalesce((select jsonb_agg(x.item order by x.created_at desc)
      from (select jsonb_build_object('id', d.id, 'body', d.body,
        'sourceRefs', d.source_refs, 'supersedesId', d.supersedes_id,
        'createdBy', d.created_by, 'createdAt', d.created_at) item, d.created_at
        from public.team_decisions d where d.task_id = t.id and not exists
          (select 1 from public.team_decisions newer where newer.supersedes_id = d.id)
        order by d.created_at desc limit p_limit) x), '[]'::jsonb),
    'comments', coalesce((select jsonb_agg(x.item order by x.created_at desc)
      from (select jsonb_build_object('id', c.id, 'body', c.body,
        'createdBy', c.created_by, 'createdAt', c.created_at) item, c.created_at
        from public.team_comments c where c.task_id = t.id
        order by c.created_at desc limit p_limit) x), '[]'::jsonb),
    'evidence', coalesce((select jsonb_agg(x.item order by x.created_at desc)
      from (select jsonb_build_object('id', e.id, 'kind', e.kind, 'producer', e.producer,
        'revisionSet', e.revision_set, 'payload', e.payload, 'createdBy', e.created_by,
        'createdAt', e.created_at, 'freshness', case when e.revision_set = t.revision_set
          then 'current' else 'stale' end) item, e.created_at
        from public.team_evidence e where e.task_id = t.id
        order by e.created_at desc limit p_limit) x), '[]'::jsonb),
    'receipts', coalesce((select jsonb_agg(x.item order by x.created_at desc)
      from (select jsonb_build_object('id', r.id, 'result', r.result,
        'summary', r.summary, 'revisionSet', r.revision_set,
        'sourceRefs', r.source_refs, 'createdBy', r.created_by,
        'createdAt', r.created_at, 'freshness', case when r.revision_set = t.revision_set
          then 'current' else 'stale' end) item, r.created_at
        from public.team_receipts r where r.task_id = t.id
        order by r.created_at desc limit p_limit) x), '[]'::jsonb),
    'resolvedAt', now(),
    'changeCursor', (select coalesce(max(sequence), 0) from public.team_change_events
      where organization_id = p_organization_id))
    into v_result from public.team_tasks t
    join public.team_workspaces w on w.id = t.workspace_id
    where t.id = p_task_id and w.organization_id = p_organization_id
      and private.can_access_team_workspace(w.id);
  if v_result is null then raise exception 'TASK_NOT_FOUND' using errcode = '42501'; end if;
  return v_result;
end;
$$;

create or replace function public.search_team_decisions(
  p_organization_id uuid, p_query text, p_limit integer default 25
)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_result jsonb;
begin
  if auth.uid() is null then raise exception 'AUTH_REQUIRED' using errcode = '28000'; end if;
  if private.organization_role_for(p_organization_id) is null then
    raise exception 'ORGANIZATION_ACCESS_DENIED' using errcode = '42501'; end if;
  if char_length(trim(coalesce(p_query, ''))) not between 2 and 120
    or p_limit not between 1 and 50 then
    raise exception 'INVALID_DECISION_SEARCH' using errcode = '22023'; end if;
  select coalesce(jsonb_agg(jsonb_build_object('id', x.id, 'workspaceId', x.workspace_id,
    'taskId', x.task_id, 'body', x.body, 'sourceRefs', x.source_refs,
    'createdBy', x.created_by, 'createdAt', x.created_at)
    order by x.created_at desc), '[]'::jsonb) into v_result
  from (select d.* from public.team_decisions d
    join public.team_workspaces w on w.id = d.workspace_id
    where w.organization_id = p_organization_id and private.can_access_team_workspace(w.id)
      and d.body ilike '%' || p_query || '%'
      and not exists (select 1 from public.team_decisions newer where newer.supersedes_id = d.id)
    order by d.created_at desc limit p_limit) x;
  return v_result;
end;
$$;
commit;
