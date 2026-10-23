-- GitHub rights are checked by the Worker immediately before this call. The
-- final service-role write rechecks AIPI membership in the same transaction,
-- so a concurrent workspace removal cannot authorize a stale binding.
begin;

create or replace function public.bind_team_repository_project(
  p_actor_id uuid, p_workspace_id uuid, p_project_key text,
  p_provider_repository_id text, p_repository text,
  p_remote_url text, p_repository_root text
) returns jsonb language plpgsql set search_path = '' as $$
declare v_organization_id uuid;
  v_workspace_role text;
  v_organization_role text;
  v_existing_repository_id text;
  v_existing_root text;
  v_project public.team_workspace_projects%rowtype;
begin
  if current_user <> 'service_role' then
    raise exception 'PROJECT_BINDING_BROKER_REQUIRED' using errcode='42501';
  end if;
  select organization_id into v_organization_id from public.team_workspaces
    where id=p_workspace_id for update;
  if v_organization_id is null then
    raise exception 'WORKSPACE_UNAVAILABLE' using errcode='42501';
  end if;
  select role into v_workspace_role from public.team_workspace_memberships
    where workspace_id=p_workspace_id and user_id=p_actor_id for share;
  select role into v_organization_role from public.organization_memberships
    where organization_id=v_organization_id and user_id=p_actor_id for share;
  if v_workspace_role not in ('owner','admin','developer') or
     v_organization_role not in ('owner','admin','developer') or
     v_workspace_role is null or v_organization_role is null then
    raise exception 'WORKSPACE_WRITE_DENIED' using errcode='42501';
  end if;
  select provider_repository_id,repository_root into v_existing_repository_id,v_existing_root
    from public.team_workspace_projects
    where workspace_id=p_workspace_id and project_key=p_project_key for update;
  if v_existing_repository_id is not null and
     (v_existing_repository_id<>p_provider_repository_id or v_existing_root<>p_repository_root) then
    raise exception 'PROJECT_REPOSITORY_CONFLICT' using errcode='40001';
  end if;
  insert into public.team_workspace_projects
    (workspace_id,project_key,provider,provider_repository_id,
     repository,remote_url,repository_root)
  values (p_workspace_id,p_project_key,'github',p_provider_repository_id,
    p_repository,p_remote_url,p_repository_root)
  on conflict (workspace_id,project_key) do update set
    provider='github',provider_repository_id=excluded.provider_repository_id,
    repository=excluded.repository,remote_url=excluded.remote_url,
    repository_root=excluded.repository_root,updated_at=now(),
    version=public.team_workspace_projects.version+1
  returning * into v_project;
  return to_jsonb(v_project);
end;
$$;
revoke all on function public.bind_team_repository_project(uuid,uuid,text,text,text,text,text)
  from public,anon,authenticated;
grant execute on function public.bind_team_repository_project(uuid,uuid,text,text,text,text,text)
  to service_role;

commit;
