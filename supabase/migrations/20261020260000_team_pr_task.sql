-- Bind a PR report to one task in the same workspace.
begin;
alter table public.team_pull_requests add column task_id uuid references public.team_tasks(id) on delete set null;
create index team_pull_requests_task_idx on public.team_pull_requests(task_id) where task_id is not null;
create function public.set_team_pr_task(p_pr_id uuid, p_task_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_pr public.team_pull_requests%rowtype;
begin
  select * into v_pr from public.team_pull_requests where id = p_pr_id for update;
  if not found or private.organization_role_for(v_pr.organization_id) not in ('owner','admin','developer') then
    raise exception 'PR_TASK_DENIED' using errcode = '42501'; end if;
  if p_task_id is not null and not exists (
    select 1 from public.team_tasks t where t.id = p_task_id and t.workspace_id = v_pr.workspace_id
  ) then raise exception 'PR_TASK_OUTSIDE_WORKSPACE' using errcode = '22023'; end if;
  update public.team_pull_requests set task_id = p_task_id, report_hash = null,
    updated_at = now() where id = p_pr_id;
  return jsonb_build_object('id',p_pr_id,'taskId',p_task_id);
end;
$$;
revoke all on function public.set_team_pr_task(uuid,uuid) from public, anon;
grant execute on function public.set_team_pr_task(uuid,uuid) to authenticated;
commit;
