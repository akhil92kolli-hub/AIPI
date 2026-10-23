-- R0: task field patches preserve cloud context; installation grants are broker-only.
begin;

alter table public.team_github_installations
  add column github_user_id bigint,
  add column github_user_login text,
  add column verified_at timestamptz;
-- Existing grants were checked with App identity only and must be reverified.
update public.team_github_installations set active = false where verified_at is null;
create function private.guard_team_installation_owner() returns trigger
language plpgsql set search_path = '' as $$
begin
  if new.organization_id is distinct from old.organization_id then
    raise exception 'INSTALLATION_OWNER_IMMUTABLE' using errcode = '42501';
  end if;
  return new;
end;
$$;
create trigger team_installation_owner_guard before update on public.team_github_installations
  for each row execute function private.guard_team_installation_owner();

alter table public.team_tasks drop constraint if exists team_tasks_status_check;
alter table public.team_tasks add column project_key text;
alter table public.team_tasks add constraint team_tasks_project_key_fkey
  foreign key (workspace_id, project_key)
  references public.team_workspace_projects(workspace_id, project_key) on delete set null (project_key);
alter table public.team_tasks add constraint team_tasks_status_check
  check (status in ('proposed','open','in_progress','in_review','blocked','completed','archived'));

-- A service-role broker must first verify the caller's GitHub user access.
drop policy if exists "owners manage github installations" on public.team_github_installations;
revoke insert, update, delete on public.team_github_installations from authenticated;
-- Task mutations must pass through the versioned operation RPC.
revoke insert, update, delete on public.team_tasks from authenticated;
revoke insert on public.team_accepted_operations from authenticated;
revoke execute on function public.apply_team_task_operation(uuid,uuid,uuid,uuid,text,text,text,text,jsonb,bigint) from authenticated;

create function public.apply_team_task_patch_operation(
  p_organization_id uuid, p_workspace_id uuid, p_device_id uuid,
  p_operation_id uuid, p_external_id text, p_patch jsonb, p_base_version bigint,
  p_project_key text default null
) returns table (task_id uuid, task_version bigint, change_sequence bigint, was_duplicate boolean)
language plpgsql security definer set search_path = '' as $$
declare
  v_actor uuid := (select auth.uid());
  v_task public.team_tasks%rowtype;
  v_sequence bigint;
  v_created boolean := false;
  v_fingerprint text;
  v_existing text;
