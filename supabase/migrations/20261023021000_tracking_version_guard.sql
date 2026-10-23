begin;
create or replace function public.save_team_source(p_actor_id uuid,p_workspace_id uuid,p_project_key text,p_source_id text,p_name text,p_kind text,
 p_provider_repository_id text,p_repository text,p_remote_url text,p_repository_root text,p_external_endpoint text,p_expected_version bigint,
 p_tracking_branch text,p_tracking_commit text) returns jsonb language plpgsql set search_path='' as $$
declare v_source public.team_source_bindings%rowtype;v_result jsonb;v_primary text;
begin
 if current_user<>'service_role' then raise exception 'SOURCE_BROKER_REQUIRED' using errcode='42501';end if;
 perform 1 from public.team_workspaces where id=p_workspace_id for update;
 if not exists(select 1 from public.team_workspace_memberships w join public.team_workspaces ws on ws.id=w.workspace_id
  join public.organization_memberships o on o.organization_id=ws.organization_id and o.user_id=w.user_id
  where w.workspace_id=p_workspace_id and w.user_id=p_actor_id and w.role in('owner','admin','developer') and o.role in('owner','admin','developer'))
 then raise exception 'SOURCE_WRITE_DENIED' using errcode='42501';end if;
 select * into v_source from public.team_source_bindings where workspace_id=p_workspace_id and source_id=p_source_id;
 if found and (v_source.project_key<>p_project_key or v_source.superseded_by is not null) then raise exception 'SOURCE_IDENTITY_CONFLICT' using errcode='40001';end if;
 -- Exact retries are acknowledged without advancing versions or creating rows.
 if found and v_source.name=p_name and v_source.kind=p_kind and v_source.provider_repository_id is not distinct from p_provider_repository_id
  and v_source.repository_root=coalesce(p_repository_root,'.') and v_source.external_endpoint is not distinct from p_external_endpoint
  and v_source.tracking_branch is not distinct from p_tracking_branch and v_source.tracking_commit is not distinct from p_tracking_commit then return to_jsonb(v_source);end if;
 if p_expected_version is not null and (v_source.source_id is null or v_source.version<>p_expected_version) then raise exception 'SOURCE_VERSION_CONFLICT' using errcode='40001';end if;
 v_primary='src_'||substr(md5('aipi:primary:'||p_project_key),1,24);
 if p_source_id=v_primary then
  if p_kind='repository' then
   v_result=public.bind_team_repository_project(p_actor_id,p_workspace_id,p_project_key,p_provider_repository_id,p_repository,p_remote_url,p_repository_root);
  elsif v_source.kind='repository' then raise exception 'SOURCE_IDENTITY_CONFLICT' using errcode='40001';
  end if;
  update public.team_source_bindings set name=p_name,kind=p_kind,external_endpoint=p_external_endpoint,version=version+1
   where workspace_id=p_workspace_id and source_id=p_source_id returning * into v_source;
  if not found then raise exception 'PROJECT_UNAVAILABLE' using errcode='23503';end if;
 else
  v_result=public.bind_team_project_source(p_actor_id,p_workspace_id,p_project_key,p_source_id,p_name,p_kind,p_provider_repository_id,
   p_repository,p_remote_url,p_repository_root,p_external_endpoint,p_expected_version);
  select * into v_source from public.team_source_bindings where workspace_id=p_workspace_id and source_id=v_result->>'source_id';
 end if;
 -- A repeated request for the same repository must not retarget an existing branch silently.
 if v_source.source_id<>p_source_id and v_source.tracking_branch is not null and v_source.tracking_branch is distinct from p_tracking_branch then
  raise exception 'SOURCE_ALREADY_CONNECTED_SELECT_EXISTING' using errcode='40001';end if;
 update public.team_source_bindings set version=version+case when tracking_branch is distinct from p_tracking_branch or tracking_commit is distinct from p_tracking_commit then 1 else 0 end,tracking_branch=p_tracking_branch,tracking_commit=p_tracking_commit
  where workspace_id=p_workspace_id and source_id=v_source.source_id returning * into v_source;
 return to_jsonb(v_source);
end $$;
commit;
