const fs = require('node:fs');
const path = require('node:path');
const {execFileSync} = require('node:child_process');
const root = path.resolve(__dirname, '..');
const repositoryRoot = path.resolve(root, '../..');
const dashboardRoot = path.resolve(root, '../..', 'ui');
const required = ['src/extension.cjs', 'src/CompanionClient.cjs', 'src/protocol.cjs', 'media/panel.html', 'media/activity.svg'];
for (const relative of required) if (!fs.existsSync(path.join(root, relative))) throw new Error(`Missing extension asset: ${relative}`);
for (const asset of ['app.js', 'styles.css', 'workspace-app.js', 'workspace-app.css', 'change-assessment-view.js', 'payload-lenses.js', 'contract-chain.js', 'workspace-explorer.js']) fs.copyFileSync(path.join(dashboardRoot, asset), path.join(root, 'media', asset));
fs.cpSync(path.join(dashboardRoot, 'assets'), path.join(root, 'media/assets'), {recursive:true});
fs.copyFileSync(path.join(root, '../../assets/icon.png'), path.join(root, 'media/aipi-logo.png'));
fs.copyFileSync(path.join(root, '../../LICENSE'), path.join(root, 'LICENSE'));
// Ship the same companion bits the npm package ships. A fresh VSIX must not depend on
// the version currently published to npm for Team Cloud pairing to work.
execFileSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['run', 'build'], {cwd:repositoryRoot, stdio:'inherit'});
const companionRoot = path.join(root, 'companion');
fs.rmSync(companionRoot, {recursive:true, force:true});
const companionFiles = [
  'scripts/aipi-cli-bundle.mjs', 'scripts/aipi-mcp-bundle.mjs',
  'scripts/aipi-observer-bundle.mjs', 'scripts/aipi-verify-bundle.mjs',
  'scripts/llhttp/llhttp.wasm',
  'ui/index.html', 'ui/app.js', 'ui/app-bundle.js', 'ui/styles.css', 'ui/payload-lenses.js',
  'ui/contract-chain.js', 'ui/workspace-explorer.js', 'ui/workspace-app.js', 'ui/workspace-app.css', 'ui/change-assessment-view.js', 'ui/aipi-logo.svg',
  'ui/aipi-logo.png'
];
for (const relative of companionFiles) {
  const destination = path.join(companionRoot, relative);
  fs.mkdirSync(path.dirname(destination), {recursive:true});
  fs.copyFileSync(path.join(repositoryRoot, relative), destination);
}
fs.cpSync(path.join(repositoryRoot, 'ui/assets'), path.join(companionRoot, 'ui/assets'), {recursive:true});
fs.writeFileSync(path.join(companionRoot, 'package.json'), JSON.stringify({name:'aipi-bundled-companion', version:require(path.join(repositoryRoot, 'package.json')).version, type:'module'}, null, 2));
for (const script of ['src/extension.cjs', 'src/CompanionClient.cjs', 'src/protocol.cjs', 'media/app.js']) execFileSync(process.execPath, ['--check', path.join(root, script)], {stdio:'inherit'});
fs.mkdirSync(path.join(root, 'dist'), {recursive:true});
console.log('AIPI IDE extension assets and bridge validated.');
