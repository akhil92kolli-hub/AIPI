import { createHmac, createPrivateKey, sign, timingSafeEqual } from 'node:crypto';

const b64 = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
export function verifyGitHubWebhook(body, signature, secret) {
  if (!secret || !/^sha256=[0-9a-f]{64}$/.test(signature ?? '')) return false;
  const expected = createHmac('sha256', secret).update(body).digest();
  const received = Buffer.from(signature.slice(7), 'hex');
  return received.length === expected.length && timingSafeEqual(received, expected);
}
export function githubAppJwt(appId, privateKey, now = Date.now()) {
  if (!/^[1-9][0-9]*$/.test(String(appId)) || !privateKey) throw new Error('GitHub App credentials are required');
  const value = `${b64({ alg: 'RS256', typ: 'JWT' })}.${b64({ iat: Math.floor(now / 1000) - 60, exp: Math.floor(now / 1000) + 540, iss: String(appId) })}`;
  return `${value}.${sign('RSA-SHA256', Buffer.from(value), createPrivateKey(privateKey)).toString('base64url')}`;
}
/** @param {string} path @param {{appId?: string | number, privateKey?: string, fetchImpl?: typeof fetch, method?: string, body?: any}} [options] */
export async function githubAppRequest(path, { appId, privateKey, fetchImpl = fetch, method = 'GET', body } = {}) {
  const response = await fetchImpl(`https://api.github.com${path}`, { method,
    headers: { authorization: `Bearer ${githubAppJwt(appId, privateKey)}`, accept: 'application/vnd.github+json',
      'x-github-api-version': '2026-03-10', 'user-agent': 'AIPI-Team', ...(body ? { 'content-type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}) });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`GitHub App request failed (${response.status})`);
  return data;
}
export async function githubInstallationToken(installationId, repositoryId, credentials) {
  const data = await githubAppRequest(`/app/installations/${installationId}/access_tokens`, {
    ...credentials, method: 'POST', body: { repository_ids: [Number(repositoryId)],
      permissions: { issues: 'write' } },
  });
  if (!data.token || data.permissions?.issues !== 'write') throw new Error('GitHub installation lacks issue-comment permission');
  return data.token;
}
export async function githubInstallationChecksToken(installationId, repositoryId, credentials) {
  const data = await githubAppRequest(`/app/installations/${installationId}/access_tokens`, {
    ...credentials, method:'POST', body:{repository_ids:[Number(repositoryId)], permissions:{checks:'write'}},
  });
  if(!data.token || data.permissions?.checks!=='write')throw new Error('GitHub installation lacks checks:write permission');
  return data.token;
}

export async function publishAipiBlockingCheck({repository,headSha,installationId,repositoryId,appId,privateKey,
  summary,externalId,fetchImpl=fetch}) {
  if(!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository ?? '') || !/^[0-9a-f]{40}$/.test(headSha ?? '') ||
      !Number.isSafeInteger(Number(installationId)) || !Number.isSafeInteger(Number(repositoryId)) ||
      typeof summary!=='string' || summary.length>1000 || !/^aipi:[a-z0-9:-]{1,180}$/.test(externalId ?? ''))
    throw new Error('A bounded, pinned GitHub check is required');
  const token=await githubInstallationChecksToken(installationId,repositoryId,{appId,privateKey,fetchImpl});
  const path=`/repos/${repository.split('/').map(encodeURIComponent).join('/')}`;
  const existing=await githubRepositoryRequest(`${path}/commits/${headSha}/check-runs?check_name=${encodeURIComponent('AIPI / cross-repo release')}&app_id=${appId}&filter=all&per_page=100`,token,{fetchImpl});
  if(!Array.isArray(existing.check_runs) || Number(existing.total_count)>100)
    throw new Error('AIPI check run history exceeds bounded idempotency lookup');
  const own=existing.check_runs.find(run=>run.external_id===externalId && Number(run.app?.id)===Number(appId));
  const body={name:'AIPI / cross-repo release',head_sha:headSha,status:'completed',conclusion:'failure',external_id:externalId,
    output:{title:'Cross-repository release evidence incomplete',summary}};
  const run=own
    ? await githubRepositoryRequest(`${path}/check-runs/${own.id}`,token,{method:'PATCH',body:{status:body.status,conclusion:body.conclusion,output:body.output},fetchImpl})
    : await githubRepositoryRequest(`${path}/check-runs`,token,{method:'POST',body,fetchImpl});
  return {id:run.id,headSha,conclusion:'failure',reused:Boolean(own)};
}
/** @param {string} path @param {string} token @param {{method?: string, body?: any, fetchImpl?: typeof fetch}} [options] */
export async function githubRepositoryRequest(path, token, { method = 'GET', body, fetchImpl = fetch } = {}) {
  const response = await fetchImpl(`https://api.github.com${path}`, { method,
    headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json',
      'x-github-api-version': '2026-03-10', 'user-agent': 'AIPI-Team', ...(body ? { 'content-type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}) });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`GitHub repository request failed (${response.status})`);
  return data;
}

export async function verifyUserInstallationAccess({ installationId, appId, userToken, fetchImpl = fetch }) {
  if (!Number.isSafeInteger(installationId) || installationId < 1 || !/^[1-9][0-9]*$/.test(String(appId)) || !userToken)
    throw new Error('GitHub user authorization is required');
  const get = async (path) => {
    const response = await fetchImpl(`https://api.github.com${path}`, { headers: {
      authorization: `Bearer ${userToken}`, accept: 'application/vnd.github+json',
      'x-github-api-version': '2026-03-10', 'user-agent': 'AIPI-Team',
    } });
    if (!response.ok) throw new Error('GitHub user authorization could not be verified');
    return response.json();
  };
  const user = await get('/user');
  if (!Number.isSafeInteger(user.id) || !user.login) throw new Error('GitHub user identity is invalid');
  for (let page = 1; page <= 10; page++) {
    const result = await get(`/user/installations?per_page=100&page=${page}`);
    const installations = result.installations;
    if (!Array.isArray(installations)) throw new Error('GitHub installation access response is invalid');
    const installation = installations.find((entry) => Number(entry.id) === installationId && Number(entry.app_id) === Number(appId) && !entry.suspended_at);
    if (installation) return { userId: user.id, userLogin: user.login, installation };
    if (installations.length < 100) break;
  }
  throw new Error('GitHub user cannot access this App installation');
}

// A GitHub App user token is limited by the user's rights and the App's
// installation. Recheck repository access for each source request so removal
// from the installation or a user's repository grant takes effect immediately.
export async function verifyUserRepositoryAccess({ installationId, appId, repositoryId, userToken, fetchImpl = fetch }) {
  const access = await verifyUserInstallationAccess({ installationId, appId, userToken, fetchImpl });
  const headers = { authorization: `Bearer ${userToken}`, accept: 'application/vnd.github+json',
    'x-github-api-version': '2026-03-10', 'user-agent': 'AIPI-Team' };
  for (let page = 1; page <= 10; page++) {
    const response = await fetchImpl(`https://api.github.com/user/installations/${installationId}/repositories?per_page=100&page=${page}`, { headers });
    if (!response.ok) throw new Error('GitHub repository access could not be verified');
    const data = await response.json();
    if (!Array.isArray(data.repositories)) throw new Error('GitHub repository access response is invalid');
    const repository = data.repositories.find((entry) => String(entry.id) === String(repositoryId));
    if (repository) return { ...access, repository,
      canRead: Boolean(repository.permissions?.pull || repository.permissions?.push || repository.permissions?.admin),
      canWrite: Boolean(repository.permissions?.push || repository.permissions?.admin) };
    if (data.repositories.length < 100) break;
  }
  throw new Error('GitHub user cannot access this installed repository');
}
