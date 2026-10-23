-- A repository root must stay inside its checkout. The initial team migration
-- allowed dot segments through its character check; reject them at the database.
alter table public.team_workspace_projects
  add constraint team_workspace_projects_root_no_dot_segments
  check (repository_root = '.' or repository_root !~ '(^|/)[.][.]?(/|$)');
