import assert from "node:assert/strict";
import { beginTeamOAuth, exchangeTeamOAuthCode, refreshTeamOAuthSession, TEAM_OAUTH_CLIENT_ID, TEAM_OAUTH_REDIRECT_URI } from "../packages/core/team-oauth.mjs";

const first = beginTeamOAuth();
const second = beginTeamOAuth();
const authorize = new URL(first.url);
assert.notEqual(first.state, second.state);
assert.notEqual(first.verifier, second.verifier);
assert.equal(authorize.searchParams.get("client_id"), TEAM_OAUTH_CLIENT_ID);
assert.equal(authorize.searchParams.get("redirect_uri"), TEAM_OAUTH_REDIRECT_URI);
assert.equal(authorize.searchParams.get("code_challenge_method"), "S256");
assert.equal(authorize.searchParams.get("state"), first.state);
assert.ok(!first.url.includes(first.verifier), "PKCE verifier must stay in the companion");

const requests = [];
const fetchImpl = async (url, init) => {
  requests.push({ url, init });
  return Response.json({ access_token: "access", refresh_token: "refresh", expires_in: 3600 });
};
const exchanged = await exchangeTeamOAuthCode({ code: "x".repeat(32), verifier: first.verifier, fetchImpl });
assert.equal(exchanged.oauth_client_id, TEAM_OAUTH_CLIENT_ID);
assert.equal(requests[0].init.body.get("code_verifier"), first.verifier);
assert.equal(requests[0].init.body.get("redirect_uri"), TEAM_OAUTH_REDIRECT_URI);
const refreshed = await refreshTeamOAuthSession(exchanged, { fetchImpl });
assert.equal(refreshed.refresh_token, "refresh");
assert.equal(requests[1].init.body.get("grant_type"), "refresh_token");
assert.equal(requests[1].init.body.get("client_id"), TEAM_OAUTH_CLIENT_ID);
console.log("Team companion OAuth uses PKCE and refreshes its own session");
