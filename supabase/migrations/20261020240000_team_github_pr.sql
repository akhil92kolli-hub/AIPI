-- Verified GitHub deliveries, installation ownership, exact-head CI receipts and PR state.
begin;
create table public.team_github_installations (
  installation_id bigint primary key check (installation_id > 0),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  account_login text not null check (char_length(account_login) between 1 and 200),
  active boolean not null default true,
  connected_by uuid not null references auth.users(id) on delete restrict,
  connected_at timestamptz not null default now(),
  unique (organization_id, installation_id)
);
create table public.team_ci_producers (
  organization_id uuid not null references public.organizations(id) on delete cascade,
  app_id bigint not null check (app_id > 0),
  name text not null check (char_length(name) between 1 and 200),
  environment text not null check (char_length(environment) between 1 and 120),
  enabled boolean not null default true,
  configured_by uuid not null references auth.users(id) on delete restrict,
  primary key (organization_id, app_id, environment)
);
create table public.team_github_deliveries (
  delivery_id uuid primary key,
  organization_id uuid not null references public.organizations(id) on delete cascade,
  installation_id bigint not null references public.team_github_installations(installation_id),
  event text not null,
  received_at timestamptz not null default now()
);
create table public.team_pull_requests (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  workspace_id uuid not null references public.team_workspaces(id) on delete cascade,
  installation_id bigint not null references public.team_github_installations(installation_id),
  provider_repository_id text not null,
  repository text not null,
  number integer not null check (number > 0),
  title text not null,
  state text not null check (state in ('open','closed','merged')),
  head_sha text not null check (head_sha ~ '^[0-9a-f]{40}$'),
  base_sha text not null check (base_sha ~ '^[0-9a-f]{40}$'),
  changed_project_key text,
  changed_node_key text,
  revision_set jsonb not null default '[]'::jsonb check (jsonb_typeof(revision_set) = 'array'),
  report_hash text,
  comment_id bigint,
  updated_at timestamptz not null default now(),
  unique (workspace_id, provider_repository_id, number)
);
create index team_pull_requests_org_repo_idx on public.team_pull_requests (organization_id, provider_repository_id, number);
create table public.team_ci_receipts (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  provider_repository_id text not null,
  check_run_id bigint not null,
  producer_app_id bigint not null,
  check_name text not null,
  environment text not null,
  head_sha text not null check (head_sha ~ '^[0-9a-f]{40}$'),
  conclusion text not null check (conclusion in ('success','failure','cancelled','timed_out','neutral','skipped','action_required')),
  source_url text not null,
  observed_at timestamptz not null default now(),
  unique (organization_id, provider_repository_id, check_run_id)
);
create index team_ci_receipts_exact_head_idx on public.team_ci_receipts (organization_id, provider_repository_id, head_sha);

alter table public.team_github_installations enable row level security;
alter table public.team_ci_producers enable row level security;
alter table public.team_github_deliveries enable row level security;
alter table public.team_pull_requests enable row level security;
alter table public.team_ci_receipts enable row level security;
create policy "members read github installations" on public.team_github_installations for select to authenticated
  using (private.organization_role_for(organization_id) is not null);
create policy "owners manage github installations" on public.team_github_installations for all to authenticated
  using (private.organization_role_for(organization_id) in ('owner','admin'))
  with check (private.organization_role_for(organization_id) in ('owner','admin') and connected_by = auth.uid());
create policy "members read ci producers" on public.team_ci_producers for select to authenticated
  using (private.organization_role_for(organization_id) is not null);
create policy "owners manage ci producers" on public.team_ci_producers for all to authenticated
  using (private.organization_role_for(organization_id) in ('owner','admin'))
  with check (private.organization_role_for(organization_id) in ('owner','admin') and configured_by = auth.uid());
create policy "members read pr state" on public.team_pull_requests for select to authenticated
  using (private.organization_role_for(organization_id) is not null and private.can_access_team_workspace(workspace_id));
create policy "members read ci receipts" on public.team_ci_receipts for select to authenticated
  using (private.organization_role_for(organization_id) is not null);
grant select, insert, update, delete on public.team_github_installations, public.team_ci_producers to authenticated;
grant select on public.team_pull_requests to authenticated;
grant select on public.team_ci_receipts to authenticated;

