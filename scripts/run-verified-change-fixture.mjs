import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { assessLocalWorkspaceChange } from '../packages/core/change-assessment.mjs';
import { reviewAssessmentChecks, executeReviewedAssessment, acceptLocalAssessmentEvidence } from '../packages/core/assessment-proof.mjs';
import { createVerificationPackageManifest, diagnoseVerificationPackage } from '../packages/core/verification-package.mjs';
import { exportCleanVerificationSourceBundles, importCleanVerificationSourceBundles } from '../packages/core/verification-source-bundle.mjs';
import { attestLocalRegressionRelevance, acceptLocalRegressionRelevance } from '../packages/core/regression-relevance.mjs';
import { workspaceTargets, reviewWorkspaceRelationship } from '../packages/core/workspace-groups.mjs';
import { detectFromFile, executeLinkedTestCommand } from './dashboard-server.mjs';
import crypto from 'node:crypto';

const execute = promisify(execFile);
const source = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../fixtures/verified-change');
const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'aipi-verified-change-'));
const processes = [];
const roots = Object.fromEntries(['orders', 'billing', 'storefront'].map(id => [id, path.join(temp, id)]));
const originalPath = process.env.PATH;
let report;

async function run(command, args, options = {}) {
  return execute(command, args, { timeout: 180_000, maxBuffer: 2_000_000, ...options });
}

async function git(root, ...args) {
  return (await run('git', ['-C', root, ...args])).stdout.trim();
}

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

async function stop(service) {
  if (!service || service.exitCode !== null || service.signalCode !== null) return;
  service.kill('SIGTERM');
  let timer;
  await Promise.race([new Promise(resolve => service.once('exit', resolve)),
    new Promise(resolve => { timer = setTimeout(() => { service.kill('SIGKILL'); resolve(); }, 3000); })]);
  clearTimeout(timer);
}

