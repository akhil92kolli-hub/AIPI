import { createSecretVault } from "./secret-vault.mjs";

const reference = (organizationId) => `aipi-team-session:${organizationId}`;
const validId = (value) => /^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(value);

export async function saveTeamSession(organizationId, session) {
  if (!validId(organizationId) || !session?.access_token || !session?.refresh_token)
    throw new Error("A complete team session is required");
  const vault = await createSecretVault();
  if (!vault) throw new Error("AIPI needs an OS credential store to keep team sync connected");
  await vault.set(reference(organizationId), JSON.stringify({
    accessToken: session.access_token, refreshToken: session.refresh_token,
    oauthClientId: session.oauth_client_id ?? null, expiresAt: session.expires_at ?? null,
  }));
}

export async function loadTeamSession(organizationId) {
  if (!validId(organizationId)) throw new Error("Invalid team organization");
  const vault = await createSecretVault();
  if (!vault) return null;
  try {
    const session = JSON.parse(await vault.get(reference(organizationId)));
    return typeof session.accessToken === "string" && typeof session.refreshToken === "string" ? session : null;
  } catch { return null; }
}

export async function deleteTeamSession(organizationId) {
  if (!validId(organizationId)) throw new Error("Invalid team organization");
  const vault = await createSecretVault();
  if (vault) await vault.delete(reference(organizationId));
}
