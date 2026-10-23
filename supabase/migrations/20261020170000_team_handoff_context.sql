-- Optimistic task context updates and bounded, membership-checked handoff reads.
begin;

create function public.apply_team_task_context_operation(
  p_organization_id uuid, p_workspace_id uuid, p_device_id uuid,
  p_operation_id uuid, p_task_id uuid, p_base_version bigint,
  p_owner_id uuid, p_scope jsonb, p_dependencies jsonb, p_provenance jsonb
)
returns table (task_id uuid, task_version bigint, change_sequence bigint, was_duplicate boolean)
language plpgsql security definer set search_path = '' as $$
declare
  v_actor uuid := auth.uid();
  v_task public.team_tasks%rowtype;
  v_fingerprint text;
  v_existing text;
begin
  if v_actor is null then raise exception 'AUTH_REQUIRED' using errcode = '28000'; end if;
  if not exists (select 1 from public.team_devices d where d.id = p_device_id
    and d.organization_id = p_organization_id and d.user_id = v_actor and d.revoked_at is null) then
    raise exception 'DEVICE_REVOKED_OR_UNKNOWN' using errcode = '42501'; end if;
  if not exists (select 1 from public.team_workspaces w where w.id = p_workspace_id
    and w.organization_id = p_organization_id
    and private.organization_role_for(w.organization_id) in ('owner', 'admin', 'developer')) then
    raise exception 'WORKSPACE_ACCESS_DENIED' using errcode = '42501'; end if;
  if p_base_version < 1 or jsonb_typeof(p_scope) <> 'array'
    or jsonb_typeof(p_dependencies) <> 'array' or jsonb_typeof(p_provenance) <> 'object'
    or jsonb_array_length(p_scope) > 32 or jsonb_array_length(p_dependencies) > 100
    or octet_length(p_scope::text) > 16000 or octet_length(p_provenance::text) > 8000 then
    raise exception 'INVALID_TASK_CONTEXT' using errcode = '22023'; end if;
  if p_owner_id is not null and not exists (select 1 from public.organization_memberships m
    where m.organization_id = p_organization_id and m.user_id = p_owner_id) then
    raise exception 'OWNER_OUTSIDE_ORGANIZATION' using errcode = '42501'; end if;
  if exists (select 1 from jsonb_array_elements(p_scope) item
    where jsonb_typeof(item) <> 'object' or coalesce(item ->> 'projectKey', '') !~ '^prj_[A-Za-z0-9_-]{4,100}$'
      or not exists (select 1 from public.team_workspace_projects p
        where p.workspace_id = p_workspace_id and p.project_key = item ->> 'projectKey')) then
    raise exception 'SCOPE_OUTSIDE_WORKSPACE' using errcode = '22023'; end if;
  if exists (select 1 from jsonb_array_elements_text(p_dependencies) dep
    where dep !~ '^task_[A-Za-z0-9_-]{4,100}$') then
    raise exception 'INVALID_DEPENDENCY' using errcode = '22023'; end if;

  v_fingerprint := pg_catalog.md5(p_workspace_id::text || ':' || p_task_id::text || ':' ||
    p_base_version::text || ':' || coalesce(p_owner_id::text, '') || ':' ||
    p_scope::text || ':' || p_dependencies::text || ':' || p_provenance::text);
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_organization_id::text, 0));
  insert into public.team_accepted_operations
    (organization_id, device_id, operation_id, actor_id, request_fingerprint)
  values (p_organization_id, p_device_id, p_operation_id, v_actor, v_fingerprint)
  on conflict (organization_id, operation_id) do nothing;
  if not found then
    select a.request_fingerprint into v_existing from public.team_accepted_operations a
      where a.organization_id = p_organization_id and a.operation_id = p_operation_id;
    if v_existing is distinct from v_fingerprint then
      raise exception 'OPERATION_ID_REUSED' using errcode = '40001'; end if;
    select e.entity_id, (e.payload ->> 'version')::bigint, e.sequence
      into task_id, task_version, change_sequence from public.team_change_events e
      where e.organization_id = p_organization_id and e.operation_id = p_operation_id;
    if task_id is null then raise exception 'ACCEPTED_OPERATION_EVENT_MISSING' using errcode = '55000'; end if;
    was_duplicate := true;
    return next;
    return;
  end if;

  select * into v_task from public.team_tasks where id = p_task_id
    and workspace_id = p_workspace_id for update;
  if not found then raise exception 'TASK_NOT_FOUND' using errcode = '42501'; end if;
  if v_task.version <> p_base_version then raise exception 'VERSION_CONFLICT' using errcode = '40001'; end if;
  update public.team_tasks set owner_id = p_owner_id, scope = p_scope,
    dependencies = p_dependencies, provenance = p_provenance,
    version = version + 1, updated_at = now()
    where id = p_task_id returning * into v_task;
  insert into public.team_change_events
    (organization_id, workspace_id, operation_id, entity_type, entity_id, event_type, payload)
  values (p_organization_id, p_workspace_id, p_operation_id, 'task', v_task.id, 'updated',
    jsonb_build_object('id', v_task.id, 'workspaceId', v_task.workspace_id,
      'externalId', v_task.external_id, 'title', v_task.title, 'description', v_task.description,
      'status', v_task.status, 'ownerId', v_task.owner_id, 'revisionSet', v_task.revision_set,
      'scope', v_task.scope, 'dependencies', v_task.dependencies,
      'provenance', v_task.provenance, 'version', v_task.version,
      'updatedAt', v_task.updated_at)) returning sequence into change_sequence;
  task_id := v_task.id;
  task_version := v_task.version;
  was_duplicate := false;
  return next;
end;
$$;
revoke all on function public.apply_team_task_context_operation(uuid,uuid,uuid,uuid,uuid,bigint,uuid,jsonb,jsonb,jsonb) from public, anon;
grant execute on function public.apply_team_task_context_operation(uuid,uuid,uuid,uuid,uuid,bigint,uuid,jsonb,jsonb,jsonb) to authenticated;

create function public.resolve_team_task_context(
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
    where t.id = p_task_id and w.organization_id = p_organization_id;
  if v_result is null then raise exception 'TASK_NOT_FOUND' using errcode = '42501'; end if;
  return v_result;
end;
$$;
revoke all on function public.resolve_team_task_context(uuid,uuid,integer) from public, anon;
grant execute on function public.resolve_team_task_context(uuid,uuid,integer) to authenticated;

create function public.search_team_decisions(
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
    where w.organization_id = p_organization_id and d.body ilike '%' || p_query || '%'
      and not exists (select 1 from public.team_decisions newer where newer.supersedes_id = d.id)
    order by d.created_at desc limit p_limit) x;
  return v_result;
end;
$$;
revoke all on function public.search_team_decisions(uuid,text,integer) from public, anon;
grant execute on function public.search_team_decisions(uuid,text,integer) to authenticated;

commit;
