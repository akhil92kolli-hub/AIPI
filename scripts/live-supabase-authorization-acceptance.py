"""Run isolated two-user Supabase authorization checks; read the PAT from stdin.

This creates two temporary Auth users and one isolated organization. A finally
block removes them even when an assertion fails. Never pass a token as an arg.
"""

import argparse
import json
import re
import select
import secrets
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from datetime import datetime
from pathlib import Path

parser = argparse.ArgumentParser()
parser.add_argument('--project-ref', required=True)
parser.add_argument('--expected-project-name', required=True)
parser.add_argument('--allow-ephemeral-users', action='store_true')
parser.add_argument('--with-realtime', action='store_true')
parser.add_argument('--worker-url')
args = parser.parse_args()
if not args.allow_ephemeral_users:
    parser.error('Pass --allow-ephemeral-users to acknowledge temporary Auth-user creation')
if args.worker_url:
    worker = urllib.parse.urlsplit(args.worker_url)
    if worker.scheme != 'https' or worker.hostname not in {
        'mcp.aipi.website', 'aipi-team-cloud.ceo-935.workers.dev'
    } or worker.username or worker.password or worker.query or worker.fragment:
        parser.error('--worker-url must name the configured AIPI HTTPS worker')
ref = args.project_ref
if not re.fullmatch(r'[a-z0-9]{20}', ref):
    parser.error('--project-ref must be a Supabase project reference')
token = sys.stdin.readline().rstrip('\r\n')
base = f'https://{ref}.supabase.co'
management = f'https://api.supabase.com/v1/projects/{ref}'
results = []
created_users = []
service = None
realtime_process = None
organization_id = str(uuid.uuid4())
workspace_id = str(uuid.uuid4())
name = 'AIPI isolated acceptance ' + organization_id

def request(method, url, *, bearer=None, apikey=None, data=None):
    headers = {'Accept': 'application/json'}
    if bearer:
        headers['Authorization'] = 'Bearer ' + bearer
    if apikey:
        headers['apikey'] = apikey
    if data is not None:
        headers['Content-Type'] = 'application/json'
        data = json.dumps(data).encode()
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=30) as response:
            raw = response.read()
            try:
                value = json.loads(raw) if raw else None
            except json.JSONDecodeError:
                value = None
            return response.status, value
    except urllib.error.HTTPError as error:
        try:
            value = json.loads(error.read())
        except Exception:
            value = None
        return error.code, value

def sql(query):
    status, value = request('POST', management + '/database/query', bearer=token, data={'query': query})
    if status != 201:
        code = value.get('code') if isinstance(value, dict) else None
        raise RuntimeError(f'SQL status {status}, code {code}')
    return value

def expect(label, actual, expected):
    passed = actual == expected
    results.append({'check': label, 'passed': passed, 'observed': actual})
    if not passed:
        raise RuntimeError(f'{label}: observed {actual}, expected {expected}')

def probe_message(timeout):
    if realtime_process is None:
        return None
    ready, _, _ = select.select([realtime_process.stdout], [], [], timeout)
    if not ready:
        return None
    line = realtime_process.stdout.readline()
    return json.loads(line) if line else {'type': 'process_closed'}

def wait_for_change(operation_id, timeout):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        event = probe_message(max(0, deadline - time.monotonic()))
        if event is None:
            return False
        if event.get('type') in ('channel_error', 'socket_error', 'process_closed'):
            raise RuntimeError('Realtime subscription closed unexpectedly')
        if event.get('type') == 'change' and event.get('operationId') == operation_id:
            return True
    return False

