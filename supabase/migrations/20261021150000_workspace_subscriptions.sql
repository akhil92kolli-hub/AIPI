-- Each Team workspace owns its lifecycle and event budget. Billing-provider
-- changes are service-role only; an organization plan is no longer a grant.
begin;

create table public.team_workspace_subscriptions (
  workspace_id uuid primary key references public.team_workspaces(id) on delete cascade,
  organization_id uuid not null,
  plan text not null default 'trial' check (plan in ('trial','team','enterprise')),
  status text not null default 'trialing'
    check (status in ('trialing','active','grace','read_only','canceled')),
  seat_limit integer not null default 5 check (seat_limit between 1 and 10000),
  monthly_event_limit integer not null default 10000 check (monthly_event_limit between 100 and 100000000),
  trial_ends_at timestamptz,
  current_period_ends_at timestamptz,
  billing_reference text unique,
  updated_at timestamptz not null default now(),
  foreign key (organization_id, workspace_id)
    references public.team_workspaces(organization_id, id) on delete cascade
);
create table public.team_workspace_usage_months (
  workspace_id uuid not null references public.team_workspaces(id) on delete cascade,
  month_start date not null,
  accepted_events integer not null default 0 check (accepted_events >= 0),
  updated_at timestamptz not null default now(),
  primary key (workspace_id, month_start)
);

insert into public.team_workspace_subscriptions
  (workspace_id, organization_id, plan, status, seat_limit, monthly_event_limit, trial_ends_at)
select w.id, w.organization_id, coalesce(e.plan, 'trial'),
  case when e.expires_at is not null and e.expires_at <= now() then 'read_only'
       when e.plan = 'trial' or e.plan is null then 'trialing' else 'active' end,
  coalesce(e.seat_limit, 5), coalesce(e.monthly_event_limit, 10000),
  coalesce(e.expires_at, now() + interval '14 days')
from public.team_workspaces w
left join public.team_entitlements e on e.organization_id = w.organization_id;

insert into public.team_workspace_usage_months(workspace_id, month_start, accepted_events)
select workspace_id, date_trunc('month', created_at at time zone 'UTC')::date, count(*)::integer
from public.team_change_events where workspace_id is not null
group by workspace_id, date_trunc('month', created_at at time zone 'UTC')::date;

create function private.initialize_team_workspace_subscription()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  insert into public.team_workspace_subscriptions(workspace_id, organization_id, trial_ends_at)
  values (new.id, new.organization_id, now() + interval '14 days');
  return new;
end;
$$;
revoke all on function private.initialize_team_workspace_subscription() from public, anon, authenticated;
create trigger a_initialize_team_workspace_subscription after insert on public.team_workspaces
  for each row execute function private.initialize_team_workspace_subscription();

drop trigger consume_team_event_budget on public.team_change_events;
create function private.consume_team_workspace_event_budget()
returns trigger language plpgsql security definer set search_path = '' as $$
declare v_subscription public.team_workspace_subscriptions%rowtype; v_month date; v_used integer;
begin
  if new.workspace_id is null then return new; end if;
  select * into v_subscription from public.team_workspace_subscriptions
    where workspace_id = new.workspace_id for update;
  if not found or v_subscription.organization_id <> new.organization_id
    or v_subscription.status not in ('trialing','active')
    or (v_subscription.status = 'trialing' and
      (v_subscription.trial_ends_at is null or v_subscription.trial_ends_at <= now()))
    or (v_subscription.status = 'active' and v_subscription.current_period_ends_at is not null
      and v_subscription.current_period_ends_at <= now()) then
    raise exception 'TEAM_PLAN_EXPIRED' using errcode = '42501';
  end if;
  v_month := date_trunc('month', now() at time zone 'UTC')::date;
  insert into public.team_workspace_usage_months(workspace_id, month_start, accepted_events)
    values (new.workspace_id, v_month, 1)
    on conflict (workspace_id, month_start) do update
      set accepted_events = public.team_workspace_usage_months.accepted_events + 1, updated_at = now()
    returning accepted_events into v_used;
  if v_used > v_subscription.monthly_event_limit then
    raise exception 'TEAM_USAGE_LIMIT' using errcode = '23514';
  end if;
  return new;
end;
$$;
revoke all on function private.consume_team_workspace_event_budget() from public, anon, authenticated;
create trigger consume_team_workspace_event_budget before insert on public.team_change_events
  for each row execute function private.consume_team_workspace_event_budget();

alter table public.team_workspace_subscriptions enable row level security;
alter table public.team_workspace_usage_months enable row level security;
create policy "members read workspace subscriptions" on public.team_workspace_subscriptions
  for select to authenticated using (private.can_access_team_workspace(workspace_id));
create policy "members read workspace usage" on public.team_workspace_usage_months
  for select to authenticated using (private.can_access_team_workspace(workspace_id));
grant select on public.team_workspace_subscriptions, public.team_workspace_usage_months to authenticated;
revoke insert, update, delete on public.team_workspace_subscriptions, public.team_workspace_usage_months from authenticated;

commit;
