-- Keep references inside their parent organization and workspace, including
-- writes performed by service roles that bypass RLS.
begin;

alter table public.team_workspaces
  add constraint team_workspaces_organization_id_id_key unique (organization_id, id);
alter table public.team_tasks
  add constraint team_tasks_workspace_id_id_key unique (workspace_id, id);
alter table public.team_devices
  add constraint team_devices_organization_id_id_key unique (organization_id, id);

alter table public.team_decisions
  add constraint team_decisions_workspace_task_fkey
  foreign key (workspace_id, task_id) references public.team_tasks (workspace_id, id) on delete cascade;
alter table public.team_evidence
  add constraint team_evidence_workspace_task_fkey
  foreign key (workspace_id, task_id) references public.team_tasks (workspace_id, id) on delete cascade;
alter table public.team_accepted_operations
  add constraint team_accepted_operations_org_device_fkey
  foreign key (organization_id, device_id) references public.team_devices (organization_id, id) on delete cascade;
alter table public.team_change_events
  add constraint team_change_events_org_workspace_fkey
  foreign key (organization_id, workspace_id) references public.team_workspaces (organization_id, id) on delete cascade;

commit;
