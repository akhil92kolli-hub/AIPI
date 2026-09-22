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
- Deploy command: `npx wrangler deploy`
- Root directory: `/`

Do not deploy with `--assets .`; that uploads the repository root and can include `node_modules`. The checked-in `wrangler.jsonc` restricts static assets to `dist/client`.
