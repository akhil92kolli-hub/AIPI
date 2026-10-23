import { startTeamSyncSession } from "./team-realtime.mjs";

// A companion may have projects in several Team accounts. Keep each account's
// cursor, credentials, and Realtime connection independent.
export function createTeamSessionManager({ start = startTeamSyncSession, afterSync = async () => null } = {}) {
  const sessions = new Map();
  const statuses = new Map();
  const pending = new Map();
  const disconnected = new Set();
  let closed = false;

  const serialize = (organizationId, operation) => {
    const previous = pending.get(organizationId) ?? Promise.resolve();
    const current = previous.catch(() => {}).then(operation);
    pending.set(organizationId, current);
    void current.finally(() => {
      if (pending.get(organizationId) === current) pending.delete(organizationId);
    }).catch(() => {});
    return current;
  };

  return {
    connect(store, options, { ifAbsent = false } = {}) {
      const { organizationId } = options;
      if (closed) return Promise.reject(new Error("Team session manager stopped"));
      return serialize(organizationId, async () => {
        if (closed) throw new Error("Team session manager stopped");
        if (ifAbsent && disconnected.has(organizationId)) return null;
        if (ifAbsent && sessions.has(organizationId)) return sessions.get(organizationId);
        if (!ifAbsent) disconnected.delete(organizationId);
        await sessions.get(organizationId)?.stop();
        sessions.delete(organizationId);
        try {
          const session = await start(store, {
            ...options,
            onAfterSync: (session) => afterSync(store, session),
            onStatus: (status) => {
              statuses.set(organizationId, status);
              options.onStatus?.(status);
            },
          });
          if (closed) {
            await session.stop();
            throw new Error("Team session manager stopped");
          }
          sessions.set(organizationId, session);
          statuses.set(organizationId, session.status());
          return session;
        } catch (error) {
          statuses.set(organizationId, { result: { error: error.message } });
          throw error;
        }
      });
    },
    get(organizationId) { return sessions.get(organizationId) ?? null; },
    status(organizationId) { return sessions.get(organizationId)?.status() ?? statuses.get(organizationId) ?? null; },
    activeOrganizationIds() { return [...sessions.keys()]; },
    async disconnect(organizationId) {
      if (!organizationId) throw new Error("Organization ID required to disconnect a Team session");
      await serialize(organizationId, async () => {
        disconnected.add(organizationId);
        await sessions.get(organizationId)?.stop();
        sessions.delete(organizationId);
        statuses.delete(organizationId);
      });
    },
    async runAll(organizationIds = [...sessions.keys()]) {
      return Promise.allSettled(organizationIds.map((organizationId) => sessions.get(organizationId)?.runNow()));
    },
    async close() {
      closed = true;
      await Promise.allSettled([...pending.values()]);
      await Promise.allSettled([...sessions.values()].map((session) => session.stop()));
      sessions.clear();
      statuses.clear();
    },
  };
}
