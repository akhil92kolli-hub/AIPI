# AIPI Antigravity Plugin

This bundle provides the AIPI local companion MCP server, repository guidance, and an API intelligence skill for Antigravity agents.

Build the installable archive from the repository root with:

```sh
npm run package:antigravity
```

The archive is written to `dist/antigravity/aipi.zip`. Its MCP entry runs `@vmise/aipi-companion` through `npx` and therefore requires Node.js 22 or later and network access when first launched.
