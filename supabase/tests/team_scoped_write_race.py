"""Exercise concurrent workspace-write and membership-revocation ordering.

Run only against a disposable migrated database with the Supabase roles present:
    AIPI_TEST_DATABASE_URL=postgresql://... python3 supabase/tests/team_scoped_write_race.py
"""

import json
import os
import subprocess
import time
import uuid


database = os.environ.get("AIPI_TEST_DATABASE_URL")
if not database:
    raise SystemExit("Set AIPI_TEST_DATABASE_URL to a disposable migrated database")
psql = os.environ.get("PSQL", "psql")
command = [psql, "-X", "-d", database, "-v", "ON_ERROR_STOP=1", "-Atqc"]


def query(statement):
    return subprocess.run([*command, statement], capture_output=True, text=True)


owner, editor, organization, workspace = (str(uuid.uuid4()) for _ in range(4))
fixture = f"""
insert into auth.users(id,instance_id,aud,role,email,encrypted_password,
  email_confirmed_at,raw_app_meta_data,raw_user_meta_data,created_at,updated_at)
values ('{owner}','00000000-0000-0000-0000-000000000000','authenticated',
  'authenticated','{owner}@example.test','',now(),'{{}}','{{}}',now(),now()),
  ('{editor}','00000000-0000-0000-0000-000000000000','authenticated',
  'authenticated','{editor}@example.test','',now(),'{{}}','{{}}',now(),now());
insert into public.organizations(id,owner_id,name) values('{organization}','{owner}','Race test');
insert into public.organization_memberships(organization_id,user_id,role)
  values('{organization}','{editor}','developer');
insert into public.team_workspaces(id,organization_id,name,created_by)
  values('{workspace}','{organization}','Race workspace','{owner}');
insert into public.team_workspace_memberships(workspace_id,user_id,role)
  values('{workspace}','{editor}','developer');
"""
created = query(fixture)
if created.returncode:
    raise SystemExit(created.stderr)

writer_sql = f"""
begin;
set application_name='aipi_revocation_writer';
set local role service_role;
select set_config('request.jwt.claim.sub','{editor}',true);
insert into public.team_tasks(workspace_id,external_id,title,created_by)
  values('{workspace}','task_race_first','First','{editor}');
select pg_sleep(4);
commit;
"""
writer = subprocess.Popen([*command, writer_sql], stdout=subprocess.PIPE,
                          stderr=subprocess.PIPE, text=True)
sleeping = False
for _ in range(100):
    state = query("select coalesce(wait_event,'') from pg_stat_activity "
                  "where application_name='aipi_revocation_writer' and state='active'")
    if "PgSleep" in state.stdout:
        sleeping = True
        break
    if writer.poll() is not None:
        break
    time.sleep(0.05)
if not sleeping:
    output = writer.communicate() if writer.poll() is not None else ("", "still running")
    raise SystemExit(f"Writer did not reach open-transaction barrier: {output}")

started = time.monotonic()
revocation = query(f"delete from public.team_workspace_memberships "
                   f"where workspace_id='{workspace}' and user_id='{editor}'")
wait_seconds = round(time.monotonic() - started, 2)
writer_output = writer.communicate(timeout=12)
after = query(f"""
begin;
set local role service_role;
select set_config('request.jwt.claim.sub','{editor}',true);
insert into public.team_tasks(workspace_id,external_id,title,created_by)
  values('{workspace}','task_race_second','Second','{editor}');
commit;
""")
result = {
    "writerCommitted": writer.returncode == 0,
    "revocationCommitted": revocation.returncode == 0,
    "revocationWaitSeconds": wait_seconds,
    "postRevocationWriteDenied": after.returncode != 0 and "WORKSPACE_WRITE_DENIED" in after.stderr,
}
print(json.dumps(result))
if not all((result["writerCommitted"], result["revocationCommitted"],
            wait_seconds >= 2.5, result["postRevocationWriteDenied"])):
    raise SystemExit(f"Race assertion failed: {writer_output}; {revocation.stderr}; {after.stderr}")
