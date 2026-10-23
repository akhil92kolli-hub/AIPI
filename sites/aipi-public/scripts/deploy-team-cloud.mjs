import fs from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const site = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const configPath = path.join(site, "dist/server/wrangler.json");
const publishPath = path.join(site, "dist/server/wrangler-publish.json");
const config = JSON.parse(await fs.readFile(configPath, "utf8"));

// Keep the preview URL for existing OAuth clients while serving the Team app
// from its permanent custom domain. Vinext's legacy_env option is not
// supported by the root Wrangler version used for production deployment.
delete config.legacy_env;
const publicSite = process.argv.includes("--public");
config.name = publicSite ? "aipi" : "aipi-team-cloud";
config.workers_dev = true;
config.preview_urls = true;
config.routes = publicSite ? [{pattern:"aipi.website",custom_domain:true},{pattern:"www.aipi.website",custom_domain:true}] : [{ pattern: "app.aipi.website", custom_domain: true }];
await fs.writeFile(publishPath, `${JSON.stringify(config, null, 2)}\n`);

const wrangler = path.resolve(site, "../../node_modules/wrangler/bin/wrangler.js");
const result = spawnSync(process.execPath, [wrangler, "deploy", "--config", publishPath, "--no-autoconfig"], {
  cwd: site,
  stdio: "inherit",
});
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
