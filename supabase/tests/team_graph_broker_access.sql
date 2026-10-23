begin;
select plan(6);

select ok(not has_table_privilege('authenticated','public.team_graph_nodes','SELECT'),
  'authenticated REST cannot read graph nodes directly');
select ok(not has_table_privilege('authenticated','public.team_graph_edges','SELECT'),
  'authenticated REST cannot read graph edges directly');

set local role authenticated;
select throws_ok('select count(*) from public.team_graph_nodes','42501',
  'permission denied for table team_graph_nodes','direct node query is denied');
select throws_ok('select count(*) from public.team_graph_edges','42501',
  'permission denied for table team_graph_edges','direct edge query is denied');

reset role;
set local role service_role;
select is((select count(*) from public.team_graph_nodes),0::bigint,
  'the authorized broker can query bounded graph nodes');
select is((select count(*) from public.team_graph_edges),0::bigint,
  'the authorized broker can query bounded graph edges');

select * from finish();
rollback;
