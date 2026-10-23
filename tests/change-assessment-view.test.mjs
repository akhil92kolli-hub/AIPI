import assert from 'node:assert/strict';
import { test } from 'node:test';
import { changeAssessmentPanelMarkup, changeAssessmentResultMarkup, changeAssessmentReviewMarkup } from '../ui/change-assessment-view.js';

test('assessment form uses explicit baseline and source selection without arbitrary paths or execution controls', () => {
  const markup = changeAssessmentPanelMarkup([{ id: 'orders', name: '<script>bad</script>',
    sourceContext: { roots: [{ kind: 'workspace', path: '/private/checkout' }] } }]);
  assert.match(markup, /name="baseline" value="HEAD"/);
  assert.match(markup, /name="source"/);
  assert.match(markup, /value="staged">Staged changes only/);
  assert.match(markup, /value="unstaged">Unstaged changes only/);
  assert.match(markup, /requires the current HEAD baseline/);
  assert.match(markup, /name="head"[^>]+disabled/);
  assert.match(markup, /&lt;script&gt;bad&lt;\/script&gt;/);
  assert.doesNotMatch(markup, /\/private\/checkout|<script>|Run tests/);
  assert.match(changeAssessmentPanelMarkup([]), /Register a local Git source/);
});

test('result preserves incomplete coverage, missing checks, stale dependencies and output omissions', () => {
  const markup = changeAssessmentResultMarkup({ comparison: { baseCommit: 'abc', headCommit: 'def', dirty: true,
    totalChangedFiles: 2, files: [{ status: 'R', path: '<img src=x>', previousPath: 'old.py' }] },
    evaluatedAt: '2026-10-21T12:00:00Z', verification: { status: 'unknown' },
    components: [{ projectId: 'billing', label: 'total', confidence: 'inferred', source: { path: 'app.py', line: 8 },
      paths: [[{ stale: true }]], coverage: { status: 'missing', checks: [{ kind: 'behavior', status: 'missing', reason: 'No selected check' }] } }],
    analysis: { gaps: ['Unmapped <source>'] }, identityLimitations: [], omitted: { components: 2 }, coverage: 'Only listed checks apply.' });
  assert.match(markup, /Assessment: unknown/); assert.match(markup, /assessment request did not run checks/);
  assert.match(markup, /Prior relationship evidence needs review/); assert.match(markup, /behavior: missing/);
  assert.match(markup, /Some details are omitted/); assert.match(markup, /&lt;img src=x&gt;/);
  assert.doesNotMatch(markup, /<img|Unmapped <source>/);
});

test('staged assessment labels its selected index snapshot accurately', () => {
  const markup = changeAssessmentResultMarkup({ comparison: { mode: 'staged', baseCommit: 'abc', headCommit: 'abc', dirty: true,
    totalChangedFiles: 1, files: [{ status: 'M', path: 'app.py' }] },
    evaluatedAt: '2026-10-22T12:00:00Z', verification: { status: 'unknown' }, components: [],
    analysis: { gaps: [] }, identityLimitations: [], omitted: {}, coverage: 'File-level assessment.' });
  assert.match(markup, /\+ staged changes/);
  assert.doesNotMatch(markup, /\+ working changes/);
});

test('unstaged assessment labels index-to-worktree changes accurately', () => {
  const markup = changeAssessmentResultMarkup({ comparison: { mode: 'unstaged', baseCommit: 'abc', headCommit: 'abc', dirty: true,
    totalChangedFiles: 1, files: [{ status: 'M', path: 'app.py' }] },
    evaluatedAt: '2026-10-22T12:00:00Z', verification: { status: 'unknown' }, components: [],
    analysis: { gaps: [] }, identityLimitations: [], omitted: {}, coverage: 'File-level assessment.' });
  assert.match(markup, /\+ unstaged changes/);
  assert.doesNotMatch(markup, /\+ working changes/);
  const indexOnly = changeAssessmentResultMarkup({ comparison: { mode: 'unstaged', baseCommit: 'abc', headCommit: 'abc', dirty: true,
    totalChangedFiles: 0, files: [] }, evaluatedAt: '2026-10-22T12:00:00Z', verification: { status: 'unknown' },
    components: [], analysis: { gaps: [] }, identityLimitations: [], omitted: {}, coverage: 'File-level assessment.' });
  assert.match(indexOnly, /index differs from HEAD; no unstaged files/);
  assert.doesNotMatch(indexOnly, /\+ unstaged changes/);
});

test('changed-line hints remain bounded and do not claim a semantic contract change', () => {
  const markup = changeAssessmentResultMarkup({ comparison: { mode: 'working-tree', baseCommit: 'abc', headCommit: 'abc', dirty: true,
    totalChangedFiles: 1, files: [{ status: 'M', path: 'app.py', lineRanges: [{ newStart: 8, newLines: 2 }] }] },
    evaluatedAt: '2026-10-22T12:00:00Z', verification: { status: 'unknown' },
    components: [{ projectId: 'orders', label: 'GET /orders', changed: true, changeLocation: 'indexed-line-overlap',
      confidence: 'confirmed', source: { path: 'app.py', line: 8, endLine: 12, rangeMethod: 'python-indentation-heuristic' }, paths: [], coverage: { status: 'missing', checks: [] } }],
    analysis: { gaps: [] }, identityLimitations: [], omitted: {}, coverage: 'File-level assessment.' });
  assert.match(markup, /changed new lines 8-9/);
  assert.match(markup, /semantic effect unconfirmed/);
  assert.match(markup, /heuristic span/);
  const ast = changeAssessmentResultMarkup({ comparison: { mode: 'working-tree', baseCommit: 'abc', headCommit: 'abc', dirty: true,
    totalChangedFiles: 1, files: [] }, evaluatedAt: '2026-10-22T12:00:00Z', verification: { status: 'unknown' },
    components: [{ projectId: 'storefront', label: 'checkout', changed: true, confidence: 'confirmed',
      source: { path: 'Checkout.tsx', line: 2, endLine: 4, rangeMethod: 'typescript-ast' }, paths: [],
      coverage: { status: 'missing', checks: [] } }], analysis: { gaps: [] }, identityLimitations: [], omitted: {}, coverage: '' });
  assert.match(ast, /AST span/);
  assert.doesNotMatch(ast, /heuristic span/);
});

test('review UI makes execution explicit and escapes configured commands', () => {
  const markup = changeAssessmentReviewMarkup({ checks: [{ projectId: 'orders', componentId: 'api',
    command: { command: 'node', args: ['<script>'], cwd: '.', timeoutMs: 1000 } }], gaps: [], note: 'Only this command.' });
  assert.match(markup, /data-run-assessment/);
  assert.match(markup, /data-export-assessment/);
  assert.match(markup, /data-share-assessment/);
  assert.match(markup, /&lt;script&gt;/);
  assert.doesNotMatch(markup, /<script>/);
});
