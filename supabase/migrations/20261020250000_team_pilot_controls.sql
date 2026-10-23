-- Pilot entitlements, bounded usage, and explicit source-sharing policy.
begin;
create table public.team_entitlements (
  organization_id uuid primary key references public.organizations(id) on delete cascade,
  plan text not null default 'trial' check (plan in ('trial','team','enterprise')),
  seat_limit integer not null default 5 check (seat_limit between 1 and 10000),
  monthly_event_limit integer not null default 10000 check (monthly_event_limit between 100 and 100000000),
  expires_at timestamptz,
  updated_at timestamptz not null default now()
);
create table public.team_usage_months (
  organization_id uuid not null references public.organizations(id) on delete cascade,
  month_start date not null,
  accepted_events integer not null default 0 check (accepted_events >= 0),
  updated_at timestamptz not null default now(),
  primary key (organization_id, month_start)
);
create table public.team_source_policies (
  organization_id uuid primary key references public.organizations(id) on delete cascade,
  sharing_mode text not null default 'metadata_only'
    check (sharing_mode in ('metadata_only','snippets','full_source')),
  updated_by uuid references auth.users(id) on delete set null,
  updated_at timestamptz not null default now()
);
insert into public.team_entitlements(organization_id, expires_at)
  select id, now() + interval '14 days' from public.organizations on conflict do nothing;
insert into public.team_source_policies(organization_id)
  select id from public.organizations on conflict do nothing;

create function private.initialize_team_pilot_controls()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  insert into public.team_entitlements (organization_id, expires_at)
    values (new.id, now() + interval '14 days');
  insert into public.team_source_policies (organization_id) values (new.id);
  return new;
end;
$$;
revoke all on function private.initialize_team_pilot_controls() from public, anon, authenticated;
create trigger initialize_team_pilot_controls after insert on public.organizations
  for each row execute function private.initialize_team_pilot_controls();

create function private.enforce_team_seat_limit()
returns trigger language plpgsql security definer set search_path = '' as $$
declare v_limit integer; v_count integer;
begin
  if new.role = 'owner' then return new; end if;
  select seat_limit into v_limit from public.team_entitlements
    where organization_id = new.organization_id for update;
  if v_limit is null then raise exception 'TEAM_ENTITLEMENT_MISSING' using errcode = '42501'; end if;
  select count(*) into v_count from public.organization_memberships
    where organization_id = new.organization_id;
  if v_count >= v_limit then raise exception 'TEAM_SEAT_LIMIT' using errcode = '23514'; end if;
  return new;
end;
$$;
revoke all on function private.enforce_team_seat_limit() from public, anon, authenticated;
create trigger enforce_team_seat_limit before insert on public.organization_memberships
  for each row execute function private.enforce_team_seat_limit();

create function private.consume_team_event_budget()
returns trigger language plpgsql security definer set search_path = '' as $$
declare v_entitlement public.team_entitlements%rowtype; v_month date;
begin
  select * into v_entitlement from public.team_entitlements
    where organization_id = new.organization_id for update;
  if not found or (v_entitlement.expires_at is not null and v_entitlement.expires_at <= now()) then
    raise exception 'TEAM_PLAN_EXPIRED' using errcode = '42501'; end if;
  v_month := date_trunc('month', now() at time zone 'UTC')::date;
  insert into public.team_usage_months (organization_id, month_start, accepted_events)
    values (new.organization_id, v_month, 1)
    on conflict (organization_id, month_start) do update
      set accepted_events = public.team_usage_months.accepted_events + 1,
          updated_at = now();
  if (select accepted_events from public.team_usage_months
    where organization_id = new.organization_id and month_start = v_month)
    > v_entitlement.monthly_event_limit then
    raise exception 'TEAM_USAGE_LIMIT' using errcode = '23514'; end if;
  return new;
end;
$$;
revoke all on function private.consume_team_event_budget() from public, anon, authenticated;
create trigger consume_team_event_budget before insert on public.team_change_events
  for each row execute function private.consume_team_event_budget();

create function private.enforce_team_source_policy()
returns trigger language plpgsql security definer set search_path = '' as $$
declare v_mode text; v_org uuid;
begin
  select organization_id into v_org from public.team_workspaces where id = new.workspace_id;
  select sharing_mode into v_mode from public.team_source_policies where organization_id = v_org;
  if v_mode is null then raise exception 'SOURCE_POLICY_MISSING' using errcode = '42501'; end if;
  if v_mode = 'metadata_only' then
    if exists (select 1 from jsonb_object_keys(new.payload) key
      where key not in ('summary','status','metrics','digest'))
      or char_length(coalesce(new.payload ->> 'summary','')) > 1000
      or (new.payload ? 'metrics' and jsonb_typeof(new.payload -> 'metrics') <> 'object')
      or char_length(new.payload::text) > 4000 then
      raise exception 'SOURCE_SHARING_POLICY_DENIED' using errcode = '42501'; end if;
  elsif v_mode = 'snippets' then
    if char_length(coalesce(new.payload ->> 'snippet','')) > 4000 then
      raise exception 'SOURCE_SNIPPET_TOO_LARGE' using errcode = '22023'; end if;
  end if;
  return new;
end;
$$;
revoke all on function private.enforce_team_source_policy() from public, anon, authenticated;
create trigger enforce_team_source_policy before insert on public.team_evidence
  for each row execute function private.enforce_team_source_policy();

alter table public.team_entitlements enable row level security;
alter table public.team_usage_months enable row level security;
alter table public.team_source_policies enable row level security;
create policy "members read team entitlements" on public.team_entitlements for select to authenticated
  using (private.organization_role_for(organization_id) is not null);
create policy "members read team usage" on public.team_usage_months for select to authenticated
  using (private.organization_role_for(organization_id) is not null);
create policy "members read source policy" on public.team_source_policies for select to authenticated
  using (private.organization_role_for(organization_id) is not null);
create policy "owners update source policy" on public.team_source_policies for update to authenticated
  using (private.organization_role_for(organization_id) in ('owner','admin'))
  with check (private.organization_role_for(organization_id) in ('owner','admin') and updated_by = auth.uid());
grant select on public.team_entitlements, public.team_usage_months, public.team_source_policies to authenticated;
grant update (sharing_mode, updated_by, updated_at) on public.team_source_policies to authenticated;
commit;
