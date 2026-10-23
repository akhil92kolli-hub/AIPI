-- Append-only collaboration records and versioned task handoff context.
begin;

alter table public.team_tasks
  add column scope jsonb not null default '[]'::jsonb check (jsonb_typeof(scope) = 'array'),
  add column dependencies jsonb not null default '[]'::jsonb check (jsonb_typeof(dependencies) = 'array'),
  add column provenance jsonb not null default '{}'::jsonb check (jsonb_typeof(provenance) = 'object');
alter table public.team_decisions
  add column supersedes_id uuid,
  add constraint team_decisions_workspace_id_id_key unique (workspace_id, id),
  add constraint team_decisions_supersedes_same_workspace foreign key (workspace_id, supersedes_id)
    references public.team_decisions (workspace_id, id);

create table public.team_comments (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.team_workspaces(id) on delete cascade,
  task_id uuid not null,
  body text not null check (char_length(body) between 1 and 16000),
  created_by uuid not null references auth.users(id) on delete restrict,
  created_at timestamptz not null default now(),
  foreign key (workspace_id, task_id) references public.team_tasks (workspace_id, id) on delete cascade
);
create index team_comments_task_created_idx on public.team_comments (task_id, created_at desc);

create table public.team_receipts (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.team_workspaces(id) on delete cascade,
  task_id uuid not null,
  result text not null check (result in ('passed', 'failed', 'inconclusive')),
  summary text not null check (char_length(summary) between 1 and 4000),
  revision_set jsonb not null default '[]'::jsonb check (jsonb_typeof(revision_set) = 'array'),
  source_refs jsonb not null default '[]'::jsonb check (jsonb_typeof(source_refs) = 'array'),
  created_by uuid not null references auth.users(id) on delete restrict,
  created_at timestamptz not null default now(),
  foreign key (workspace_id, task_id) references public.team_tasks (workspace_id, id) on delete cascade
);
create index team_receipts_task_created_idx on public.team_receipts (task_id, created_at desc);

alter table public.team_comments enable row level security;
alter table public.team_receipts enable row level security;
create policy "members read team comments" on public.team_comments for select to authenticated
  using (private.can_access_team_workspace(workspace_id));
create policy "members read team receipts" on public.team_receipts for select to authenticated
  using (private.can_access_team_workspace(workspace_id));
grant select on public.team_comments, public.team_receipts to authenticated;
revoke insert, update, delete on public.team_decisions, public.team_evidence from authenticated;

alter table public.team_change_events drop constraint team_change_events_entity_type_check;
alter table public.team_change_events add constraint team_change_events_entity_type_check
  check (entity_type in ('workspace', 'workspace_project', 'task', 'decision', 'evidence', 'comment', 'receipt'));
alter table public.team_accepted_operations add column request_fingerprint text;

create function public.apply_team_append_operation(
  p_organization_id uuid, p_workspace_id uuid, p_device_id uuid,
  p_operation_id uuid, p_entity_type text, p_payload jsonb
)
returns table (entity_id uuid, change_sequence bigint, was_duplicate boolean)
language plpgsql security definer set search_path = '' as $$
declare
  v_actor uuid := auth.uid();
  v_task uuid;
  v_fingerprint text;
  v_existing text;
  v_payload jsonb;
  v_supersedes uuid;
