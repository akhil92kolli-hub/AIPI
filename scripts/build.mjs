import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dist = path.join(root, "dist");
const client = path.join(dist, "client");
const dashboard = path.join(client, "dashboard");
const dashboardSource = path.join(root, "..", "ui");

await fs.rm(dist, { recursive: true, force: true });
await fs.mkdir(path.join(dist, "server"), { recursive: true });
await fs.mkdir(client, { recursive: true });
await fs.mkdir(dashboard, { recursive: true });
await Promise.all(["index.html", "product.html", "roadmap.html", "integration-map.html", "workflow.html", "evidence.html", "security.html", "plans.html", "login.html", "install.html", "styles.css", "app.js", "auth.js", "aipi-logo.svg"].map((file) => fs.copyFile(path.join(root, file), path.join(client, file))));
await Promise.all(["app.js", "styles.css"].map((file) => fs.copyFile(path.join(dashboardSource, file), path.join(dashboard, file))));
const dashboardIndex = await fs.readFile(path.join(dashboardSource, "index.html"), "utf8");
await fs.writeFile(path.join(dashboard, "index.html"), dashboardIndex.replace('href="/styles.css"', 'href="/dashboard/styles.css"').replace('src="/app.js"', 'src="/dashboard/app.js"'));
await fs.copyFile(path.join(root, "aipi-logo.svg"), path.join(client, "aipi-logo.svg"));
await fs.writeFile(path.join(client, "config.js"), `window.AIPI_CONFIG = ${JSON.stringify({
  supabaseUrl: process.env.SUPABASE_URL ?? "",
  supabaseAnonKey: process.env.SUPABASE_ANON_KEY ?? ""
})};\n`);
await fs.writeFile(path.join(dist, "server", "index.js"), `export default {\n  async fetch(request, env) {\n    return env.ASSETS.fetch(request);\n  }\n};\n`);

console.log("AI-PI production build ready");
