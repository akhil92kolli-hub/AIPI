begin;
-- Portable identities only. Device paths, checkout credentials and secrets
-- have no columns in these tables.
create table public.team_workspace_repositories (
  workspace_id uuid not null references public.team_workspaces(id) on delete cascade,
  provider_repository_id text not null check(provider_repository_id ~ '^[1-9][0-9]{0,29}$'),
  provider text not null default 'github' check(provider='github'),
  repository text not null check(char_length(repository) between 1 and 240),
  remote_url text not null check(remote_url ~ '^https://github[.]com/[^/]+/[^/]+$'),
  primary key(workspace_id,provider_repository_id)
);
create table public.team_source_bindings (
  workspace_id uuid not null,
  project_key text not null,
  source_id text not null check(source_id ~ '^src_[A-Za-z0-9_-]{8,100}$'),
  name text not null check(char_length(name) between 1 and 120),
  kind text not null check(kind in ('local','repository','external')),
  provider_repository_id text,
  repository_root text not null default '.' check(repository_root='.' or (repository_root ~ '^[A-Za-z0-9_.-]+(/[A-Za-z0-9_.-]+)*$' and repository_root !~ '(^|/)[.]{1,2}(/|$)')),
  external_endpoint text check(external_endpoint ~ '^https://[^/@?#]+([/][^?#]*)?$'),
  version bigint not null default 1 check(version>0),
  primary key(workspace_id,source_id),
  foreign key(workspace_id,project_key) references public.team_workspace_projects(workspace_id,project_key) on delete cascade,
  foreign key(workspace_id,provider_repository_id) references public.team_workspace_repositories(workspace_id,provider_repository_id),
  check((kind='repository')=(provider_repository_id is not null)),
  check((kind='external')=(external_endpoint is not null))
);
create index team_source_project_idx on public.team_source_bindings(workspace_id,project_key);
alter table public.team_source_bindings enable row level security;
alter table public.team_workspace_repositories enable row level security;
create policy source_identity_read on public.team_source_bindings for select to authenticated using(private.can_access_team_workspace(workspace_id));
create policy repository_identity_read on public.team_workspace_repositories for select to authenticated using(private.can_access_team_workspace(workspace_id));
grant select on public.team_source_bindings,public.team_workspace_repositories to authenticated;
grant all on public.team_source_bindings,public.team_workspace_repositories to service_role;

-- Preserve the existing project binding API as the primary-source adapter.
create function private.mirror_primary_source() returns trigger language plpgsql security definer set search_path='' as $$
begin
  if new.provider_repository_id is not null then
    insert into public.team_workspace_repositories(workspace_id,provider_repository_id,repository,remote_url)
      values(new.workspace_id,new.provider_repository_id,new.repository,new.remote_url)
      on conflict(workspace_id,provider_repository_id) do update set repository=excluded.repository,remote_url=excluded.remote_url;
  end if;
  insert into public.team_source_bindings(workspace_id,project_key,source_id,name,kind,provider_repository_id,repository_root,version)
    values(new.workspace_id,new.project_key,'src_'||substr(md5('aipi:primary:'||new.project_key),1,24),left(coalesce(new.repository,new.project_key),120),
      case when new.provider_repository_id is null then 'local' else 'repository' end,new.provider_repository_id,coalesce(new.repository_root,'.'),new.version)
    on conflict(workspace_id,source_id) do update set kind=excluded.kind,provider_repository_id=excluded.provider_repository_id,
      repository_root=excluded.repository_root,version=excluded.version;
  return new;
end $$;
revoke all on function private.mirror_primary_source() from public;
create trigger mirror_primary_source after insert or update on public.team_workspace_projects for each row execute function private.mirror_primary_source();
insert into public.team_workspace_repositories(workspace_id,provider_repository_id,repository,remote_url)
 select distinct on(workspace_id,provider_repository_id) workspace_id,provider_repository_id,repository,remote_url
 from public.team_workspace_projects where provider_repository_id is not null;
insert into public.team_source_bindings(workspace_id,project_key,source_id,name,kind,provider_repository_id,repository_root,version)
 select workspace_id,project_key,'src_'||substr(md5('aipi:primary:'||project_key),1,24),left(coalesce(repository,project_key),120),
 case when provider_repository_id is null then 'local' else 'repository' end,provider_repository_id,coalesce(repository_root,'.'),version
 from public.team_workspace_projects;

create function public.bind_team_project_source(p_actor_id uuid,p_workspace_id uuid,p_project_key text,p_source_id text,p_name text,p_kind text,
 p_provider_repository_id text,p_repository text,p_remote_url text,p_repository_root text,p_external_endpoint text,p_expected_version bigint)
 returns jsonb language plpgsql set search_path='' as $$
declare v_org uuid; v_workspace_role text; v_org_role text; v_existing public.team_source_bindings%rowtype; v_source public.team_source_bindings%rowtype;
begin
 if current_user<>'service_role' then raise exception 'SOURCE_BROKER_REQUIRED' using errcode='42501';end if;
 select organization_id into v_org from public.team_workspaces where id=p_workspace_id for update;
 select role into v_workspace_role from public.team_workspace_memberships where workspace_id=p_workspace_id and user_id=p_actor_id for share;
 select role into v_org_role from public.organization_memberships where organization_id=v_org and user_id=p_actor_id for share;
 if v_workspace_role is null or v_org_role is null or v_workspace_role not in('owner','admin','developer') or v_org_role not in('owner','admin','developer') then
  raise exception 'SOURCE_WRITE_DENIED' using errcode='42501';end if;
 select * into v_existing from public.team_source_bindings where workspace_id=p_workspace_id and source_id=p_source_id for update;
 if found then
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
revoke all on function public.bind_team_project_source(uuid,uuid,text,text,text,text,text,text,text,text,text,bigint) from public,anon,authenticated;
grant execute on function public.bind_team_project_source(uuid,uuid,text,text,text,text,text,text,text,text,text,bigint) to service_role;
commit;
