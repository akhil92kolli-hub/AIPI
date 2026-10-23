-- Serialize workspace-scoped writes with membership removal. A queued write
-- that acquires these row locks after revocation must fail; if it acquires
-- them first, revocation waits until the write commits.
begin;
-- The repository-binding broker runs as service_role and locks/updates the
-- project row. Grant its table operations explicitly for minimal deployments.
grant select,insert,update on public.team_workspace_projects to service_role;
create or replace function private.guard_team_workspace_scoped_write() returns trigger
language plpgsql security definer set search_path = '' as $$
declare v_actor uuid := (select auth.uid()); v_workspace_id uuid;
begin
  if v_actor is null then
    if (select auth.role()) = 'service_role' then
      if tg_op = 'DELETE' then return old; else return new; end if;
    end if;
    raise exception 'AUTH_REQUIRED' using errcode='28000';
  end if;
  v_workspace_id := case when tg_op = 'DELETE' then old.workspace_id else new.workspace_id end;
  perform 1 from public.team_workspace_memberships wm
    join public.team_workspaces w on w.id = wm.workspace_id
    join public.organization_memberships om on om.organization_id = w.organization_id
      and om.user_id = wm.user_id
    where wm.workspace_id = v_workspace_id and wm.user_id = v_actor
      and wm.role in ('owner','admin','developer')
      and om.role in ('owner','admin','developer')
    for share of wm,w,om;
  if not found then raise exception 'WORKSPACE_WRITE_DENIED' using errcode='42501'; end if;
  if tg_op = 'UPDATE' and old.workspace_id is distinct from new.workspace_id then
    perform 1 from public.team_workspace_memberships wm
      join public.team_workspaces w on w.id = wm.workspace_id
      join public.organization_memberships om on om.organization_id = w.organization_id
        and om.user_id = wm.user_id
      where wm.workspace_id = old.workspace_id and wm.user_id = v_actor
        and wm.role in ('owner','admin','developer')
        and om.role in ('owner','admin','developer')
      for share of wm,w,om;
    if not found then raise exception 'WORKSPACE_WRITE_DENIED' using errcode='42501'; end if;
  end if;
  if tg_op = 'DELETE' then return old; else return new; end if;
end;
$$;
revoke all on function private.guard_team_workspace_scoped_write() from public,anon,authenticated;
commit;
