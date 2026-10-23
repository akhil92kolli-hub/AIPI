begin;

-- The protected controller is the only writer. Repository contributors and
-- ordinary workspace members cannot assert what is serving production.
create table public.team_deployment_environments (
  workspace_id uuid not null references public.team_workspaces(id) on delete cascade,
  environment_id text not null check(environment_id ~ '^[A-Za-z0-9_-]{1,80}$'),
  generation bigint not null default 0 check(generation >= 0),
  observed_at timestamptz,
  primary key(workspace_id, environment_id)
);
create table public.team_deployment_cohorts (
  workspace_id uuid not null,
  environment_id text not null,
  cohort_id text not null check(cohort_id ~ '^[A-Za-z0-9_-]{1,80}$'),
  project_key text not null,
  source_id text not null,
  revision_commit text not null check(revision_commit ~ '^[0-9a-f]{40}$'),
  artifact_digest text not null check(artifact_digest ~ '^sha256:[0-9a-f]{64}$'),
  active boolean not null,
  generation bigint not null check(generation > 0),
  observed_at timestamptz not null,
  primary key(workspace_id, environment_id, cohort_id),
  foreign key(workspace_id, environment_id) references public.team_deployment_environments(workspace_id, environment_id) on delete cascade,
  foreign key(workspace_id, source_id, project_key) references public.team_source_bindings(workspace_id, source_id, project_key)
);
create index team_deployment_cohorts_active_idx on public.team_deployment_cohorts(workspace_id, environment_id, project_key) where active;
create table public.team_deployment_events (
  event_id uuid primary key,
  workspace_id uuid not null,
  environment_id text not null,
  expected_generation bigint not null,
  accepted_generation bigint not null,
  controller_id text not null check(char_length(controller_id) between 1 and 120),
  payload jsonb not null check(jsonb_typeof(payload) = 'object' and octet_length(payload::text) <= 4000),
  received_at timestamptz not null default now(),
  foreign key(workspace_id, environment_id) references public.team_deployment_environments(workspace_id, environment_id) on delete cascade
);
create index team_deployment_events_scope_idx on public.team_deployment_events(workspace_id, environment_id, accepted_generation);

alter table public.team_deployment_environments enable row level security;
alter table public.team_deployment_cohorts enable row level security;
alter table public.team_deployment_events enable row level security;
revoke all on public.team_deployment_environments, public.team_deployment_cohorts, public.team_deployment_events from public, anon, authenticated;
grant select, insert, update on public.team_deployment_environments, public.team_deployment_cohorts to service_role;
grant select, insert on public.team_deployment_events to service_role;

create function public.apply_team_deployment_event(
  p_event_id uuid, p_workspace_id uuid, p_environment_id text,
  p_expected_generation bigint, p_controller_id text, p_payload jsonb
) returns jsonb language plpgsql set search_path = '' as $$
declare
  v_existing public.team_deployment_events%rowtype;
  v_generation bigint;
  v_project text := p_payload ->> 'projectKey';
  v_source text := p_payload ->> 'sourceBindingId';
  v_cohort text := p_payload ->> 'cohortId';
  v_revision text := p_payload ->> 'revision';
  v_artifact text := p_payload ->> 'artifactDigest';
  v_active boolean;
