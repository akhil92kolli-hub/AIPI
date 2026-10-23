-- A local AIPI project belongs to a team workspace before GitHub is connected.
begin;

alter table public.team_workspace_projects
  alter column provider drop not null,
  alter column provider_repository_id drop not null,
  alter column repository drop not null,
  alter column remote_url drop not null;

alter table public.team_workspace_projects
  add constraint team_workspace_projects_repository_all_or_none check (
    (provider is null and provider_repository_id is null and repository is null and remote_url is null)
    or (provider is not null and provider_repository_id is not null and repository is not null and remote_url is not null)
  );

alter table public.team_workspace_projects
  alter column provider drop default;

commit;
