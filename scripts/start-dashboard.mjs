#!/usr/bin/env node

import { executeRequest } from "./api-forge-server.mjs";
import { startDashboard } from "./dashboard-server.mjs";

const dashboard = await startDashboard({ executeRequest });
process.stdout.write(`API Forge dashboard: ${dashboard.url}\n`);

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => dashboard.server.close(() => process.exit(0)));
}
