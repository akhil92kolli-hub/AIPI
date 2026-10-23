begin;
create function private.wake_workspace_source_sync() returns trigger language plpgsql security definer set search_path='' as $$
begin
 update public.team_workspaces set version=version+1,updated_at=now() where id=coalesce(new.workspace_id,old.workspace_id);
 return null;
end $$;
revoke all on function private.wake_workspace_source_sync() from public;
create trigger wake_workspace_source_sync after insert or update or delete on public.team_source_bindings
 for each row execute function private.wake_workspace_source_sync();
commit;
