# Executable verified-change fixture

This local fixture uses one React checkout and two FastAPI services. Orders reads a price from Billing and returns a numeric `total`; the React checkout and Billing's downstream consumer test both require that number. Changing Orders to return a string makes all three checks fail against the running service.

`requirements.txt` and `storefront/package.json` describe disposable test dependencies. The scenario runner copies these files into temporary Git repositories and starts both services on loopback. It never alters the checked-in fixture. It seeds explicit source associations and reviewed cross-project links while semantic discovery remains under development. It does not exercise Team users, synchronization, GitHub or an agent.

From the repository root, run `node scripts/run-verified-change-fixture.mjs`. It needs Python 3 with `venv`, npm, Git and network access for the first dependency install. To retain a local run record, append `--report docs/evidence/verified-change-local-YYYY-MM-DD.json`. Temporary checkouts, dependencies and services are removed on exit.

The local AIPI assessment panel can export a reviewed JSON package manifest after explicit source and command sharing selection. Clean commits can be rebound on another checkout; dirty source is flagged incomplete until an approved source snapshot exists. On another machine, provide a bindings JSON array such as `[{"projectId":"orders","resourceId":"orders-root","root":"/local/orders"}]` and run `node scripts/aipi-package-preflight.mjs package.json bindings.json`. Preflight checks checkout revisions, command availability, contained working directories and environment variable names. It does not install dependencies or execute checks.
