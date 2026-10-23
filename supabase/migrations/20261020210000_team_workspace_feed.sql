-- Workspace and repository binding changes enter the same ordered change feed as task writes.
begin;

create function public.team_workspace_sync_payload(p_workspace_id uuid)
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('id', w.id, 'organizationId', w.organization_id,
    'name', w.name, 'description', w.description, 'version', w.version,
    'updatedAt', w.updated_at,
    'projects', coalesce((select jsonb_agg(jsonb_build_object(
      'projectKey', p.project_key, 'provider', p.provider,
      'providerRepositoryId', p.provider_repository_id,
      'repository', p.repository, 'remoteUrl', p.remote_url,
      'repositoryRoot', p.repository_root, 'version', p.version,
      'updatedAt', p.updated_at) order by p.project_key)
      from public.team_workspace_projects p where p.workspace_id = w.id), '[]'::jsonb))
  from public.team_workspaces w where w.id = p_workspace_id
$$;
revoke all on function public.team_workspace_sync_payload(uuid) from public, anon, authenticated;

create function public.log_team_workspace_change()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(new.organization_id::text, 0));
  insert into public.team_change_events
    (organization_id, workspace_id, entity_type, entity_id, event_type, payload)
  values (new.organization_id, new.id, 'workspace', new.id,
    case when tg_op = 'INSERT' then 'created' else 'updated' end,
    public.team_workspace_sync_payload(new.id));
  return new;
end;
$$;
revoke all on function public.log_team_workspace_change() from public, anon, authenticated;
create trigger team_workspace_change_feed after insert or update on public.team_workspaces
  for each row execute function public.log_team_workspace_change();

create function public.log_team_project_change()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  v_workspace_id uuid;
  v_organization_id uuid;
begin
  v_workspace_id := case when tg_op = 'DELETE' then old.workspace_id else new.workspace_id end;
  select w.organization_id into v_organization_id from public.team_workspaces w
    where w.id = v_workspace_id;
  if v_organization_id is null then
    if tg_op = 'DELETE' then return old; else return new; end if;
  end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(v_organization_id::text, 0));
  insert into public.team_change_events
    (organization_id, workspace_id, entity_type, entity_id, event_type, payload)
  values (v_organization_id, v_workspace_id, 'workspace', v_workspace_id,
    'updated', public.team_workspace_sync_payload(v_workspace_id));
  if tg_op = 'DELETE' then return old; else return new; end if;
end;
$$;
revoke all on function public.log_team_project_change() from public, anon, authenticated;
create trigger team_project_change_feed after insert or update or delete on public.team_workspace_projects
  for each row execute function public.log_team_project_change();

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
    from public.team_workspaces w where w.organization_id = p_organization_id
    union all
    select 'task', t.id,
      jsonb_build_object('id', t.id, 'workspaceId', t.workspace_id,
        'externalId', t.external_id, 'title', t.title, 'description', t.description,
        'status', t.status, 'ownerId', t.owner_id, 'revisionSet', t.revision_set,
        'scope', t.scope, 'dependencies', t.dependencies, 'provenance', t.provenance,
        'version', t.version, 'updatedAt', t.updated_at)
    from public.team_tasks t join public.team_workspaces w on w.id = t.workspace_id
    where w.organization_id = p_organization_id
    union all
    select 'decision', d.id,
      jsonb_build_object('id', d.id, 'workspaceId', d.workspace_id,
        'taskId', d.task_id, 'body', d.body, 'sourceRefs', d.source_refs,
        'supersedesId', d.supersedes_id,
        'createdBy', d.created_by, 'createdAt', d.created_at)
    from public.team_decisions d join public.team_workspaces w on w.id = d.workspace_id
    where w.organization_id = p_organization_id
    union all
    select 'evidence', e.id,
      jsonb_build_object('id', e.id, 'workspaceId', e.workspace_id,
        'taskId', e.task_id, 'kind', e.kind, 'producer', e.producer,
        'revisionSet', e.revision_set, 'payload', e.payload,
        'createdBy', e.created_by, 'createdAt', e.created_at)
    from public.team_evidence e join public.team_workspaces w on w.id = e.workspace_id
    where w.organization_id = p_organization_id
    union all
    select 'comment', c.id,
      jsonb_build_object('id', c.id, 'workspaceId', c.workspace_id,
        'taskId', c.task_id, 'body', c.body, 'createdBy', c.created_by,
        'createdAt', c.created_at)
    from public.team_comments c join public.team_workspaces w on w.id = c.workspace_id
    where w.organization_id = p_organization_id
    union all
    select 'receipt', r.id,
      jsonb_build_object('id', r.id, 'workspaceId', r.workspace_id,
        'taskId', r.task_id, 'result', r.result, 'summary', r.summary,
        'revisionSet', r.revision_set, 'sourceRefs', r.source_refs,
        'createdBy', r.created_by, 'createdAt', r.created_at)
    from public.team_receipts r join public.team_workspaces w on w.id = r.workspace_id
    where w.organization_id = p_organization_id
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

commit;
