-- A workspace trial starts once, at workspace activation, and lasts three
-- calendar months in UTC. PostgreSQL month arithmetic clamps end-of-month
-- dates (January 31 -> April 30) while preserving the time of day.
begin;

create function private.team_trial_end(p_started_at timestamptz)
returns timestamptz language sql immutable strict set search_path = '' as $$
  select ((p_started_at at time zone 'UTC') + interval '3 months') at time zone 'UTC';
$$;
revoke all on function private.team_trial_end(timestamptz) from public, anon, authenticated;

alter table public.team_workspace_subscriptions
  add column trial_started_at timestamptz;

-- The earlier 14-day grant began when the workspace was created. Preserve
-- that activation time during upgrade rather than restarting the trial now.
update public.team_workspace_subscriptions as subscription
set trial_started_at = workspace.created_at,
    trial_ends_at = case when subscription.plan = 'trial'
      then private.team_trial_end(workspace.created_at)
      else subscription.trial_ends_at end
from public.team_workspaces as workspace
where workspace.id = subscription.workspace_id;

alter table public.team_workspace_subscriptions
  alter column trial_started_at set not null,
  alter column trial_started_at set default now();

create or replace function private.initialize_team_workspace_subscription()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  insert into public.team_workspace_subscriptions
    (workspace_id, organization_id, trial_started_at, trial_ends_at)
  values (new.id, new.organization_id, new.created_at,
    private.team_trial_end(new.created_at));
  return new;
end;
$$;
revoke all on function private.initialize_team_workspace_subscription() from public, anon, authenticated;

commit;
