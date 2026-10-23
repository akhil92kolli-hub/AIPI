-- Direct PostgREST access must preserve attribution and revocation semantics.
begin;

create or replace function private.guard_team_workspace_identity()
returns trigger language plpgsql security invoker set search_path = '' as $$
begin
  if new.id is distinct from old.id or new.organization_id is distinct from old.organization_id
     or new.created_by is distinct from old.created_by then
    raise exception 'Team workspace identity is immutable';
  end if;
  return new;
end;
$$;
revoke all on function private.guard_team_workspace_identity() from public, anon, authenticated;
create trigger guard_team_workspace_identity before update on public.team_workspaces
for each row execute function private.guard_team_workspace_identity();

create or replace function private.guard_team_task_identity()
returns trigger language plpgsql security invoker set search_path = '' as $$
declare v_organization_id uuid;
begin
  if tg_op = 'UPDATE' and (new.id is distinct from old.id or new.workspace_id is distinct from old.workspace_id
      or new.external_id is distinct from old.external_id or new.created_by is distinct from old.created_by) then
    raise exception 'Team task identity is immutable';
  end if;
  if new.owner_id is not null then
    select organization_id into v_organization_id from public.team_workspaces where id = new.workspace_id;
    if not exists (select 1 from public.organization_memberships
                   where organization_id = v_organization_id and user_id = new.owner_id) then
      raise exception 'Task owner must be a workspace organization member';
    end if;
  end if;
  return new;
end;
$$;
revoke all on function private.guard_team_task_identity() from public, anon, authenticated;
create trigger guard_team_task_identity before insert or update on public.team_tasks
for each row execute function private.guard_team_task_identity();

create or replace function private.guard_team_device_identity()
returns trigger language plpgsql security invoker set search_path = '' as $$
begin
  if new.id is distinct from old.id or new.organization_id is distinct from old.organization_id
     or new.user_id is distinct from old.user_id or
     (old.revoked_at is not null and new.revoked_at is distinct from old.revoked_at) then
    raise exception 'Team device identity and revocation are immutable';
  end if;
  return new;
end;
$$;
revoke all on function private.guard_team_device_identity() from public, anon, authenticated;
create trigger guard_team_device_identity before update on public.team_devices
for each row execute function private.guard_team_device_identity();

drop policy "developers write team tasks" on public.team_tasks;
create policy "developers create own team tasks" on public.team_tasks for insert to authenticated
  with check (private.can_write_team_workspace(workspace_id) and created_by = (select auth.uid()));
create policy "developers update team tasks" on public.team_tasks for update to authenticated
  using (private.can_write_team_workspace(workspace_id))
  with check (private.can_write_team_workspace(workspace_id));
revoke delete on public.team_tasks from authenticated;

drop policy "developers write team decisions" on public.team_decisions;
create policy "developers create own team decisions" on public.team_decisions for insert to authenticated
  with check (private.can_write_team_workspace(workspace_id) and created_by = (select auth.uid()));
revoke update, delete on public.team_decisions from authenticated;

drop policy "developers write team evidence" on public.team_evidence;
create policy "developers create own team evidence" on public.team_evidence for insert to authenticated
  with check (private.can_write_team_workspace(workspace_id) and created_by = (select auth.uid()));
revoke update, delete on public.team_evidence from authenticated;

drop policy "users manage own team devices" on public.team_devices;
create policy "users read own team devices" on public.team_devices for select to authenticated
  using (user_id = (select auth.uid()) and private.organization_role_for(organization_id) is not null);
create policy "users register own team devices" on public.team_devices for insert to authenticated
  with check (user_id = (select auth.uid()) and revoked_at is null and private.organization_role_for(organization_id) is not null);
create policy "users update own team devices" on public.team_devices for update to authenticated
  using (user_id = (select auth.uid()) and private.organization_role_for(organization_id) is not null)
  with check (user_id = (select auth.uid()) and private.organization_role_for(organization_id) is not null);
revoke delete on public.team_devices from authenticated;

commit;
