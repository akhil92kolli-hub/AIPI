import { createClient } from "@supabase/supabase-js";

const config = window.AIPI_CONFIG ?? {};
const intro = document.querySelector("#consentIntro");
const details = document.querySelector("#consentDetails");
const clientName = document.querySelector("#clientName");
const redirectUri = document.querySelector("#redirectUri");
const scopeList = document.querySelector("#scopeList");
const actions = document.querySelector("#consentActions");
const approveButton = document.querySelector("#approveButton");
const denyButton = document.querySelector("#denyButton");
const message = document.querySelector("#consentMessage");
const authorizationId = new URLSearchParams(location.search).get("authorization_id");

function showError(text) {
  message.textContent = text;
  message.className = "auth-message error";
}

function signIn() {
  const returnTo = `${location.pathname}${location.search}`;
  location.assign(`/login.html?return_to=${encodeURIComponent(returnTo)}`);
}

if (!config.supabaseUrl || !config.supabaseAnonKey) {
  showError("AIPI cloud authentication is not configured.");
} else if (!authorizationId) {
  showError("This authorization request is missing its identifier.");
} else {
  const supabase = createClient(config.supabaseUrl, config.supabaseAnonKey, {
    auth: { storageKey: "aipi.auth", persistSession: true, autoRefreshToken: true, detectSessionInUrl: false },
  });

  const { data: sessionData } = await supabase.auth.getSession();
  if (!sessionData.session) {
    signIn();
  } else {
    const { data, error } = await supabase.auth.oauth.getAuthorizationDetails(authorizationId);
    if (error || !data) {
      showError(error?.message ?? "The authorization request is invalid or expired.");
    } else if (!("authorization_id" in data)) {
      location.assign(data.redirect_url);
    } else {
      intro.textContent = "Review the application and permissions before allowing access to your AIPI account.";
      clientName.textContent = data.client?.name ?? "OpenAI";
      redirectUri.textContent = data.redirect_uri ?? "";
      const scopes = (data.scope ?? "").split(/\s+/).filter(Boolean);
      for (const scope of scopes) {
        const item = document.createElement("li");
        item.textContent = scope;
        scopeList.append(item);
      }
      details.hidden = false;
      actions.hidden = false;

      async function decide(approve) {
        approveButton.disabled = true;
        denyButton.disabled = true;
        message.textContent = approve ? "Authorizing…" : "Declining…";
        const response = approve
          ? await supabase.auth.oauth.approveAuthorization(authorizationId)
          : await supabase.auth.oauth.denyAuthorization(authorizationId);
        if (response.error || !response.data?.redirect_url) {
          showError(response.error?.message ?? "AIPI could not complete the authorization decision.");
          approveButton.disabled = false;
          denyButton.disabled = false;
          return;
        }
        location.assign(response.data.redirect_url);
      }

      approveButton.addEventListener("click", () => decide(true));
      denyButton.addEventListener("click", () => decide(false));
    }
  }
}
