begin;
alter table public.team_source_bindings add column superseded_by text;
alter table public.team_source_bindings add column tracking_branch text check(char_length(tracking_branch) between 1 and 240);
alter table public.team_source_bindings add column tracking_commit text check(tracking_commit ~ '^[a-f0-9]{40}$');
alter table public.team_source_bindings add constraint source_alias_target foreign key(workspace_id,superseded_by)
 references public.team_source_bindings(workspace_id,source_id) deferrable initially deferred;
alter table public.team_source_bindings add constraint source_alias_not_self check(superseded_by is distinct from source_id);
-- Keep historical IDs. Only equivalent repository+directory declarations merge.
with ranked as (
 select workspace_id,source_id,first_value(source_id) over(partition by workspace_id,project_key,provider_repository_id,repository_root
 order by (source_id='src_'||substr(md5('aipi:primary:'||project_key),1,24)) desc,source_id) canonical
 from public.team_source_bindings where kind='repository'
) update public.team_source_bindings s set superseded_by=r.canonical from ranked r
 where s.workspace_id=r.workspace_id and s.source_id=r.source_id and r.source_id<>r.canonical;
set constraints all immediate;
create unique index source_repository_directory_unique on public.team_source_bindings(workspace_id,project_key,provider_repository_id,repository_root)
 where kind='repository' and superseded_by is null;
create or replace function public.bind_team_project_source(p_actor_id uuid,p_workspace_id uuid,p_project_key text,p_source_id text,p_name text,p_kind text,
 p_provider_repository_id text,p_repository text,p_remote_url text,p_repository_root text,p_external_endpoint text,p_expected_version bigint)
 returns jsonb language plpgsql set search_path='' as $$
declare v_org uuid; v_workspace_role text; v_org_role text; v_existing public.team_source_bindings%rowtype; v_source public.team_source_bindings%rowtype; v_duplicate public.team_source_bindings%rowtype;
begin
 if current_user<>'service_role' then raise exception 'SOURCE_BROKER_REQUIRED' using errcode='42501';end if;
 select organization_id into v_org from public.team_workspaces where id=p_workspace_id for update;
 select role into v_workspace_role from public.team_workspace_memberships where workspace_id=p_workspace_id and user_id=p_actor_id for share;
 select role into v_org_role from public.organization_memberships where organization_id=v_org and user_id=p_actor_id for share;
 if v_workspace_role is null or v_org_role is null or v_workspace_role not in('owner','admin','developer') or v_org_role not in('owner','admin','developer') then
  raise exception 'SOURCE_WRITE_DENIED' using errcode='42501';end if;
 if p_kind='repository' then
  select * into v_duplicate from public.team_source_bindings where workspace_id=p_workspace_id and project_key=p_project_key
   and provider_repository_id=p_provider_repository_id and repository_root=p_repository_root and superseded_by is null;
  if found and v_duplicate.source_id<>p_source_id then
   return to_jsonb(v_duplicate);
  end if;
 end if;
 select * into v_existing from public.team_source_bindings where workspace_id=p_workspace_id and source_id=p_source_id for update;
 if found then
  if v_existing.superseded_by is not null then raise exception 'SOURCE_SUPERSEDED' using errcode='40001';end if;
  if v_existing.project_key<>p_project_key or p_expected_version is distinct from v_existing.version or
    (v_existing.provider_repository_id is not null and (v_existing.provider_repository_id is distinct from p_provider_repository_id or v_existing.repository_root is distinct from p_repository_root)) then
   raise exception 'SOURCE_IDENTITY_CONFLICT' using errcode='40001';end if;
 elsif p_expected_version is not null then raise exception 'SOURCE_VERSION_CONFLICT' using errcode='40001';end if;
 if p_source_id='src_'||substr(md5('aipi:primary:'||p_project_key),1,24) then
  raise exception 'USE_PRIMARY_PROJECT_BINDING_API' using errcode='40001';end if;
 if p_kind='repository' then
  insert into public.team_workspace_repositories(workspace_id,provider_repository_id,repository,remote_url)
   values(p_workspace_id,p_provider_repository_id,p_repository,p_remote_url)
   on conflict(workspace_id,provider_repository_id) do update set repository=excluded.repository,remote_url=excluded.remote_url;
 end if;
 insert into public.team_source_bindings(workspace_id,project_key,source_id,name,kind,provider_repository_id,repository_root,external_endpoint)
 values(p_workspace_id,p_project_key,p_source_id,p_name,p_kind,p_provider_repository_id,coalesce(p_repository_root,'.'),p_external_endpoint)
 on conflict(workspace_id,source_id) do update set name=excluded.name,kind=excluded.kind,provider_repository_id=excluded.provider_repository_id,
 repository_root=excluded.repository_root,external_endpoint=excluded.external_endpoint,version=public.team_source_bindings.version+1 returning * into v_source;
 return to_jsonb(v_source);
end $$;

create or replace function private.mirror_primary_source() returns trigger language plpgsql security definer set search_path='' as $$
begin
  if new.provider_repository_id is not null then
    insert into public.team_workspace_repositories(workspace_id,provider_repository_id,repository,remote_url)
      values(new.workspace_id,new.provider_repository_id,new.repository,new.remote_url)
      on conflict(workspace_id,provider_repository_id) do update set repository=excluded.repository,remote_url=excluded.remote_url;
  end if;
  update public.team_source_bindings set superseded_by='src_'||substr(md5('aipi:primary:'||new.project_key),1,24)
    where workspace_id=new.workspace_id and project_key=new.project_key and provider_repository_id=new.provider_repository_id
    and repository_root=coalesce(new.repository_root,'.') and source_id<>'src_'||substr(md5('aipi:primary:'||new.project_key),1,24);
  insert into public.team_source_bindings(workspace_id,project_key,source_id,name,kind,provider_repository_id,repository_root,version)
    values(new.workspace_id,new.project_key,'src_'||substr(md5('aipi:primary:'||new.project_key),1,24),left(coalesce(new.repository,new.project_key),120),
      case when new.provider_repository_id is null then 'local' else 'repository' end,new.provider_repository_id,coalesce(new.repository_root,'.'),new.version)
    on conflict(workspace_id,source_id) do update set kind=excluded.kind,provider_repository_id=excluded.provider_repository_id,
      repository_root=excluded.repository_root,version=greatest(public.team_source_bindings.version+1,excluded.version),superseded_by=null;
  return new;
end $$;

-- Branch metadata and the source mutation commit atomically under the workspace lock.
create function public.save_team_source(p_actor_id uuid,p_workspace_id uuid,p_project_key text,p_source_id text,p_name text,p_kind text,
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
 update public.team_source_bindings set tracking_branch=p_tracking_branch,tracking_commit=p_tracking_commit
  where workspace_id=p_workspace_id and source_id=v_source.source_id returning * into v_source;
 return to_jsonb(v_source);
end $$;
revoke all on function public.save_team_source(uuid,uuid,text,text,text,text,text,text,text,text,text,bigint,text,text) from public,anon,authenticated;
grant execute on function public.save_team_source(uuid,uuid,text,text,text,text,text,text,text,text,text,bigint,text,text) to service_role;
commit;
