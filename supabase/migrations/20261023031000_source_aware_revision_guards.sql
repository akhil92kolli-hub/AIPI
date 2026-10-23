-- New revision claims must resolve to the source they describe. Historical
-- rows are left intact; edits that retain their old revision set stay valid.
begin;

create function private.validate_team_revision_set(p_workspace_id uuid, p_revisions jsonb)
returns void language plpgsql security definer set search_path = '' as $$
declare
  v_revision jsonb;
  v_source_count integer;
begin
  if p_revisions is null or pg_catalog.jsonb_typeof(p_revisions) <> 'array' or
     pg_catalog.jsonb_array_length(p_revisions) > 32 then
    raise exception 'INVALID_REVISION_SET' using errcode = '22023';
  end if;
  for v_revision in select value from pg_catalog.jsonb_array_elements(p_revisions) loop
    if pg_catalog.jsonb_typeof(v_revision) <> 'object' or
       exists (select 1 from pg_catalog.jsonb_object_keys(v_revision) as field(key)
         where key not in ('projectKey', 'sourceBindingId', 'commit')) or
       coalesce(v_revision ->> 'projectKey', '') !~ '^prj_[A-Za-z0-9_-]{4,100}$' or
       coalesce(v_revision ->> 'commit', '') !~ '^[a-f0-9]{40}$' or
       not exists (select 1 from public.team_workspace_projects p
         where p.workspace_id = p_workspace_id and p.project_key = v_revision ->> 'projectKey') then
      raise exception 'INVALID_SOURCE_REVISION' using errcode = '22023';
    end if;
    if v_revision ? 'sourceBindingId' then
      if coalesce(v_revision ->> 'sourceBindingId', '') !~ '^src_[A-Za-z0-9_-]{8,100}$' or
         not exists (select 1 from public.team_source_bindings s
           where s.workspace_id = p_workspace_id and
             s.project_key = v_revision ->> 'projectKey' and
             s.source_id = v_revision ->> 'sourceBindingId' and
             s.superseded_by is null) then
        raise exception 'SOURCE_REVISION_OUTSIDE_PROJECT' using errcode = '22023';
      end if;
    else
      select count(*) into v_source_count from public.team_source_bindings s
        where s.workspace_id = p_workspace_id and
          s.project_key = v_revision ->> 'projectKey' and s.superseded_by is null;
      if v_source_count <> 1 then
        raise exception 'SOURCE_REVISION_AMBIGUOUS' using errcode = '22023';
      end if;
    end if;
  end loop;
end;
$$;
revoke all on function private.validate_team_revision_set(uuid,jsonb)
  from public, anon, authenticated;

create function private.guard_team_revision_set()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'UPDATE' and new.revision_set is not distinct from old.revision_set then
    return new;
  end if;
  perform private.validate_team_revision_set(new.workspace_id, new.revision_set);
  return new;
end;
$$;
revoke all on function private.guard_team_revision_set()
  from public, anon, authenticated;

create trigger guard_task_source_revisions before insert or update of revision_set
  on public.team_tasks for each row execute function private.guard_team_revision_set();
create trigger guard_evidence_source_revisions before insert or update of revision_set
  on public.team_evidence for each row execute function private.guard_team_revision_set();
create trigger guard_receipt_source_revisions before insert or update of revision_set
  on public.team_receipts for each row execute function private.guard_team_revision_set();

commit;
