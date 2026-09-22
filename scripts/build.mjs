import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dist = path.join(root, "dist");
const client = path.join(dist, "client");

await fs.rm(dist, { recursive: true, force: true });
await fs.mkdir(path.join(dist, "server"), { recursive: true });
await fs.mkdir(client, { recursive: true });
await Promise.all(["index.html", "product.html", "roadmap.html", "integration-map.html", "workflow.html", "evidence.html", "security.html", "plans.html", "login.html", "styles.css", "app.js", "auth.js"].map((file) => fs.copyFile(path.join(root, file), path.join(client, file))));
await fs.writeFile(path.join(client, "config.js"), `window.AIPI_CONFIG = ${JSON.stringify({
  supabaseUrl: process.env.SUPABASE_URL ?? "",
  supabaseAnonKey: process.env.SUPABASE_ANON_KEY ?? ""
})};\n`);
await fs.writeFile(path.join(dist, "server", "index.js"), `export default {\n  async fetch(request, env) {\n    return env.ASSETS.fetch(request);\n  }\n};\n`);

console.log("AI-PI production build ready");
