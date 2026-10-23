-- Task mutations must pass through the operation RPC, which writes the task,
-- acknowledgment and change event in one transaction. A snapshot gives clients
-- a consistent recovery point if an earlier part of the feed is retired.
begin;

revoke insert, update, delete on public.team_tasks from authenticated;
revoke insert, update, delete on public.team_accepted_operations from authenticated;
revoke insert, update, delete on public.team_change_events from authenticated;

create table public.team_sync_floors (
  organization_id uuid primary key references public.organizations(id) on delete cascade,
  floor_sequence bigint not null default 0 check (floor_sequence >= 0),
  updated_at timestamptz not null default now()
);
alter table public.team_sync_floors enable row level security;
create policy "members read team sync floor" on public.team_sync_floors
  for select to authenticated
  using (private.organization_role_for(organization_id) is not null);
grant select on public.team_sync_floors to authenticated;

create function public.get_team_snapshot(p_organization_id uuid)
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
      jsonb_build_object('id', w.id, 'organizationId', w.organization_id,
        'name', w.name, 'description', w.description, 'updatedAt', w.updated_at) as payload
    from public.team_workspaces w where w.organization_id = p_organization_id
    union all
    select 'task', t.id,
      jsonb_build_object('id', t.id, 'workspaceId', t.workspace_id,
        'externalId', t.external_id, 'title', t.title, 'description', t.description,
        'status', t.status, 'ownerId', t.owner_id, 'revisionSet', t.revision_set,
        'version', t.version, 'updatedAt', t.updated_at)
    from public.team_tasks t join public.team_workspaces w on w.id = t.workspace_id
    where w.organization_id = p_organization_id
    union all
    select 'decision', d.id,
      jsonb_build_object('id', d.id, 'workspaceId', d.workspace_id,
        'taskId', d.task_id, 'body', d.body, 'sourceRefs', d.source_refs,
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
  ), bounded as (
    select * from entities order by entity_type, entity_id limit 10001
  )
  select jsonb_build_object(
    'cursor', (select coalesce(max(sequence), 0) from public.team_change_events
      where organization_id = p_organization_id),
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
revoke all on function public.get_team_snapshot(uuid) from public, anon;
grant execute on function public.get_team_snapshot(uuid) to authenticated;

commit;
