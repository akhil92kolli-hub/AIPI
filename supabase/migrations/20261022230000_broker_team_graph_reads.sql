-- GitHub-bound graph source references must not be readable through direct
-- PostgREST table access: workspace membership cannot prove a live GitHub
-- user grant. The Team worker brokers bounded graph reads and rechecks grants.
begin;
revoke select on public.team_graph_nodes, public.team_graph_edges from authenticated;
grant select on public.team_graph_nodes, public.team_graph_edges to service_role;
grant select on public.team_ci_receipts, public.team_workspaces,
  public.team_workspace_memberships, public.organization_memberships,
  public.team_workspace_projects to service_role;
grant update on public.team_workspaces, public.team_workspace_memberships,
  public.organization_memberships to service_role;
commit;
