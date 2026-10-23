import fs from 'node:fs/promises';
import path from 'node:path';
const root = path.resolve(import.meta.dirname, '..');
const site = path.join(root, 'sites/aipi-public');
const extension = path.join(root, 'extensions/vscode');
await fs.mkdir(path.join(site, 'lib'), {recursive:true});
await fs.mkdir(path.join(site, 'public'), {recursive:true});
await fs.copyFile(path.join(root, 'ui/workspace-app.js'), path.join(site, 'lib/workspace-app.js'));
await fs.copyFile(path.join(root, 'packages/core/workspace-provider.mjs'), path.join(site, 'lib/workspace-provider.mjs'));
await fs.copyFile(path.join(root, 'ui/workspace-app.css'), path.join(site, 'public/workspace-app.css'));
// The browser dashboard and the IDE companion must consume the same
// presentation source. Keep the checked-in companion assets synchronized too;
// the extension build then packages these exact files into its webview.
for (const target of [path.join(extension, 'companion', 'ui'), path.join(extension, 'media')]) {
  await fs.copyFile(path.join(root, 'ui/workspace-app.js'), path.join(target, 'workspace-app.js'));
  await fs.copyFile(path.join(root, 'ui/workspace-app.css'), path.join(target, 'workspace-app.css'));
}
