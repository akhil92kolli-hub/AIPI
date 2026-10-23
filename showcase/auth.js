const form = document.querySelector("#authForm");
const title = document.querySelector("#authTitle");
const submit = document.querySelector("#authSubmit");
const toggle = document.querySelector("#modeToggle");
const message = document.querySelector("#authMessage");
let signUp = false;

function show(text, kind = "") {
  message.textContent = text;
  message.className = `auth-message ${kind}`.trim();
}

function config() {
  return window.AIPI_CONFIG ?? {};
}

function returnTarget() {
  const value = new URLSearchParams(location.search).get("return_to");
  if (!value) return null;
  try {
    const target = new URL(value, location.origin);
    return target.origin === location.origin ? `${target.pathname}${target.search}${target.hash}` : null;
  } catch {
    return null;
  }
}

function finishSignIn() {
  const target = returnTarget();
  if (target) location.assign(target);
}

function persistSessionFromRedirect() {
  const hash = new URLSearchParams(location.hash.replace(/^#/, ""));
  const accessToken = hash.get("access_token");
  if (!accessToken) return false;
  const session = {
    access_token: accessToken,
    refresh_token: hash.get("refresh_token"),
    expires_in: Number(hash.get("expires_in") || 0),
    expires_at: Math.floor(Date.now() / 1000) + Number(hash.get("expires_in") || 0),
    token_type: hash.get("token_type") || "bearer",
    provider_token: hash.get("provider_token"),
  };
  localStorage.setItem("aipi.auth", JSON.stringify(session));
  history.replaceState(null, "", `${location.pathname}${location.search}`);
  show("Signed in. Return to your project and run `aipi pair` when you need the outbound dashboard bridge.", "success");
  finishSignIn();
  return true;
}

persistSessionFromRedirect();

const providerButtons = [...document.querySelectorAll("[data-provider]")];
const enabledProviders = new Set((config().oauthProviders ?? []).map((provider) => provider.toLowerCase()));
for (const button of providerButtons) {
  if (!enabledProviders.has(button.dataset.provider.toLowerCase())) {
    button.hidden = true;
    continue;
  }
  button.addEventListener("click", () => {
    const { supabaseUrl } = config();
    if (!supabaseUrl) return show("Cloud auth is not configured yet.", "error");
    const redirectTo = `${location.origin}${location.pathname}`;
    const authorize = new URL(`${supabaseUrl.replace(/\/$/, "")}/auth/v1/authorize`);
    authorize.searchParams.set("provider", button.dataset.provider);
    authorize.searchParams.set("redirect_to", redirectTo);
    location.assign(authorize.href);
  });
}
if (!providerButtons.some((button) => !button.hidden)) {
  document.querySelector(".oauth-actions")?.setAttribute("hidden", "");
  document.querySelector(".auth-divider")?.setAttribute("hidden", "");
}

toggle.addEventListener("click", () => {
  signUp = !signUp;
  title.textContent = signUp ? "Create an account." : "Sign in.";
  submit.innerHTML = `${signUp ? "Create account" : "Sign in"} <span>↗</span>`;
  toggle.textContent = signUp ? "I already have an account" : "Create an account";
  show("");
});

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const { supabaseUrl, supabaseAnonKey } = config();
  if (!supabaseUrl || !supabaseAnonKey) {
    show("Cloud auth is not configured yet. Set SUPABASE_URL and SUPABASE_PUBLISHABLE_KEY in the deployment environment (SUPABASE_ANON_KEY is supported for legacy deployments).", "error");
    return;
  }
  submit.disabled = true;
  show("Connecting…");
  const data = Object.fromEntries(new FormData(form));
  const endpoint = signUp ? "/auth/v1/signup" : "/auth/v1/token?grant_type=password";
  try {
    const response = await fetch(`${supabaseUrl.replace(/\/$/, "")}${endpoint}`, {
      method: "POST",
      headers: { apikey: supabaseAnonKey, "content-type": "application/json" },
      body: JSON.stringify({ email: data.email, password: data.password })
    });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.msg || payload.error_description || payload.error || "Authentication failed");
    show(signUp ? "Check your email to confirm your account." : "Signed in. You can close this page and continue locally.", "success");
    if (!signUp && payload.access_token) {
      localStorage.setItem("aipi.auth", JSON.stringify(payload));
      finishSignIn();
    }
  } catch (error) {
    show(error.message, "error");
  } finally {
    submit.disabled = false;
  }
});
