#!/usr/bin/env node
import fs from 'node:fs/promises';
import { diagnoseVerificationPackage } from '../packages/core/verification-package.mjs';

const [manifestFile, bindingsFile] = process.argv.slice(2);
if (!manifestFile || !bindingsFile) {
  process.stderr.write('Usage: node scripts/aipi-package-preflight.mjs MANIFEST.json BINDINGS.json\n');
  process.exitCode = 2;
} else {
  try {
    const manifest = JSON.parse(await fs.readFile(manifestFile, 'utf8'));
    const bindings = JSON.parse(await fs.readFile(bindingsFile, 'utf8'));
    const result = await diagnoseVerificationPackage(manifest, bindings);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    if (!result.ready) process.exitCode = 1;
  } catch (error) {
    process.stderr.write(`Package preflight failed: ${error.message}\n`);
    process.exitCode = 2;
  }
}
