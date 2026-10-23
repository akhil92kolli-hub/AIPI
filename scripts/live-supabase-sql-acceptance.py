"""Run rollback-only Supabase SQL assertions with a Management PAT from stdin."""

import argparse
import json
import re
import sys
import urllib.error
import urllib.request
from pathlib import Path

parser = argparse.ArgumentParser()
parser.add_argument('--project-ref', required=True)
parser.add_argument('--expected-project-name', required=True)
args = parser.parse_args()
if not re.fullmatch(r'[a-z0-9]{20}', args.project_ref):
    parser.error('--project-ref must be a Supabase project reference')
token = sys.stdin.readline().rstrip('\r\n')
base = f'https://api.supabase.com/v1/projects/{args.project_ref}'
headers = {'Authorization': f'Bearer {token}', 'Content-Type': 'application/json'}

def call(method, url, body=None):
    request = urllib.request.Request(url, data=json.dumps(body).encode() if body is not None else None,
                                     headers=headers, method=method)
    try:
        with urllib.request.urlopen(request, timeout=60) as response:
            return response.status, json.load(response)
    except urllib.error.HTTPError as error:
        return error.code, None

status, project = call('GET', base)
if status != 200 or not isinstance(project, dict) or project.get('name') != args.expected_project_name:
    raise SystemExit('Project identity check failed; no SQL ran')
sql = Path(__file__).resolve().parents[1].joinpath('supabase/tests/live_team_guard_transaction.sql').read_text()
if not sql.strip().endswith('rollback;'):
    raise SystemExit('SQL must end in rollback; no SQL ran')
status, _ = call('POST', base + '/database/query', {'query': sql})
if status != 201:
    raise SystemExit(f'Live rollback-only SQL assertions failed (HTTP {status})')
print(json.dumps({'project_ref': args.project_ref, 'status': 'passed', 'transaction': 'rolled_back'}))
