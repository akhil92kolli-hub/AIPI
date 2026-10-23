import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dist = path.join(root, "dist");
const client = path.join(dist, "client");
const dashboard = path.join(client, "dashboard");
const dashboardSource = path.join(root, "..", "ui");

await fs.rm(dist, { recursive: true, force: true });
await fs.mkdir(path.join(dist, "server"), { recursive: true });
await fs.mkdir(client, { recursive: true });
await fs.mkdir(dashboard, { recursive: true });
await Promise.all(["index.html", "product.html", "roadmap.html", "integration-map.html", "workflow.html", "evidence.html", "security.html", "plans.html", "login.html", "oauth-consent.html", "install.html", "docs.html", "privacy.html", "terms.html", "support.html", "styles.css", "app.js", "auth.js", "aipi-logo.png"].map((file) => fs.copyFile(path.join(root, file), path.join(client, file))));
await build({
  entryPoints: [path.join(root, "oauth-consent.js")],
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "es2022",
  minify: true,
  outfile: path.join(client, "oauth-consent.js"),
});
await Promise.all(["app.js", "styles.css"].map((file) => fs.copyFile(path.join(dashboardSource, file), path.join(dashboard, file))));
const dashboardIndex = await fs.readFile(path.join(dashboardSource, "index.html"), "utf8");
await fs.writeFile(path.join(dashboard, "index.html"), dashboardIndex.replace('href="/styles.css"', 'href="/dashboard/styles.css"').replace('src="/app.js"', 'src="/dashboard/app.js"'));
await fs.copyFile(path.join(root, "aipi-logo.png"), path.join(client, "aipi-logo.png"));
await fs.writeFile(path.join(dist, "server", "index.js"), `export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/config.js") {
      return new Response("window.AIPI_CONFIG = " + JSON.stringify({
        supabaseUrl: env.SUPABASE_URL || "",
        supabaseAnonKey: env.SUPABASE_PUBLISHABLE_KEY || env.SUPABASE_ANON_KEY || "",
        oauthProviders: (env.OAUTH_PROVIDERS || "").split(",").map((provider) => provider.trim()).filter(Boolean)
      }) + ";\\n", {
        headers: {
          "content-type": "application/javascript; charset=utf-8",
          "cache-control": "no-store",
          "x-content-type-options": "nosniff"
        }
      });
    }
    if (url.pathname === "/oauth/consent" || url.pathname === "/oauth/consent/") {
      return env.ASSETS.fetch(new Request(new URL("/oauth-consent", url), request));
    }
    if (url.pathname === "/dashboard/projects" || url.pathname.startsWith("/dashboard/projects/")) {
      return env.ASSETS.fetch(new Request(new URL("/dashboard/", url), request));
    }
    const asset = await env.ASSETS.fetch(request);
    if (asset.status !== 404 || !url.pathname.startsWith("/dashboard/")) return asset;
    const leaf = url.pathname.split("/").at(-1) || "";
    if (leaf.includes(".")) return asset;
    return env.ASSETS.fetch(new Request(new URL("/dashboard/", url), request));
  }
};
`);

console.log("AI-PI production build ready");
