begin;
alter table public.team_workspace_projects add column display_name text check(char_length(display_name) between 1 and 120);
comment on column public.team_workspace_projects.display_name is 'Logical project name; independent of repository/source names and immutable project_key.';
commit;
