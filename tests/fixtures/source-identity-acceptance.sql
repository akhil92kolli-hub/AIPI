grant all on all tables in schema public to service_role;
set role service_role;
do $$
declare w uuid='11111111-1111-4111-a111-111111111111';a uuid='33333333-3333-4333-a333-333333333333';
 canonical text='src_'||substr(md5('aipi:primary:prj_api1234'),1,24);p text='src_'||substr(md5('aipi:primary:prj_web1234'),1,24);r jsonb;v bigint;count_before int;
begin
 if (select count(*) from team_source_bindings where project_key='prj_api1234' and superseded_by is null)<>1 then raise exception 'duplicate backfill failed';end if;
 if (select superseded_by from team_source_bindings where source_id='src_duplicate1234')<>canonical then raise exception 'alias not retained';end if;
 r=save_team_source(a,w,'prj_api1234',canonical,'API','repository','123','acme/api','https://github.com/acme/api','.',null,1,'main',repeat('a',40));v=(r->>'version')::bigint;
 r=save_team_source(a,w,'prj_api1234',canonical,'API','repository','123','acme/api','https://github.com/acme/api','.',null,1,'main',repeat('a',40));
 if (r->>'version')::bigint<>v then raise exception 'retry advanced version';end if;
 r=save_team_source(a,w,'prj_api1234','src_secondary1234','Web','repository','123','acme/api','https://github.com/acme/api','apps/web',null,null,'main',repeat('a',40));
 if r->>'source_id'<>'src_secondary1234' then raise exception 'additional directory failed';end if;
 v=(r->>'version')::bigint;
 r=save_team_source(a,w,'prj_api1234','src_secondary1234','Web','repository','123','acme/api','https://github.com/acme/api','apps/web',null,v,'dev',repeat('c',40));
 if r->>'source_id'<>'src_secondary1234' or (r->>'version')::bigint<=v then raise exception 'branch change lost identity/version';end if;
 r=save_team_source(a,w,'prj_api1234','src_secondary1234','Web','repository','123','acme/api','https://github.com/acme/api','apps/web',null,(r->>'version')::bigint,'main',repeat('a',40));
 r=save_team_source(a,w,'prj_api1234','src_repeated1234','Repeated','repository','123','acme/api','https://github.com/acme/api','apps/web',null,null,'main',repeat('a',40));
 if r->>'source_id'<>'src_secondary1234' or exists(select 1 from team_source_bindings where source_id='src_repeated1234') then raise exception 'repeated attach created duplicate';end if;
 begin
  perform save_team_source(a,w,'prj_api1234','src_secondary1234','Web','repository','123','acme/api','https://github.com/acme/api','apps/changed',null,1,'main',repeat('a',40));
  raise exception 'directory was reassigned';
 exception when serialization_failure then null;end;
 r=save_team_source(a,w,'prj_web1234',p,'Web','repository','456','acme/web','https://github.com/acme/web','.',null,1,'release',repeat('b',40));
 if r->>'tracking_branch'<>'release' or r->>'provider_repository_id'<>'456' then raise exception 'local primary bind failed';end if;
 begin
  perform save_team_source('44444444-4444-4444-a444-444444444444',w,'prj_web1234','src_noaccess1234','Denied','local',null,null,null,'.',null,null,null,null);
  raise exception 'viewer wrote a source';
 exception when insufficient_privilege then null;end;
 begin
  perform save_team_source(a,w,'prj_web1234',canonical,'Foreign','local',null,null,null,'.',null,null,null,null);
  raise exception 'source moved across project ownership';
 exception when serialization_failure then null;end;
end $$;
reset role;
set role authenticated;
set request.jwt.claim.sub='55555555-5555-4555-a555-555555555555';
do $$begin if exists(select 1 from team_source_bindings) then raise exception 'RLS exposed sources';end if;end$$;
set request.jwt.claim.sub='33333333-3333-4333-a333-333333333333';
do $$begin if not exists(select 1 from team_source_bindings) then raise exception 'RLS hid member sources';end if;end$$;
do $$begin
 begin
  insert into team_source_bindings(workspace_id,project_key,source_id,name,kind) values('11111111-1111-4111-a111-111111111111','prj_api1234','src_denied1234','Denied','local');
  raise exception 'authenticated direct write was permitted';
 exception when insufficient_privilege then null;end;
end$$;
reset role;