begin
  if v_actor is null then raise exception 'AUTH_REQUIRED' using errcode = '28000'; end if;
  if not exists (select 1 from public.team_devices d where d.id = p_device_id
      and d.organization_id = p_organization_id and d.user_id = v_actor and d.revoked_at is null)
  then raise exception 'DEVICE_REVOKED_OR_UNKNOWN' using errcode = '42501'; end if;
  if not exists (select 1 from public.team_workspaces w where w.id = p_workspace_id
      and w.organization_id = p_organization_id
      and private.organization_role_for(w.organization_id) in ('owner','admin','developer'))
  then raise exception 'WORKSPACE_ACCESS_DENIED' using errcode = '42501'; end if;
  if p_base_version is null or p_base_version < 0
      or p_external_id !~ '^task_[A-Za-z0-9_-]{4,100}$'
      or jsonb_typeof(p_patch) <> 'object' or p_patch = '{}'::jsonb
      or exists (select 1 from jsonb_object_keys(p_patch) as keys(key)
        where key not in ('title','description','status','revisionSet'))
      or (p_patch ? 'title' and (jsonb_typeof(p_patch->'title') <> 'string'
        or char_length(p_patch->>'title') not between 1 and 500))
      or (p_patch ? 'description' and (jsonb_typeof(p_patch->'description') <> 'string'
        or char_length(p_patch->>'description') > 16000))
      or (p_patch ? 'status' and (jsonb_typeof(p_patch->'status') <> 'string'
        or p_patch->>'status' not in ('proposed','open','in_progress','in_review','blocked','completed','archived')))
      or (p_patch ? 'revisionSet' and (jsonb_typeof(p_patch->'revisionSet') <> 'array'
        or jsonb_array_length(p_patch->'revisionSet') > 32))
  then raise exception 'INVALID_TASK_PATCH' using errcode = '22023'; end if;
  if p_project_key is not null and not exists (select 1 from public.team_workspace_projects p
    where p.workspace_id = p_workspace_id and p.project_key = p_project_key)
  then raise exception 'TASK_PROJECT_UNAVAILABLE' using errcode = '22023'; end if;

  v_fingerprint := pg_catalog.md5(p_workspace_id::text || ':' || p_external_id || ':' ||
    p_base_version::text || ':' || coalesce(p_project_key,'') || ':' || p_patch::text);
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_organization_id::text, 0));
  insert into public.team_accepted_operations
    (organization_id,device_id,operation_id,actor_id,request_fingerprint)
  values (p_organization_id,p_device_id,p_operation_id,v_actor,v_fingerprint)
  on conflict (organization_id,operation_id) do nothing;
  if not found then
    select a.request_fingerprint,a.ack_entity_id,a.ack_version,a.ack_sequence
      into v_existing,task_id,task_version,change_sequence
      from public.team_accepted_operations a
      where a.organization_id = p_organization_id and a.operation_id = p_operation_id;
    if v_existing is distinct from v_fingerprint then
      raise exception 'OPERATION_ID_REUSED' using errcode = '40001'; end if;
    if task_id is null then raise exception 'ACCEPTED_OPERATION_EVENT_MISSING' using errcode = '55000'; end if;
    was_duplicate := true;
    return next;
    return;
  end if;

  select * into v_task from public.team_tasks
    where workspace_id = p_workspace_id and external_id = p_external_id for update;
  if not found then
    if p_base_version <> 0 then raise exception 'VERSION_CONFLICT' using errcode = '40001'; end if;
    if not (p_patch ? 'title') then raise exception 'TASK_TITLE_REQUIRED' using errcode = '22023'; end if;
    insert into public.team_tasks
      (workspace_id,external_id,project_key,title,description,status,revision_set,created_by)
    values (p_workspace_id,p_external_id,p_project_key,p_patch->>'title',
      coalesce(p_patch->>'description',''),coalesce(p_patch->>'status','open'),
      coalesce(p_patch->'revisionSet','[]'::jsonb),v_actor)
    returning * into v_task;
    v_created := true;
  else
    if v_task.version <> p_base_version then raise exception 'VERSION_CONFLICT' using errcode = '40001'; end if;
    if p_project_key is not null and v_task.project_key is not null and v_task.project_key <> p_project_key
    then raise exception 'TASK_PROJECT_CONFLICT' using errcode = '40001'; end if;
    update public.team_tasks set
      project_key = coalesce(project_key,p_project_key),
      title = case when p_patch ? 'title' then p_patch->>'title' else title end,
      description = case when p_patch ? 'description' then p_patch->>'description' else description end,
      status = case when p_patch ? 'status' then p_patch->>'status' else status end,
      revision_set = case when p_patch ? 'revisionSet' then p_patch->'revisionSet' else revision_set end,
      version = version + 1, updated_at = now()
    where id = v_task.id returning * into v_task;
  end if;

  insert into public.team_change_events
    (organization_id,workspace_id,operation_id,entity_type,entity_id,event_type,payload)
  values (p_organization_id,p_workspace_id,p_operation_id,'task',v_task.id,
    case when v_created then 'created' else 'updated' end,
    jsonb_build_object('id',v_task.id,'workspaceId',v_task.workspace_id,'projectKey',v_task.project_key,
      'externalId',v_task.external_id,'title',v_task.title,'description',v_task.description,
      'status',v_task.status,'ownerId',v_task.owner_id,'revisionSet',v_task.revision_set,
      'scope',v_task.scope,'dependencies',v_task.dependencies,'provenance',v_task.provenance,
      'version',v_task.version,'updatedAt',v_task.updated_at))
  returning sequence into v_sequence;
  update public.team_accepted_operations set ack_entity_type = 'task',
    ack_entity_id = v_task.id, ack_version = v_task.version, ack_sequence = v_sequence
    where organization_id = p_organization_id and operation_id = p_operation_id;
  task_id := v_task.id;
  task_version := v_task.version;
  change_sequence := v_sequence;
  was_duplicate := false;
  return next;
end;
$$;
revoke all on function public.apply_team_task_patch_operation(uuid,uuid,uuid,uuid,text,jsonb,bigint,text) from public, anon;
grant execute on function public.apply_team_task_patch_operation(uuid,uuid,uuid,uuid,text,jsonb,bigint,text) to authenticated;

commit;
