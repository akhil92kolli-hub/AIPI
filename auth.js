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
    show("Cloud auth is not configured yet. Set SUPABASE_URL and SUPABASE_ANON_KEY in the deployment environment.", "error");
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
    if (!signUp && payload.access_token) localStorage.setItem("aipi.auth", JSON.stringify(payload));
  } catch (error) {
    show(error.message, "error");
  } finally {
    submit.disabled = false;
  }
});