try:
    status, project = request('GET', management, bearer=token)
    expect('intended project', (status, project.get('name') if isinstance(project, dict) else None),
           (200, args.expected_project_name))
    status, keys = request('GET', management + '/api-keys', bearer=token)
    expect('management keys available', status, 200)
    anon = next((x.get('api_key') for x in keys if x.get('name') == 'anon'), None)
    service = next((x.get('api_key') for x in keys if x.get('name') == 'service_role'), None)
    if not anon or not service:
        raise RuntimeError('Legacy project API keys unavailable')
    credentials = []
    for label in ('owner', 'viewer'):
        email = f'aipi-{label}-{uuid.uuid4().hex}@example.test'
        password = secrets.token_urlsafe(30)
        status, user = request('POST', base + '/auth/v1/admin/users', bearer=service, apikey=service,
                               data={'email': email, 'password': password, 'email_confirm': True})
        expect(f'{label} test user creation', status, 200)
        created_users.append(user['id'])
        credentials.append((email, password))
    owner_id, viewer_id = created_users
    sql("begin; "
        f"insert into public.organizations(id,owner_id,name) values ('{organization_id}','{owner_id}','{name}'); "
        f"insert into public.organization_memberships(organization_id,user_id,role) values ('{organization_id}','{viewer_id}','viewer'); "
        f"insert into public.team_workspaces(id,organization_id,name,created_by) values ('{workspace_id}','{organization_id}','Isolated acceptance','{owner_id}'); "
        f"insert into public.team_workspace_memberships(workspace_id,user_id,role) values ('{workspace_id}','{viewer_id}','viewer'); "
        'commit;')
    trial = sql(
        'select (s.plan=\'trial\' and s.status=\'trialing\' '
        'and s.trial_started_at=w.created_at '
        'and s.trial_ends_at=private.team_trial_end(w.created_at)) as valid '
        'from public.team_workspace_subscriptions s '
        f"join public.team_workspaces w on w.id=s.workspace_id where s.workspace_id='{workspace_id}'"
    )
    expect('server-created three-calendar-month trial', trial, [{'valid': True}])
    tokens = []
    for label, (email, password) in zip(('owner', 'viewer'), credentials):
        status, session = request('POST', base + '/auth/v1/token?grant_type=password', apikey=anon,
                                  data={'email': email, 'password': password})
        expect(f'{label} sign in', status, 200)
        tokens.append(session['access_token'])
    owner_token, viewer_token = tokens
    tasks = base + '/rest/v1/team_tasks'
    sql("begin; set local role service_role; "
        f"select set_config('request.jwt.claim.sub','{owner_id}',true); "
        f"insert into public.team_tasks(workspace_id,external_id,title,created_by) values ('{workspace_id}','task_live_one','Isolated acceptance task','{owner_id}'); "
        'commit;')
    task_query = tasks + '?workspace_id=eq.' + workspace_id + '&select=id'
    status, task_rows = request('GET', task_query, bearer=viewer_token, apikey=anon)
    expect('viewer task REST before revocation', (status, len(task_rows or [])), (200, 1))
    subscription_query = (base + '/rest/v1/team_workspace_subscriptions?workspace_id=eq.'
                          + workspace_id + '&select=workspace_id')
    status, subscriptions = request('GET', subscription_query, bearer=viewer_token, apikey=anon)
    expect('viewer trial REST before revocation', (status, len(subscriptions or [])), (200, 1))
    rest = base + '/rest/v1/team_workspaces?id=eq.' + workspace_id + '&select=id'
    status, rows = request('GET', rest, bearer=viewer_token, apikey=anon)
    expect('viewer workspace REST before revocation', (status, len(rows or [])), (200, 1))
    snapshot = base + '/rest/v1/rpc/get_team_snapshot'
    status, payload = request('POST', snapshot, bearer=viewer_token, apikey=anon,
                               data={'p_organization_id': organization_id})
    visible = any(x.get('entityType') == 'workspace' and x.get('entityId') == workspace_id
                  for x in (payload or {}).get('entities', [])) if isinstance(payload, dict) else False
    expect('viewer snapshot RPC before revocation', (status, visible), (200, True))
    status, _ = request('GET', base + '/rest/v1/team_graph_nodes?workspace_id=eq.' + workspace_id + '&select=id',
                        bearer=viewer_token, apikey=anon)
    expect('direct graph REST blocked', status in (401, 403), True)
    if args.with_realtime:
        realtime_process = subprocess.Popen(
            ['node', str(Path(__file__).with_name('live-supabase-realtime-probe.mjs'))],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
            text=True, bufsize=1,
        )
        realtime_process.stdin.write(json.dumps({
            'ref': ref, 'anon': anon, 'accessToken': viewer_token, 'workspaceId': workspace_id,
        }) + '\n')
        realtime_process.stdin.flush()
        expect('Realtime channel joined', (probe_message(12) or {}).get('type'), 'joined')
        ready = None
        deadline = time.monotonic() + 20
        while time.monotonic() < deadline:
            event = probe_message(max(0, deadline - time.monotonic()))
            if event is None:
                break
            if event.get('type') == 'system' and event.get('extension') == 'postgres_changes':
                ready = event.get('status')
                break
            if event.get('type') in ('channel_error', 'socket_error', 'process_closed'):
                ready = event.get('type')
                break
        expect('Realtime Postgres subscription ready', ready, 'ok')
        task_id = sql(f"select id from public.team_tasks where workspace_id='{workspace_id}'")[0]['id']
        before_operation = str(uuid.uuid4())
        sql(f"insert into public.team_change_events(organization_id,workspace_id,operation_id,entity_type,entity_id,event_type,payload) "
            f"values ('{organization_id}','{workspace_id}','{before_operation}','task','{task_id}','updated','{{}}'::jsonb)")
        expect('authorized Realtime event delivered', wait_for_change(before_operation, 10), True)
    sql(f"delete from public.team_workspace_memberships where workspace_id='{workspace_id}' and user_id='{viewer_id}';")
    if args.with_realtime:
        after_operation = str(uuid.uuid4())
        sql(f"insert into public.team_change_events(organization_id,workspace_id,operation_id,entity_type,entity_id,event_type,payload) "
            f"values ('{organization_id}','{workspace_id}','{after_operation}','task','{task_id}','updated','{{}}'::jsonb)")
        expect('revoked Realtime event suppressed', wait_for_change(after_operation, 4), False)
    status, rows = request('GET', rest, bearer=viewer_token, apikey=anon)
    expect('revoked viewer workspace REST', (status, len(rows or [])), (200, 0))
    status, task_rows = request('GET', task_query, bearer=viewer_token, apikey=anon)
    expect('revoked viewer task REST', (status, len(task_rows or [])), (200, 0))
    status, subscriptions = request('GET', subscription_query, bearer=viewer_token, apikey=anon)
    expect('revoked viewer trial REST', (status, len(subscriptions or [])), (200, 0))
    status, _ = request('POST', tasks, bearer=viewer_token, apikey=anon,
                        data={'workspace_id': workspace_id, 'external_id': 'task_live_two',
                              'title': 'Forbidden task', 'created_by': viewer_id})
    expect('revoked viewer task REST write denied', status in (401, 403), True)
    status, payload = request('POST', snapshot, bearer=viewer_token, apikey=anon,
                               data={'p_organization_id': organization_id})
    visible = any(x.get('entityType') == 'workspace' and x.get('entityId') == workspace_id
                  for x in (payload or {}).get('entities', [])) if isinstance(payload, dict) else False
    expect('revoked viewer snapshot RPC', (status, visible), (200, False))
    status, rows = request('GET', rest, bearer=owner_token, apikey=anon)
    expect('owner workspace REST remains visible', (status, len(rows or [])), (200, 1))
    trial_before = sql(f"select trial_started_at,trial_ends_at from public.team_workspace_subscriptions where workspace_id='{workspace_id}'")
    sql(f"update public.team_workspaces set description='Reconnect-safe trial test' where id='{workspace_id}'")
    trial_after = sql(f"select trial_started_at,trial_ends_at from public.team_workspace_subscriptions where workspace_id='{workspace_id}'")
    expect('workspace edit does not restart trial', trial_after, trial_before)
    sql(f"update public.team_workspace_subscriptions set trial_ends_at=now()-interval '1 second' where workspace_id='{workspace_id}'")
    expired_operation = str(uuid.uuid4())
    status, failure = request('POST', management + '/database/query', bearer=token, data={
        'query': f"insert into public.team_change_events(organization_id,workspace_id,operation_id,entity_type,event_type,payload) "
                 f"values ('{organization_id}','{workspace_id}','{expired_operation}','task','updated','{{}}'::jsonb)"
    })
    message = failure.get('message', '') if isinstance(failure, dict) else ''
    expect('expired trial denies new event', (status, 'TEAM_PLAN_EXPIRED' in message), (400, True))
    status, task_rows = request('GET', task_query, bearer=owner_token, apikey=anon)
    expect('expired trial preserves owner task read', (status, len(task_rows or [])), (200, 1))
    status, subscriptions = request('GET', subscription_query, bearer=owner_token, apikey=anon)
    expect('expired trial preserves owner subscription read', (status, len(subscriptions or [])), (200, 1))
    status, renewed_session = request('POST', base + '/auth/v1/token?grant_type=password', apikey=anon,
                                      data={'email': credentials[0][0], 'password': credentials[0][1]})
    expect('owner reconnect after trial expiry', status, 200)
    details_query = (base + '/rest/v1/team_workspace_subscriptions?workspace_id=eq.'
                     + workspace_id + '&select=trial_started_at,trial_ends_at')
    status, details = request('GET', details_query, bearer=renewed_session['access_token'], apikey=anon)
    expected_dates = sql(f"select trial_started_at,trial_ends_at from public.team_workspace_subscriptions where workspace_id='{workspace_id}'")
    dates = lambda row: tuple(datetime.fromisoformat(row[key].replace('Z', '+00:00')).timestamp()
                              for key in ('trial_started_at', 'trial_ends_at'))
    expect('reconnect retains expired trial dates',
           (status, dates(details[0]) if details else None), (200, dates(expected_dates[0])))
    if args.worker_url:
        status, exported = request('GET', args.worker_url.rstrip('/')
                                   + f'/api/team/organizations/{organization_id}/export',
                                   bearer=renewed_session['access_token'])
        task_exported = (isinstance(exported, dict)
                         and exported.get('format') == 'aipi-team-export-v1'
                         and exported.get('organization', {}).get('id') == organization_id
                         and any(item.get('entityType') == 'task'
                                 for item in exported.get('snapshot', {}).get('entities', [])))
        export_error = exported.get('error') if isinstance(exported, dict) else None
        expect('expired trial owner export preserves task',
               (status, task_exported, export_error), (200, True, None))