async function startService(id, port, python, sourceRoots = roots) {
  const processHandle = spawn(python, ['-m', 'uvicorn', 'app:app', '--host', '127.0.0.1', '--port', String(port)], {
    cwd: sourceRoots[id], env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
  processes.push(processHandle);
  let output = '';
  for (const stream of [processHandle.stdout, processHandle.stderr]) stream.on('data', chunk => { output = `${output}${chunk}`.slice(-4000); });
  for (let attempt = 0; attempt < 100; attempt++) {
    if (processHandle.exitCode !== null) throw new Error(`${id} service exited: ${output}`);
    try { if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) return processHandle; }
    catch { /* wait for loopback listener */ }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`${id} service did not become healthy: ${output}`);
}

function project(id, revision, sourceRoots = roots) {
  const root = sourceRoots[id];
  const common = { id, name: id, activeEnvironmentId: 'dev', environments: [{ id: 'dev', variables: [] }],
    verification: { testCommand: id === 'storefront'
      ? { command: 'npm', args: ['test'], cwd: '.' }
      : { command: 'python', args: ['-m', 'pytest', '-q'], cwd: '.' } },
    sourceContext: { roots: [{ id: `${id}-root`, path: root, kind: 'workspace' }], gitRevision: revision,
      artifacts: [], schemas: [], integrations: [], endpoints: [], frontendCalls: [] },
    contracts: [], requests: [], tasks: [] };
  if (id === 'orders') {
    common.sourceContext.endpoints = [{ id: 'orders-handler', method: 'GET', path: '/orders/{order_id}', root, source: 'app.py', line: 12 }];
    common.contracts = [{ id: 'orders-response', method: 'GET', route: '/orders/{order_id}', currentRevisionId: 'v1',
      sourceArtifactIds: ['orders-handler'], implementation: { root, source: 'app.py', line: 12 } }];
  } else {
    common.sourceContext.frontendCalls = [{ id: `${id}-call`, method: 'GET', path: '/orders/order-1', root,
      source: id === 'storefront' ? 'src/Checkout.tsx' : 'test_billing.py', line: id === 'storefront' ? 6 : 7 }];
  }
  return common;
}

async function check(project) {
  const result = await executeLinkedTestCommand(project, project.verification.testCommand);
  const output = String(result.output ?? '');
  return { passed: result.passed, exitCode: result.exitCode,
    outputHash: `sha256:${crypto.createHash('sha256').update(output).digest('hex')}`,
    expectedAssertionObserved: output.includes('Orders total must be numeric') || output.includes('assert isinstance'),
    passMarkerObserved: /(?:\b1 passed\b|# pass 1\b)/.test(output) };
}

try {
  for (const id of Object.keys(roots)) {
    await fs.cp(path.join(source, id), roots[id], { recursive: true });
    await fs.writeFile(path.join(roots[id], '.gitignore'), 'node_modules/\n__pycache__/\n.pytest_cache/\n');
  }
  const venv = path.join(temp, 'venv');
  await run('python3', ['-m', 'venv', venv]);
  const bin = path.join(venv, process.platform === 'win32' ? 'Scripts' : 'bin');
  const python = path.join(bin, process.platform === 'win32' ? 'python.exe' : 'python');
  await run(python, ['-m', 'pip', 'install', '--disable-pip-version-check', '-r', path.join(source, 'requirements.txt')]);
  await run('npm', ['ci', '--no-audit', '--no-fund'], { cwd: roots.storefront });
  const pythonPackages = (await run(python, ['-m', 'pip', 'freeze'])).stdout.trim().split('\n').filter(line => /^(fastapi|uvicorn|httpx|pytest|pydantic)==/i.test(line)).sort();
  const frontendPackages = JSON.parse((await run('npm', ['ls', '--depth=0', '--json'], { cwd: roots.storefront })).stdout).dependencies;
  process.env.PATH = `${bin}${path.delimiter}${originalPath}`;
  const revisions = {};
  for (const [id, root] of Object.entries(roots)) {
    await git(root, 'init', '-q');
    await git(root, 'config', 'user.name', 'AIPI verified-change fixture');
    await git(root, 'config', 'user.email', 'fixture@example.test');
    await git(root, 'config', 'commit.gpgsign', 'false');
    await git(root, 'add', '.'); await git(root, 'commit', '-qm', 'known good');
    revisions[id] = await git(root, 'rev-parse', 'HEAD');
  }
  const state = { projects: Object.keys(roots).map(id => project(id, revisions[id])),
    workspaceGroups: [{ id: 'wsg_verified_change', name: 'Verified change fixture', version: 1, projectIds: Object.keys(roots) }] };
  const catalog = workspaceTargets(state, 'wsg_verified_change');
  const provider = catalog.find(target => target.ref.projectId === 'orders' && target.kind === 'api');
  for (const id of ['storefront', 'billing']) {
    const consumer = catalog.find(target => target.ref.projectId === id && target.kind === 'consumer');
    reviewWorkspaceRelationship(state, 'wsg_verified_change', { fromKey: consumer.key, toKey: provider.key,
      type: 'CALLS', status: 'approved', reviewer: 'Fixture setup', evidence: 'The consumer source calls the Orders endpoint.' });
  }
  const billingPort = await freePort(), ordersPort = await freePort();
  process.env.BILLING_URL = `http://127.0.0.1:${billingPort}`;
  process.env.ORDERS_URL = `http://127.0.0.1:${ordersPort}`;
  await startService('billing', billingPort, python);
  let ordersService = await startService('orders', ordersPort, python);
  const good = Object.fromEntries(await Promise.all(state.projects.map(async p => [p.id, await check(p)])));
  assert.ok(Object.values(good).every(result => result.passed), `Known-good checks failed: ${JSON.stringify(good)}`);
  const orderFile = path.join(roots.orders, 'app.py');
  const original = await fs.readFile(orderFile, 'utf8');
  const indexedHandler = detectFromFile(orderFile, roots.orders, original).endpoints
    .find(entry => entry.method === 'GET' && entry.path === '/orders/{order_id}');
  assert.ok(indexedHandler?.endLine && indexedHandler.contentHash && indexedHandler.rangeMethod);
  Object.assign(state.projects.find(p => p.id === 'orders').sourceContext.endpoints[0], {
    endLine: indexedHandler.endLine, contentHash: indexedHandler.contentHash,
    rangeMethod: indexedHandler.rangeMethod,
  });
  const goodLine = "return {'id': order_id, 'total': total, 'currency': 'USD'}";
  assert.ok(original.includes(goodLine));
  await fs.writeFile(orderFile, original.replace(goodLine,
    "return {'id': order_id, 'total': f'{total:.2f}', 'currency': 'USD'}"));
  await stop(ordersService); ordersService = await startService('orders', ordersPort, python);
  const broken = Object.fromEntries(await Promise.all(state.projects.map(async p => [p.id, await check(p)])));
  assert.ok(Object.values(broken).every(result => !result.passed), `Expected all consumer checks to fail: ${JSON.stringify(broken)}`);
  state.projects.find(p => p.id === 'billing').verification = {};
  const input = { state, workspaceId: 'wsg_verified_change', projectId: 'orders', baseRef: revisions.orders,
    canReadProject: () => true };
  const brokenAssessment = await assessLocalWorkspaceChange(input);
  assert.deepEqual([...new Set(brokenAssessment.components.map(item => item.projectId))].sort(), ['billing', 'orders', 'storefront']);
  assert.ok(brokenAssessment.components.some(item => item.projectId === 'orders' && item.kind === 'api'
    && item.changeLocation === 'indexed-symbol-overlap'));
  const brokenReview = reviewAssessmentChecks({ assessment: brokenAssessment, state, canRunProject: () => true });
  assert.ok(brokenReview.gaps.some(gap => gap.includes('no configured')));
  const signingKey = crypto.randomBytes(32);
  const failed = await executeReviewedAssessment({ assessment: brokenAssessment, state, canRunProject: () => true,
    approvedReviewHash: brokenReview.reviewHash, signingKey,
    executeCheck: (p, command) => executeLinkedTestCommand(p, command) });
  assert.ok(failed.receipts.every(receipt => receipt.status === 'failed'));
  state.projects.find(p => p.id === 'billing').verification = { testCommand: { command: 'python', args: ['-m', 'pytest', '-q'], cwd: '.' } };
  await git(roots.orders, 'add', 'app.py');
  await git(roots.orders, 'commit', '-qm', 'break numeric total contract');
  const badCommit = await git(roots.orders, 'rev-parse', 'HEAD');
  const badCommittedAssessment = await assessLocalWorkspaceChange({ ...input, changeId: brokenAssessment.changeId });
  const badCommittedReview = reviewAssessmentChecks({ assessment: badCommittedAssessment, state, canRunProject: () => true });
  const badCommittedRun = await executeReviewedAssessment({ assessment: badCommittedAssessment, state, canRunProject: () => true,
    approvedReviewHash: badCommittedReview.reviewHash, signingKey,
    executeCheck: (p, command) => executeLinkedTestCommand(p, command) });
  assert.ok(badCommittedRun.receipts.every(receipt => receipt.status === 'failed'));
  const badPackage = createVerificationPackageManifest({ assessment: badCommittedAssessment, review: badCommittedReview,
    state, canShareProject: () => true, receiptIds: badCommittedRun.receipts.map(receipt => receipt.id) });
  assert.equal(badPackage.sourceReproducible, true);
  assert.equal(badPackage.complete, true);
  const sourceBindings = Object.entries(roots).map(([projectId, root]) => ({ projectId, resourceId: `${projectId}-root`, root }));
  const badBundles = await exportCleanVerificationSourceBundles({ manifest: badPackage,
    bindings: sourceBindings, outputDirectory: path.join(temp, 'bundles-bad'), approveHistory: () => true });
  await fs.writeFile(orderFile, original.replace(goodLine,
    "return {'id': order_id, 'total': total, 'currency': 'USD', 'version': 2}"));
  await stop(ordersService); ordersService = await startService('orders', ordersPort, python);
  const repairedAssessment = await assessLocalWorkspaceChange({ ...input, changeId: brokenAssessment.changeId });
  const repairedReview = reviewAssessmentChecks({ assessment: repairedAssessment, state, canRunProject: () => true });
  assert.ok(repairedReview.checks.some(check => check.projectId === 'billing'));
  const repaired = await executeReviewedAssessment({ assessment: repairedAssessment, state, canRunProject: () => true,
    approvedReviewHash: repairedReview.reviewHash, signingKey,
    executeCheck: (p, command) => executeLinkedTestCommand(p, command) });
  assert.ok(repaired.receipts.every(receipt => receipt.status === 'passed'));
  const stale = await assessLocalWorkspaceChange({ ...input, changeId: brokenAssessment.changeId,
    receipts: failed.receipts, acceptReceipt: receipt => acceptLocalAssessmentEvidence(receipt, signingKey, failed.evidence) });
  assert.ok(stale.ledger.components.some(component => component.checks.some(check => check.status === 'stale')));
  await git(roots.orders, 'add', 'app.py');
  await git(roots.orders, 'commit', '-qm', 'restore numeric total contract');
  const repairedCommit = await git(roots.orders, 'rev-parse', 'HEAD');
  const repairedCommittedAssessment = await assessLocalWorkspaceChange({ ...input, changeId: brokenAssessment.changeId });
  const repairedCommittedReview = reviewAssessmentChecks({ assessment: repairedCommittedAssessment, state, canRunProject: () => true });
  const repairedCommittedRun = await executeReviewedAssessment({ assessment: repairedCommittedAssessment, state, canRunProject: () => true,
    approvedReviewHash: repairedCommittedReview.reviewHash, signingKey,
    executeCheck: (p, command) => executeLinkedTestCommand(p, command) });
  assert.ok(repairedCommittedRun.receipts.every(receipt => receipt.status === 'passed'));
  const repairedPackage = createVerificationPackageManifest({ assessment: repairedCommittedAssessment, review: repairedCommittedReview,
    state, canShareProject: () => true, receiptIds: repairedCommittedRun.receipts.map(receipt => receipt.id) });
  assert.equal(repairedPackage.sourceReproducible, true);
  assert.equal(repairedPackage.complete, true);
  const repairedBundles = await exportCleanVerificationSourceBundles({ manifest: repairedPackage,
    bindings: sourceBindings, outputDirectory: path.join(temp, 'bundles-repaired'), approveHistory: () => true });

  // Source is imported only from approved, content-addressed bundles. No
  // original repository path is needed in the second checkout.
  const imported = await importCleanVerificationSourceBundles({ manifest: badPackage,
    bundleManifest: badBundles, artifactDirectory: path.join(temp, 'bundles-bad'),
    destinationDirectory: path.join(temp, 'second'), approveImport: () => true });
  const secondRoots = Object.fromEntries(imported.map(item => [item.projectId, item.root]));
  const secondVenv = path.join(temp, 'second-venv');
  await run('python3', ['-m', 'venv', secondVenv]);
  const secondBin = path.join(secondVenv, process.platform === 'win32' ? 'Scripts' : 'bin');
  const secondPython = path.join(secondBin, process.platform === 'win32' ? 'python.exe' : 'python');
  await run(secondPython, ['-m', 'pip', 'install', '--disable-pip-version-check', '-r', path.join(source, 'requirements.txt')]);
  await run('npm', ['ci', '--no-audit', '--no-fund'], { cwd: secondRoots.storefront });
  process.env.PATH = `${secondBin}${path.delimiter}${originalPath}`;
  const bindings = imported.map(item => ({ projectId: item.projectId, resourceId: item.resourceId, root: item.root }));
  const badPreflight = await diagnoseVerificationPackage(badPackage, bindings);
  assert.equal(badPreflight.ready, true, JSON.stringify(badPreflight));
  const secondBillingPort = await freePort(), secondOrdersPort = await freePort();
  process.env.BILLING_URL = `http://127.0.0.1:${secondBillingPort}`;
  process.env.ORDERS_URL = `http://127.0.0.1:${secondOrdersPort}`;
  await startService('billing', secondBillingPort, secondPython, secondRoots);
  let secondOrdersService = await startService('orders', secondOrdersPort, secondPython, secondRoots);
  const secondProjects = Object.fromEntries(Object.keys(secondRoots).map(id => [id, project(id, revisions[id], secondRoots)]));
  async function executeImportedChecks(manifest) {
    const outcomes = [];
    for (const item of manifest.checks) {
      const result = await executeLinkedTestCommand(secondProjects[item.projectId], {
        command: item.command.executable, args: item.command.args, cwd: item.command.cwd,
        timeoutMs: item.command.timeoutMs, repositoryRoot: secondRoots[item.projectId] });
      outcomes.push({ projectId: item.projectId, componentId: item.componentId,
        requirementId: item.requirementId, passed: result.passed, exitCode: result.exitCode,
        timedOut: result.timedOut === true,
        behaviorAssertionObserved: String(result.output ?? '').includes('Orders total must be numeric')
          || String(result.output ?? '').includes('assert isinstance'),
        passMarkerObserved: /(?:\b1 passed\b|# pass 1\b)/.test(String(result.output ?? '')),
        outputHash: `sha256:${crypto.createHash('sha256').update(String(result.output ?? '')).digest('hex')}` });
    }
    return outcomes;
  }
  const reproducedBad = await executeImportedChecks(badPackage);
  assert.ok(reproducedBad.length > 0 && reproducedBad.every(item => !item.passed));
  await stop(secondOrdersService);
  const repairedOrdersArtifact = repairedBundles.artifacts.find(item => item.projectId === 'orders');
  await git(secondRoots.orders, 'fetch', '--quiet', path.join(temp, 'bundles-repaired', repairedOrdersArtifact.file), 'HEAD');
  await git(secondRoots.orders, 'checkout', '-q', '--detach', repairedCommit);
  secondOrdersService = await startService('orders', secondOrdersPort, secondPython, secondRoots);
  const repairedPreflight = await diagnoseVerificationPackage(repairedPackage, bindings);
  assert.equal(repairedPreflight.ready, true, JSON.stringify(repairedPreflight));
  const reproducedRepair = await executeImportedChecks(repairedPackage);
  assert.ok(reproducedRepair.length > 0 && reproducedRepair.every(item => item.passed));
  const relevanceAttestation = attestLocalRegressionRelevance({ knownBad: badPackage,
    repaired: repairedPackage, knownBadResults: reproducedBad,
    repairedResults: reproducedRepair, knownBadReceipts: badCommittedRun.receipts,
    repairedReceipts: repairedCommittedRun.receipts, signingKey });
  assert.ok(repairedCommittedRun.receipts.every(receipt =>
    acceptLocalRegressionRelevance(receipt, relevanceAttestation, signingKey)));
  const relevantAssessment = await assessLocalWorkspaceChange({ ...input,
    changeId: brokenAssessment.changeId, receipts: repairedCommittedRun.receipts,
    acceptReceipt: receipt => acceptLocalAssessmentEvidence(receipt, signingKey, repairedCommittedRun.evidence),
    acceptRelevance: receipt => acceptLocalRegressionRelevance(receipt, relevanceAttestation, signingKey) });
  assert.ok(relevantAssessment.ledger.components.every(component => component.checks
    .filter(check => check.kind === 'behavior' && check.required).every(check => check.status === 'passed')));
  assert.equal(relevantAssessment.ledger.status, 'unknown');
  report = { scenario: 'local verified change', testedAt: new Date().toISOString(), revisions,
    testedRevisions: { knownBad: badCommit, repaired: repairedCommit },
    environment: { node: process.version, python: (await run(python, ['--version'])).stdout.trim(),
      pythonPackages, frontendPackages: Object.fromEntries(Object.entries(frontendPackages).map(([name, info]) => [name, info.version])) },
    knownGood: good, broken,
    brokenAssessment: { changedFiles: brokenAssessment.comparison.files, affected: brokenAssessment.components.map(c => c.projectId),
      changedHandlerLocated: brokenAssessment.components.some(item => item.projectId === 'orders' && item.kind === 'api'
        && item.changeLocation === 'indexed-symbol-overlap'),
      ledger: failed.ledger.status, billingCheckMissing: brokenReview.gaps.length > 0,
      receiptIds: failed.receipts.map(receipt => receipt.id), evidenceIds: failed.evidence.map(item => item.id) },
    repairedAssessment: { affected: repairedAssessment.components.map(c => c.projectId),
      checkResults: repaired.receipts.map(receipt => ({ projectId: receipt.projectId, status: receipt.status })),
      ledger: repaired.ledger.status, complete: repaired.ledger.complete, previousProofStale: stale.ledger.components.some(component => component.checks.some(check => check.status === 'stale')),
      receiptIds: repaired.receipts.map(receipt => receipt.id), evidenceIds: repaired.evidence.map(item => item.id) },
    independentReproduction: { packageHashes: { knownBad: badPackage.manifestHash, repaired: repairedPackage.manifestHash },
      bundleManifestHashes: { knownBad: badBundles.bundleManifestHash, repaired: repairedBundles.bundleManifestHash },
      importedFromContentAddressedBundles: imported.length === 3,
      cleanSourcePackages: badPackage.sourceReproducible && repairedPackage.sourceReproducible,
      preflightReady: badPreflight.ready && repairedPreflight.ready,
      knownBadResults: reproducedBad, repairedResults: reproducedRepair,
      relevance: { attestationId: relevanceAttestation.id,
        checkStatuses: relevantAssessment.ledger.components.flatMap(component => component.checks
          .filter(check => check.kind === 'behavior' && check.required).map(check => ({ projectId: component.projectId, status: check.status }))),
        overallLedgerStatus: relevantAssessment.ledger.status },
      runner: 'fixture-initiated explicit execution of imported command arrays in separate Git clones and an independent Python environment' },
    limitations: ['Orders handler range and source hash come from the scanner; consumer associations and cross-project links are seeded from inspected fixture code.',
      'The local defect/repair contrast has a signed relevance attestation; independent consumer discovery and complete analysis coverage remain unproven.',
      'Generated manifests and temporary Git repositories are removed after the run; this record alone cannot replay their commits.',
      'Team synchronization, repository rights, an agent and PR evidence were not exercised.'] };
  const physicalTemp = await fs.realpath(temp);
  const safeReport = JSON.stringify(report, null, 2).replaceAll(physicalTemp, '[TEMP_REPO]').replaceAll(temp, '[TEMP_REPO]')
    .replace(/\/aipi-verified-change-[A-Za-z0-9_-]+(?=\/)/g, '[TEMP_REPO]');
  const reportAt = process.argv.indexOf('--report');
  if (reportAt >= 0) {
    const destination = process.argv[reportAt + 1];
    if (!destination) throw new Error('--report requires an output path');
    await fs.mkdir(path.dirname(path.resolve(destination)), { recursive: true });
    await fs.writeFile(destination, `${safeReport}\n`);
  }
  process.stdout.write(`${safeReport}\n`);
} finally {
  for (const service of processes.reverse()) await stop(service);
  process.env.PATH = originalPath;
  await fs.rm(temp, { recursive: true, force: true });
}
