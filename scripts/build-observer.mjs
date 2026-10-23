import { build } from "esbuild";
import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";

await build({
  entryPoints: [fileURLToPath(new URL("./aipi-observer-hook.mjs", import.meta.url))],
  outfile: fileURLToPath(new URL("./aipi-observer-bundle.mjs", import.meta.url)),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  banner: { js: "import { createRequire as _aipiCreateRequire } from 'node:module'; const require = _aipiCreateRequire(import.meta.url);" },
});

// The socket interceptor loads this binary relative to import.meta.url. JS
// bundling cannot discover that runtime file access, so ship it beside the bundle.
const parser = new URL("./llhttp/llhttp.wasm", import.meta.resolve("@mswjs/interceptors"));
const output = new URL("./llhttp/", import.meta.url);
await fs.mkdir(output, { recursive: true });
await fs.copyFile(parser, new URL("llhttp.wasm", output));
