import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sources = [
  'ui/workspace-app.js',
  'sites/aipi-public/lib/workspace-app.js',
  'extensions/vscode/companion/ui/workspace-app.js',
  'extensions/vscode/media/workspace-app.js',
].map((entry) => path.join(root, entry));
const styles = [
  'ui/workspace-app.css',
  'sites/aipi-public/public/workspace-app.css',
  'extensions/vscode/companion/ui/workspace-app.css',
  'extensions/vscode/media/workspace-app.css',
].map((entry) => path.join(root, entry));

async function assertIdentical(files, label) {
  const expected = await fs.readFile(files[0], 'utf8');
  for (const file of files.slice(1)) {
    assert.equal(await fs.readFile(file, 'utf8'), expected, `${label} drifted: ${path.relative(root, file)}`);
  }
}

await assertIdentical(sources, 'shared workspace presentation');
await assertIdentical(styles, 'shared workspace styles');
await assertIdentical([
  path.join(root, 'packages/core/workspace-provider.mjs'),
  path.join(root, 'sites/aipi-public/lib/workspace-provider.mjs'),
], 'Team workspace provider');
console.log('Shared workspace presentation and styles are synchronized across local, IDE, and cloud surfaces');
