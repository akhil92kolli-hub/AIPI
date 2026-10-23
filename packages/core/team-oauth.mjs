import crypto from "node:crypto";

export const TEAM_OAUTH_CLIENT_ID = "7c9f7da9-5da6-4822-aac2-c387b2b01b2e";
export const TEAM_OAUTH_REDIRECT_URI = "https://aipi-team-cloud.ceo-935.workers.dev/team/oauth-callback";
const AUTH_BASE = "https://zwffmaxjbzuazopvorkv.supabase.co/auth/v1";

export function beginTeamOAuth() {
  const verifier = crypto.randomBytes(32).toString("base64url");
  const state = crypto.randomBytes(32).toString("base64url");
  const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
  const url = new URL(`${AUTH_BASE}/oauth/authorize`);
  url.search = new URLSearchParams({ response_type: "code", client_id: TEAM_OAUTH_CLIENT_ID,
    redirect_uri: TEAM_OAUTH_REDIRECT_URI, scope: "email profile offline_access",
    code_challenge: challenge, code_challenge_method: "S256", state }).toString();
  return { url: url.href, verifier, state };
}

export async function exchangeTeamOAuthCode({ code, verifier, fetchImpl = fetch }) {
  if (!/^[A-Za-z0-9._~-]{16,512}$/.test(code) || !/^[A-Za-z0-9_-]{43,128}$/.test(verifier))
    throw new Error("Invalid Team authorization response");
  const response = await fetchImpl(`${AUTH_BASE}/oauth/token`, { method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" }, signal: AbortSignal.timeout(15_000),
    body: new URLSearchParams({ grant_type: "authorization_code", code, client_id: TEAM_OAUTH_CLIENT_ID,
      redirect_uri: TEAM_OAUTH_REDIRECT_URI, code_verifier: verifier }),
  });
  const session = await response.json().catch(() => ({}));
  if (!response.ok || !session.access_token || !session.refresh_token)
    throw new Error("Team authorization expired or was denied. Start again from the IDE.");
  return { access_token: session.access_token, refresh_token: session.refresh_token,
    expires_at: Math.floor(Date.now() / 1000) + Number(session.expires_in || 3600),
    oauth_client_id: TEAM_OAUTH_CLIENT_ID };
}

export async function refreshTeamOAuthSession(session, { fetchImpl = fetch } = {}) {
  const response = await fetchImpl(`${AUTH_BASE}/oauth/token`, { method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" }, signal: AbortSignal.timeout(15_000),
    body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: session.refresh_token,
      client_id: TEAM_OAUTH_CLIENT_ID }),
  });
  const next = await response.json().catch(() => ({}));
  if (!response.ok || !next.access_token || !next.refresh_token)
    throw new Error("Team session expired. Connect again from the IDE.");
  return { access_token: next.access_token, refresh_token: next.refresh_token,
    expires_at: Math.floor(Date.now() / 1000) + Number(next.expires_in || 3600),
    oauth_client_id: TEAM_OAUTH_CLIENT_ID };
}