begin
  if current_user <> 'service_role' then raise exception 'DEPLOYMENT_CONTROLLER_REQUIRED' using errcode='42501'; end if;
  if coalesce(p_environment_id,'') !~ '^[A-Za-z0-9_-]{1,80}$' or
     char_length(coalesce(p_controller_id,'')) not between 1 and 120 or
     p_expected_generation is null or p_expected_generation < 0 or
     coalesce(jsonb_typeof(p_payload),'') <> 'object' or octet_length(p_payload::text) > 4000 or
     coalesce(v_project,'') !~ '^prj_[A-Za-z0-9_-]{4,100}$' or coalesce(v_source,'') !~ '^src_[A-Za-z0-9_-]{8,100}$' or
     coalesce(v_cohort,'') !~ '^[A-Za-z0-9_-]{1,80}$' or coalesce(v_revision,'') !~ '^[0-9a-f]{40}$' or
     coalesce(v_artifact,'') !~ '^sha256:[0-9a-f]{64}$' or coalesce(jsonb_typeof(p_payload -> 'active'),'') <> 'boolean' then
    raise exception 'INVALID_DEPLOYMENT_EVENT' using errcode='22023';
  end if;
  v_active := (p_payload ->> 'active')::boolean;
  if not exists(select 1 from public.team_source_bindings s
    where s.workspace_id=p_workspace_id and s.project_key=v_project and s.source_id=v_source
      and s.superseded_by is null) then
    raise exception 'DEPLOYMENT_SOURCE_UNAVAILABLE' using errcode='42501';
  end if;
  insert into public.team_deployment_environments(workspace_id,environment_id)
    values(p_workspace_id,p_environment_id) on conflict do nothing;
  select generation into v_generation from public.team_deployment_environments
    where workspace_id=p_workspace_id and environment_id=p_environment_id for update;
  select * into v_existing from public.team_deployment_events where event_id=p_event_id;
  if found then
    if v_existing.workspace_id<>p_workspace_id or v_existing.environment_id<>p_environment_id or
       v_existing.expected_generation<>p_expected_generation or v_existing.controller_id<>p_controller_id or
       v_existing.payload<>p_payload then
      raise exception 'DEPLOYMENT_EVENT_ID_REUSED' using errcode='40001';
    end if;
    return jsonb_build_object('eventId',p_event_id,'generation',v_existing.accepted_generation,'duplicate',true);
  end if;
  if v_generation <> p_expected_generation then raise exception 'DEPLOYMENT_GENERATION_CHANGED' using errcode='40001'; end if;
  if not v_active and not exists(select 1 from public.team_deployment_cohorts c
    where c.workspace_id=p_workspace_id and c.environment_id=p_environment_id and c.cohort_id=v_cohort
      and c.project_key=v_project and c.source_id=v_source and c.active) then
    raise exception 'ACTIVE_DEPLOYMENT_COHORT_REQUIRED' using errcode='40001';
  end if;
  update public.team_deployment_environments set generation=generation+1, observed_at=now()
    where workspace_id=p_workspace_id and environment_id=p_environment_id;
  if v_active then
    insert into public.team_deployment_cohorts(workspace_id,environment_id,cohort_id,project_key,source_id,
      revision_commit,artifact_digest,active,generation,observed_at)
    values(p_workspace_id,p_environment_id,v_cohort,v_project,v_source,v_revision,v_artifact,true,v_generation+1,now())
    on conflict(workspace_id,environment_id,cohort_id) do update
      set project_key=excluded.project_key,source_id=excluded.source_id,revision_commit=excluded.revision_commit,
          artifact_digest=excluded.artifact_digest,active=true,generation=excluded.generation,observed_at=excluded.observed_at;
  else
    update public.team_deployment_cohorts set active=false,generation=v_generation+1,observed_at=now()
      where workspace_id=p_workspace_id and environment_id=p_environment_id and cohort_id=v_cohort;
  end if;
  insert into public.team_deployment_events(event_id,workspace_id,environment_id,expected_generation,
    accepted_generation,controller_id,payload)
    values(p_event_id,p_workspace_id,p_environment_id,p_expected_generation,v_generation+1,p_controller_id,p_payload);
  return jsonb_build_object('eventId',p_event_id,'generation',v_generation+1,'duplicate',false);
end $$;
revoke all on function public.apply_team_deployment_event(uuid,uuid,text,bigint,text,jsonb) from public,anon,authenticated;
grant execute on function public.apply_team_deployment_event(uuid,uuid,text,bigint,text,jsonb) to service_role;
commit;
