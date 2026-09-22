import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dist = path.join(root, "dist");
const client = path.join(dist, "client");

await fs.rm(dist, { recursive: true, force: true });
await fs.mkdir(path.join(dist, "server"), { recursive: true });
await fs.mkdir(client, { recursive: true });
await Promise.all(["index.html", "styles.css", "app.js"].map((file) => fs.copyFile(path.join(root, file), path.join(client, file))));
await fs.writeFile(path.join(dist, "server", "index.js"), `export default {\n  async fetch(request, env) {\n    return env.ASSETS.fetch(request);\n  }\n};\n`);

console.log("AI-PI production build ready");
