#!/usr/bin/env node

import { executeRequest } from "./api-forge-server.mjs";
import { startDashboard } from "./dashboard-server.mjs";

const dashboard = await startDashboard({ executeRequest });
process.stdout.write(`AIPI Local Companion: ${dashboard.url}\n`);
process.stdout.write(`AIPI session token: ${dashboard.token}\n`);

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => dashboard.server.close(() => process.exit(0)));
}
