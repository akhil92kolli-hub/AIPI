import { createClient } from "@supabase/supabase-js";
import { syncTeamOnce } from "./team-sync-client.mjs";
import { refreshTeamOAuthSession, TEAM_OAUTH_CLIENT_ID } from "./team-oauth.mjs";

const DEFAULT_SUPABASE_URL = "https://zwffmaxjbzuazopvorkv.supabase.co";
const DEFAULT_PUBLISHABLE_KEY = "sb_publishable_usDgSv1ntGAwQVpk2lenYQ_E06i1WYy";

// Realtime is only a wake-up signal. Every wake-up replays the durable outbox
// and cursor feed; dropped or reordered WebSocket messages cannot lose data.
export async function startTeamSyncSession(store, {
  organizationId, accessToken, refreshToken = null, oauthClientId = null, expiresAt = null,
  onSession = async () => {}, baseUrl = "https://mcp.aipi.website",
  supabaseUrl = DEFAULT_SUPABASE_URL, publishableKey = DEFAULT_PUBLISHABLE_KEY,
  intervalMs = 30_000, onStatus = () => {}, clientFactory = createClient,
  sync = syncTeamOnce, onAfterSync = async () => null,
}) {
  if (!/^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(organizationId) || !accessToken || intervalMs < 1000)
    throw new Error("A valid organization and user session are required");
  const client = clientFactory(supabaseUrl, publishableKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  let currentToken = accessToken;
  let currentExpiresAt = Number(expiresAt) || 0;
  const currentSession = async () => {
    if (!refreshToken) return currentToken;
    if (oauthClientId) {
      if (oauthClientId !== TEAM_OAUTH_CLIENT_ID) throw new Error("Unknown Team OAuth client");
      if (currentExpiresAt > Math.floor(Date.now() / 1000) + 90) return currentToken;
      const next = await refreshTeamOAuthSession({ refresh_token: refreshToken });
      await onSession(next);
      refreshToken = next.refresh_token;
      currentToken = next.access_token;
      currentExpiresAt = next.expires_at;
      await client.realtime.setAuth(currentToken);
      return currentToken;
    }
    const { data, error } = await client.auth.getSession();
    if (error || !data.session?.access_token) throw error ?? new Error("Team session expired. Connect again from the IDE.");
    const next = data.session;
    if (next.refresh_token !== refreshToken) {
      await onSession(next);
      refreshToken = next.refresh_token;
    }
    if (next.access_token !== currentToken) {
      currentToken = next.access_token;
      await client.realtime.setAuth(currentToken);
    }
    return currentToken;
  };
  if (refreshToken && !oauthClientId) {
    const { data, error } = await client.auth.setSession({ access_token: accessToken, refresh_token: refreshToken });
    if (error || !data.session) throw error ?? new Error("Team session expired. Connect again from the IDE.");
    if (data.session.refresh_token !== refreshToken || data.session.access_token !== accessToken) {
      await onSession(data.session);
      refreshToken = data.session.refresh_token;
      currentToken = data.session.access_token;
    }
  }
  await client.realtime.setAuth(currentToken);
  let stopped = false;
  let active = null;
  let queued = false;
  let lastResult = null;
  let lastSuccessfulSyncAt = null;
  let subscriptionStatus = "CONNECTING";

  const runNow = () => {
    if (stopped) return Promise.reject(new Error("Team sync session stopped"));
    if (active) { queued = true; return active; }
    active = (async () => {
      do {
        queued = false;
        try {
          const accessToken = await currentSession();
          lastResult = await sync(store, { baseUrl, accessToken, organizationId });
          if (!lastResult.error) {
            const repositoryBindings = await onAfterSync({organizationId,accessToken});
            if (repositoryBindings) lastResult = {...lastResult,repositoryBindings};
          }
          if (!lastResult.error) lastSuccessfulSyncAt = new Date().toISOString();
          onStatus({ subscriptionStatus, result: lastResult, lastSuccessfulSyncAt });
        } catch (error) {
          lastResult = { error: error.message };
          onStatus({ subscriptionStatus, result: lastResult, lastSuccessfulSyncAt });
        }
      } while (queued && !stopped);
      return lastResult;
    })().finally(() => { active = null; });
    return active;
  };
  const channel = client.channel(`aipi-team-${organizationId}`)
    .on("postgres_changes", {
      event: "INSERT", schema: "public", table: "team_change_events",
      filter: `organization_id=eq.${organizationId}`,
    }, () => { void runNow(); })
    .subscribe((status) => { subscriptionStatus = status; onStatus({ subscriptionStatus, result: lastResult, lastSuccessfulSyncAt }); });
  const timer = setInterval(() => { void runNow(); }, intervalMs);
  timer.unref?.();
  await runNow();
  return {
    organizationId,
    runNow,
    status: () => ({ subscriptionStatus, result: lastResult, lastSuccessfulSyncAt }),
    async stop() {
      stopped = true;
      clearInterval(timer);
      await client.removeChannel(channel);
      await active;
    },
  };
}
