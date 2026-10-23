import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { test } from 'node:test';
import { assessmentFixture } from './helpers/change-assessment-fixture.mjs';
import { assessLocalWorkspaceChange } from '../packages/core/change-assessment.mjs';
import { reviewAssessmentChecks } from '../packages/core/assessment-proof.mjs';
import { createVerificationPackageManifest, diagnoseVerificationPackage } from '../packages/core/verification-package.mjs';

const run = promisify(execFile);
const configured = fixture => {
  for (const project of fixture.state.projects) project.verification = {
    testCommand: { command: 'node', args: ['--test'], cwd: '.' },
    requiredEnvironmentVariables: ['AIPI_FIXTURE_URL'] };
};
const bindings = fixture => fixture.state.projects.map(project => ({ projectId: project.id,
  resourceId: project.sourceContext.roots[0].id, root: project.sourceContext.roots[0].path }));

test('clean committed source creates portable reviewed manifest and independent preflight without execution', async t => {
  const fixture = await assessmentFixture(t); configured(fixture);
  await fs.writeFile(path.join(fixture.root, 'app.py'), 'total = 101\n');
  await run('git', ['-C', fixture.root, 'add', '.']);
  await run('git', ['-C', fixture.root, 'commit', '-qm', 'compatible value']);
  const assessment = await assessLocalWorkspaceChange(fixture.input);
  const review = reviewAssessmentChecks({ assessment, state: fixture.state, canRunProject: () => true });
  const manifest = createVerificationPackageManifest({ assessment, review, state: fixture.state,
    canShareProject: () => true });
  assert.equal(manifest.sourceReproducible, true);
  assert.equal(manifest.complete, true);
  assert.equal(manifest.resources.length, 3);
  assert.ok(manifest.checks.some(check => check.projectId === 'billing'));
  assert.doesNotMatch(JSON.stringify(manifest), /aipi-assessment-|\/private\/|\/tmp\//);
  const ready = await diagnoseVerificationPackage(manifest, bindings(fixture), {
    env: { PATH: process.env.PATH, AIPI_FIXTURE_URL: 'http://127.0.0.1:1' } });
  assert.equal(ready.ready, true);
  assert.ok(ready.resources.every(resource => resource.status === 'ready'));
  assert.ok(ready.checks.every(check => check.status === 'ready'));
  assert.doesNotMatch(JSON.stringify(ready), /aipi-assessment-|127\.0\.0\.1/);
  const missing = await diagnoseVerificationPackage(manifest, bindings(fixture), { env: { PATH: '' } });
  assert.equal(missing.ready, false);
  assert.ok(missing.checks.every(check => check.missingVariableNames.includes('AIPI_FIXTURE_URL')));
  assert.doesNotMatch(JSON.stringify(missing), /aipi-assessment-/);
  const tampered = structuredClone(manifest);
  tampered.checks[0].command.args.push('--changed');
  await assert.rejects(diagnoseVerificationPackage(tampered, bindings(fixture)), /changed after export/);
  const unsafe = structuredClone(manifest);
  unsafe.checks[0].command.cwd = '../elsewhere';
  const { manifestHash: unused, ...unsigned } = unsafe;
  unsafe.manifestHash = `sha256:${crypto.createHash('sha256').update(JSON.stringify(unsigned)).digest('hex')}`;
  const unsafeResult = await diagnoseVerificationPackage(unsafe, bindings(fixture), {
    env: { PATH: process.env.PATH, AIPI_FIXTURE_URL: 'set' } });
  assert.equal(unsafeResult.ready, false);
  assert.ok(unsafeResult.checks.some(check => check.cwdContained === false));
});

test('dirty source and unavailable or unapproved resources cannot be called reproducible', async t => {
  const fixture = await assessmentFixture(t); configured(fixture);
  await fs.writeFile(path.join(fixture.root, 'app.py'), 'total = "101"\n');
  const assessment = await assessLocalWorkspaceChange(fixture.input);
  const review = reviewAssessmentChecks({ assessment, state: fixture.state, canRunProject: () => true });
  const manifest = createVerificationPackageManifest({ assessment, review, state: fixture.state,
    canShareProject: () => true });
  assert.equal(manifest.sourceReproducible, false);
  assert.equal(manifest.complete, false);
  assert.ok(manifest.gaps.some(gap => gap.includes('content snapshot')));
  const diagnostics = await diagnoseVerificationPackage(manifest, bindings(fixture), { env: { PATH: process.env.PATH, AIPI_FIXTURE_URL: 'set' } });
  assert.equal(diagnostics.ready, false);
  const denied = createVerificationPackageManifest({ assessment, review, state: fixture.state,
    canShareProject: id => id !== 'billing' });
  assert.equal(denied.complete, false);
  assert.ok(denied.gaps.some(gap => gap.includes('not approved')));
  assert.ok(denied.resources.every(resource => resource.projectId !== 'billing'));
  assert.ok(denied.checks.every(check => check.projectId !== 'billing'));
  assert.doesNotMatch(JSON.stringify(denied), /aipi-assessment-/);
});
