-- This event-trigger function is invoked by PostgreSQL's registered DDL event
-- trigger, not through the public Data API. Do not expose it as an RPC.
do $$
begin
  if to_regprocedure('public.rls_auto_enable()') is not null then
    execute 'revoke all on function public.rls_auto_enable() from public, anon, authenticated';
  end if;
end;
$$;
