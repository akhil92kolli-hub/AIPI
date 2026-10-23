-- Repository bindings are authoritative only after the GitHub user and App
-- installation have both been checked by the service-role broker.
begin;
create function public.guard_team_project_repository_binding()
returns trigger language plpgsql set search_path = '' as $$
begin
  if current_user <> 'service_role' then
    if tg_op='DELETE' then
      if old.provider is not null then raise exception 'GITHUB_BINDING_BROKER_REQUIRED' using errcode='42501'; end if;
    elsif tg_op='INSERT' then
      if new.provider is not null then raise exception 'GITHUB_BINDING_BROKER_REQUIRED' using errcode='42501'; end if;
    else
      if old.provider is not null or new.provider is not null then
        raise exception 'GITHUB_BINDING_BROKER_REQUIRED' using errcode='42501'; end if;
    end if;
  end if;
  if tg_op = 'DELETE' then return old; else return new; end if;
end;
$$;
create trigger guard_team_project_repository_binding before insert or update or delete
  on public.team_workspace_projects for each row execute function public.guard_team_project_repository_binding();
revoke all on function public.guard_team_project_repository_binding() from public, anon, authenticated;
commit;