finally:
    if realtime_process is not None:
        try:
            realtime_process.stdin.write('close\n')
            realtime_process.stdin.flush()
            realtime_process.wait(timeout=3)
        except Exception:
            realtime_process.kill()
    cleanup = {'organization_removed': False, 'users_removed': 0}
    for attempt in range(3):
        try:
            quoted_name = name.replace("'", "''")
            sql("begin; select set_config('request.jwt.claim.role','service_role',true); "
                f"delete from public.organizations where id='{organization_id}' and name='{quoted_name}'; commit;")
            cleanup['organization_removed'] = True
            break
        except Exception as error:
            cleanup['organization_error'] = type(error).__name__
        if attempt < 2:
            time.sleep(attempt + 1)
    for user_id in created_users:
        for attempt in range(3):
            try:
                if not service:
                    raise RuntimeError('service key unavailable')
                status, _ = request('DELETE', base + '/auth/v1/admin/users/' + user_id,
                                    bearer=service, apikey=service)
                if status in (200, 204, 404):
                    cleanup['users_removed'] += 1
                    break
                cleanup['users_error'] = f'HTTP {status}'
            except Exception as error:
                cleanup['users_error'] = type(error).__name__
            if attempt < 2:
                time.sleep(attempt + 1)
    try:
        rows = sql(
            f"select (select count(*) from public.organizations where id='{organization_id}') as organizations, "
            f"(select count(*) from auth.users where id in ({','.join(repr(x) for x in created_users) or "''"})) as users"
        )
        cleanup['remaining_rows'] = rows[0]
    except Exception as error:
        cleanup['verification_error'] = type(error).__name__
    print(json.dumps({'project_ref': ref, 'results': results, 'cleanup': cleanup}))
    if (not cleanup['organization_removed'] or cleanup['users_removed'] != len(created_users)
            or cleanup.get('remaining_rows') != {'organizations': 0, 'users': 0}):
        raise SystemExit('Acceptance cleanup incomplete')