create function public.set_team_pr_target(
  p_pr_id uuid, p_changed_project_key text, p_changed_node_key text, p_revision_set jsonb
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_pr public.team_pull_requests%rowtype;
begin
  select * into v_pr from public.team_pull_requests where id = p_pr_id for update;
  if not found or private.organization_role_for(v_pr.organization_id) not in ('owner','admin','developer') then
    raise exception 'PR_TARGET_DENIED' using errcode = '42501'; end if;
  if p_changed_project_key !~ '^prj_[A-Za-z0-9_-]{4,100}$'
    or char_length(p_changed_node_key) not between 1 and 500
    or jsonb_typeof(p_revision_set) <> 'array'
    or jsonb_array_length(p_revision_set) not between 1 and 32
    or not exists (select 1 from public.team_workspace_projects p
      where p.workspace_id = v_pr.workspace_id and p.project_key = p_changed_project_key
        and p.provider_repository_id = v_pr.provider_repository_id) then
    raise exception 'INVALID_PR_TARGET' using errcode = '22023'; end if;
  update public.team_pull_requests set changed_project_key = p_changed_project_key,
    changed_node_key = p_changed_node_key, revision_set = p_revision_set,
    report_hash = null, updated_at = now() where id = p_pr_id;
  return jsonb_build_object('id', p_pr_id, 'changedProjectKey', p_changed_project_key,
    'changedNodeKey', p_changed_node_key);
end;
$$;
revoke all on function public.set_team_pr_target(uuid,text,text,jsonb) from public, anon;
grant execute on function public.set_team_pr_target(uuid,text,text,jsonb) to authenticated;

create function public.apply_team_github_webhook(p_delivery_id uuid, p_event text, p_payload jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_installation bigint := nullif(p_payload #>> '{installation,id}','')::bigint;
  v_repository_id text := p_payload #>> '{repository,id}';
  v_organization_id uuid;
  v_project record;
  v_action text := p_payload ->> 'action';
  v_pr jsonb := p_payload -> 'pull_request';
  v_check jsonb := p_payload -> 'check_run';
  v_app_id bigint;
  v_rows integer := 0;
begin
  select organization_id into v_organization_id from public.team_github_installations
    where installation_id = v_installation and active;
  if v_organization_id is null then raise exception 'GITHUB_INSTALLATION_UNBOUND' using errcode = '42501'; end if;
  if v_repository_id !~ '^[1-9][0-9]{0,29}$' then
    raise exception 'GITHUB_REPOSITORY_ID_REQUIRED' using errcode = '22023'; end if;
  insert into public.team_github_deliveries (delivery_id, organization_id, installation_id, event)
    values (p_delivery_id, v_organization_id, v_installation, p_event)
    on conflict (delivery_id) do nothing;
  if not found then return jsonb_build_object('duplicate',true,'processed',0); end if;
  if p_event = 'pull_request' and v_pr is not null and
    v_action in ('opened','reopened','synchronize','edited','closed') then
    for v_project in select p.workspace_id, p.project_key from public.team_workspace_projects p
      join public.team_workspaces w on w.id = p.workspace_id
      where w.organization_id = v_organization_id and p.provider_repository_id = v_repository_id loop
      insert into public.team_pull_requests
        (organization_id, workspace_id, installation_id, provider_repository_id,
         repository, number, title, state, head_sha, base_sha)
      values (v_organization_id, v_project.workspace_id, v_installation, v_repository_id,
        p_payload #>> '{repository,full_name}', (p_payload ->> 'number')::integer,
        v_pr ->> 'title', case when v_pr ->> 'merged' = 'true' then 'merged'
          when v_pr ->> 'state' = 'closed' then 'closed' else 'open' end,
        v_pr #>> '{head,sha}', v_pr #>> '{base,sha}')
      on conflict (workspace_id, provider_repository_id, number) do update
        set title = excluded.title, state = excluded.state, head_sha = excluded.head_sha,
          base_sha = excluded.base_sha, updated_at = now();
      v_rows := v_rows + 1;
    end loop;
  elsif p_event = 'check_run' and v_action = 'completed' and v_check is not null then
    v_app_id := nullif(v_check #>> '{app,id}','')::bigint;
    if exists (select 1 from public.team_ci_producers p where p.organization_id = v_organization_id
      and p.app_id = v_app_id and p.environment = 'ci' and p.enabled) then
      insert into public.team_ci_receipts
        (organization_id, provider_repository_id, check_run_id, producer_app_id,
         check_name, environment, head_sha, conclusion, source_url)
      values (v_organization_id, v_repository_id, (v_check ->> 'id')::bigint, v_app_id,
        v_check ->> 'name', 'ci', v_check ->> 'head_sha', v_check ->> 'conclusion',
        v_check ->> 'html_url')
      on conflict (organization_id, provider_repository_id, check_run_id) do update
        set head_sha = excluded.head_sha, conclusion = excluded.conclusion,
          source_url = excluded.source_url, observed_at = now();
      v_rows := 1;
    end if;
  end if;
  return jsonb_build_object('duplicate',false,'processed',v_rows,
    'organizationId',v_organization_id);
end;
$$;
revoke all on function public.apply_team_github_webhook(uuid,text,jsonb) from public, anon, authenticated;
grant execute on function public.apply_team_github_webhook(uuid,text,jsonb) to service_role;
commit;