begin
  if v_actor is null then raise exception 'AUTH_REQUIRED' using errcode = '28000'; end if;
  if not exists (select 1 from public.team_devices d where d.id = p_device_id
    and d.organization_id = p_organization_id and d.user_id = v_actor and d.revoked_at is null) then
    raise exception 'DEVICE_REVOKED_OR_UNKNOWN' using errcode = '42501'; end if;
  if not exists (select 1 from public.team_workspaces w where w.id = p_workspace_id
    and w.organization_id = p_organization_id
    and private.organization_role_for(w.organization_id) in ('owner', 'admin', 'developer')) then
    raise exception 'WORKSPACE_ACCESS_DENIED' using errcode = '42501'; end if;
  if p_entity_type not in ('decision', 'evidence', 'comment', 'receipt')
    or jsonb_typeof(p_payload) <> 'object' or octet_length(p_payload::text) > 65536 then
    raise exception 'INVALID_APPEND_OPERATION' using errcode = '22023'; end if;
  if p_payload ? 'taskId' and nullif(p_payload ->> 'taskId', '') is not null then
    v_task := (p_payload ->> 'taskId')::uuid;
    if not exists (select 1 from public.team_tasks t where t.id = v_task and t.workspace_id = p_workspace_id) then
      raise exception 'TASK_OUTSIDE_WORKSPACE' using errcode = '42501'; end if;
  end if;
  if p_entity_type in ('comment', 'receipt') and v_task is null then
    raise exception 'TASK_REQUIRED' using errcode = '22023'; end if;
  v_fingerprint := pg_catalog.md5(p_entity_type || ':' || p_workspace_id::text || ':' || p_payload::text);
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
    select e.entity_id, e.sequence into entity_id, change_sequence
      from public.team_change_events e where e.organization_id = p_organization_id
        and e.operation_id = p_operation_id;
    if entity_id is null then raise exception 'ACCEPTED_OPERATION_EVENT_MISSING' using errcode = '55000'; end if;
    was_duplicate := true;
    return next;
    return;
  end if;

  if p_entity_type = 'decision' then
    if char_length(trim(coalesce(p_payload ->> 'body', ''))) not between 1 and 16000
      or jsonb_typeof(coalesce(p_payload -> 'sourceRefs', '[]'::jsonb)) <> 'array' then
      raise exception 'INVALID_DECISION' using errcode = '22023'; end if;
    v_supersedes := nullif(p_payload ->> 'supersedesId', '')::uuid;
    if v_supersedes is not null and not exists (select 1 from public.team_decisions d
      where d.id = v_supersedes and d.workspace_id = p_workspace_id and d.task_id is not distinct from v_task) then
      raise exception 'INVALID_SUPERSEDED_DECISION' using errcode = '22023'; end if;
    insert into public.team_decisions (workspace_id, task_id, body, source_refs, supersedes_id, created_by)
      values (p_workspace_id, v_task, p_payload ->> 'body', coalesce(p_payload -> 'sourceRefs', '[]'::jsonb), v_supersedes, v_actor)
      returning id into entity_id;
    select jsonb_build_object('id', d.id, 'workspaceId', d.workspace_id, 'taskId', d.task_id,
      'body', d.body, 'sourceRefs', d.source_refs, 'supersedesId', d.supersedes_id,
      'createdBy', d.created_by, 'createdAt', d.created_at)
      into v_payload from public.team_decisions d where d.id = entity_id;
  elsif p_entity_type = 'evidence' then
    if p_payload ->> 'kind' not in ('declared', 'static', 'runtime', 'verification', 'ai_suggestion')
      or char_length(trim(coalesce(p_payload ->> 'producer', ''))) not between 1 and 160
      or jsonb_typeof(coalesce(p_payload -> 'revisionSet', '[]'::jsonb)) <> 'array'
      or jsonb_typeof(coalesce(p_payload -> 'payload', '{}'::jsonb)) <> 'object' then
      raise exception 'INVALID_EVIDENCE' using errcode = '22023'; end if;
    insert into public.team_evidence (workspace_id, task_id, kind, producer, revision_set, payload, created_by)
      values (p_workspace_id, v_task, p_payload ->> 'kind', p_payload ->> 'producer',
        coalesce(p_payload -> 'revisionSet', '[]'::jsonb), coalesce(p_payload -> 'payload', '{}'::jsonb), v_actor)
      returning id into entity_id;
    select jsonb_build_object('id', e.id, 'workspaceId', e.workspace_id, 'taskId', e.task_id,
      'kind', e.kind, 'producer', e.producer, 'revisionSet', e.revision_set,
      'payload', e.payload, 'createdBy', e.created_by, 'createdAt', e.created_at)
      into v_payload from public.team_evidence e where e.id = entity_id;
  elsif p_entity_type = 'comment' then
    if char_length(trim(coalesce(p_payload ->> 'body', ''))) not between 1 and 16000 then
      raise exception 'INVALID_COMMENT' using errcode = '22023'; end if;
    insert into public.team_comments (workspace_id, task_id, body, created_by)
      values (p_workspace_id, v_task, p_payload ->> 'body', v_actor) returning id into entity_id;
    select jsonb_build_object('id', c.id, 'workspaceId', c.workspace_id, 'taskId', c.task_id,
      'body', c.body, 'createdBy', c.created_by, 'createdAt', c.created_at)
      into v_payload from public.team_comments c where c.id = entity_id;
  else
    if p_payload ->> 'result' not in ('passed', 'failed', 'inconclusive')
      or char_length(trim(coalesce(p_payload ->> 'summary', ''))) not between 1 and 4000
      or jsonb_typeof(coalesce(p_payload -> 'revisionSet', '[]'::jsonb)) <> 'array'
      or jsonb_typeof(coalesce(p_payload -> 'sourceRefs', '[]'::jsonb)) <> 'array' then
      raise exception 'INVALID_RECEIPT' using errcode = '22023'; end if;
    insert into public.team_receipts (workspace_id, task_id, result, summary, revision_set, source_refs, created_by)
      values (p_workspace_id, v_task, p_payload ->> 'result', p_payload ->> 'summary',
        coalesce(p_payload -> 'revisionSet', '[]'::jsonb),
        coalesce(p_payload -> 'sourceRefs', '[]'::jsonb), v_actor) returning id into entity_id;
    select jsonb_build_object('id', r.id, 'workspaceId', r.workspace_id, 'taskId', r.task_id,
      'result', r.result, 'summary', r.summary, 'revisionSet', r.revision_set,
      'sourceRefs', r.source_refs, 'createdBy', r.created_by, 'createdAt', r.created_at)
      into v_payload from public.team_receipts r where r.id = entity_id;
  end if;
  insert into public.team_change_events
    (organization_id, workspace_id, operation_id, entity_type, entity_id, event_type, payload)
    values (p_organization_id, p_workspace_id, p_operation_id, p_entity_type, entity_id, 'created', v_payload)
    returning sequence into change_sequence;
  was_duplicate := false;
  return next;
end;
$$;
revoke all on function public.apply_team_append_operation(uuid,uuid,uuid,uuid,text,jsonb) from public, anon;
grant execute on function public.apply_team_append_operation(uuid,uuid,uuid,uuid,text,jsonb) to authenticated;

commit;
