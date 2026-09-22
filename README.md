# AI-PI

AI-PI is the API Forge product showcase: from failing API to verified code fix.

## Build

```bash
npm run build
```

The production site is generated in `dist/client`, with the Worker entry point at `dist/server/index.js`.

## Cloudflare Workers

Use these Git build settings:

- Build command: `npm run build`
- Deploy command: `npm run deploy`
- Root directory: `/`

The deploy script explicitly selects `wrangler.jsonc` and disables auto-configuration.
That configuration restricts static assets to `dist/client`. Do not add
`--assets .` to the deploy command: it uploads the repository root and can include
large dependency binaries such as `node_modules/workerd/bin/workerd`.
