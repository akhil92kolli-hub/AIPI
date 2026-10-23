-- Daily bounded retention of the acknowledged, contiguous change-log prefix.
begin;
create extension if not exists pg_cron with schema extensions;

create function private.prune_team_change_events_daily()
returns integer language plpgsql security definer set search_path = '' as $$
declare
  v_org record;
  v_deleted integer;
  v_max bigint;
  v_total integer := 0;
  v_batch integer;
begin
  for v_org in select id from public.organizations loop
    -- An organization can drain at most 100,000 old events per run.
    for v_batch in 1..10 loop
      perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(v_org.id::text, 0));
      with ordered as (
        select e.sequence, pg_catalog.bool_and(
          e.created_at < now() - interval '30 days'
          and (e.operation_id is null or exists (
            select 1 from public.team_accepted_operations a
            where a.organization_id = v_org.id and a.operation_id = e.operation_id
              and a.ack_sequence = e.sequence
          ))) over (order by e.sequence rows unbounded preceding) as can_delete
        from (select * from public.team_change_events
          where organization_id = v_org.id order by sequence limit 10000) e
      ), removed as (
        delete from public.team_change_events e where e.organization_id = v_org.id
          and e.sequence in (select sequence from ordered where can_delete)
        returning e.sequence
      ) select count(*)::integer, coalesce(max(sequence), 0)
        into v_deleted, v_max from removed;
      if v_deleted = 0 then exit; end if;
      insert into public.team_sync_floors (organization_id, floor_sequence)
        values (v_org.id, v_max)
      on conflict (organization_id) do update
        set floor_sequence = greatest(public.team_sync_floors.floor_sequence, excluded.floor_sequence),
            updated_at = now();
      v_total := v_total + v_deleted;
    end loop;
  end loop;
  return v_total;
end;
$$;
revoke all on function private.prune_team_change_events_daily() from public, anon, authenticated;
select cron.schedule('aipi-team-change-retention', '15 3 * * *',
  'select private.prune_team_change_events_daily()');
commit;
