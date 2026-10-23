#!/usr/bin/env node

import { mkdir, readFile, rm } from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = path.join(root, "plugin", "aipi");
const outputDir = path.join(root, "dist", "plugins");
const manifest = JSON.parse(await readFile(path.join(source, "plugin.json"), "utf8"));
const output = path.join(outputDir, `aipi-${manifest.version}.zip`);

await mkdir(outputDir, { recursive: true });
await rm(output, { force: true });

await new Promise((resolve, reject) => {
  const child = spawn("zip", ["-q", "-r", output, "."], { cwd: source, stdio: "inherit" });
  child.on("error", reject);
  child.on("exit", (code) => code === 0 ? resolve() : reject(new Error(`zip exited with ${code}`)));
});

console.log(output);
