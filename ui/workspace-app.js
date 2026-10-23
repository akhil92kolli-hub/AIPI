// Presentation shared by the local browser, IDE webview, and Team browser.
// Providers supply workspace-scoped projections and explicit capability states.
export const WORKSPACE_TABS = [
  ['home', 'Home'], ['explore', 'Explore'], ['tasks', 'Tasks'], ['kmaps', 'K-Maps'], ['tools', 'Tools'],
];

const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
}[char]));

const card = (title, detail, meta = '', actionAttr = '') =>
  `<article class="workspace-view-card"${actionAttr ? ` ${actionAttr}` : ''}><strong>${escapeHtml(title)}</strong><span>${escapeHtml(detail)}</span>${meta ? `<small>${escapeHtml(meta)}</small>` : ''}</article>`;

const evidenceStates = new Set(['passed', 'failed', 'missing', 'stale', 'unknown']);
const evidenceState = (value) => evidenceStates.has(value) ? value : 'unknown';

const DELTA_EFFECT_LABELS = {
  breaking_candidate: 'Breaking candidate',
  breaking: 'Breaking candidate',
  additive_candidate: 'Additive candidate',
  additive: 'Additive candidate',
  internal_change: 'Internal change',
  internal: 'Internal change',
  unknown: 'Effect unknown',
};

const deltaEffectLabel = (effect) => DELTA_EFFECT_LABELS[String(effect ?? '').toLowerCase()] ?? 'Effect unknown';

const EVIDENCE_CLASS_LABELS = {
  extracted: 'Extracted',
  observed: 'Observed by a trusted check',
  suggested: 'Suggested',
  declared: 'Declared — awaiting validation',
};

const HANDOFF_STATES = new Set([
  'Prepared',
  'Opening agent',
  'Chat opened',
  'Agent acknowledged',
  'Working',
  'Blocked',
  'Verification pending',
  'Verified at these revisions',
  'Saved / copied — open your agent to continue',
]);

/**
 * Fallback for browsers/WebViews without native HTMLDialogElement.prototype.closedBy support.
 */
export function bindLightDismissDialog(dialog) {
  if (!dialog || typeof HTMLDialogElement === 'undefined') return;
  if (!('closedBy' in HTMLDialogElement.prototype)) {
    dialog.addEventListener('click', (event) => {
      if (event.target !== dialog) return;
      const rect = dialog.getBoundingClientRect();
      const isDialogContent = (
        rect.top <= event.clientY &&
        event.clientY <= rect.top + rect.height &&
        rect.left <= event.clientX &&
        event.clientX <= rect.left + rect.width
      );
      if (isDialogContent) return;
      dialog.close();
    });
  }
}

export function workspacePublicationReviewMarkup(assessment, { existingTasks = [], unresolvedConsumers = [], acknowledgment = null } = {}) {
  if (!assessment) return '';
  const comparison = assessment.comparison ?? {};
  const components = Array.isArray(assessment.components) ? assessment.components : [];
  const unknowns = [...(assessment.verification?.limitations ?? []), ...(assessment.analysis?.gaps ?? []), ...(assessment.identityLimitations ?? [])];
  const sourceSummary = comparison.baseCommit || comparison.headCommit
    ? `${String(comparison.baseCommit ?? 'unknown').slice(0, 12)} → ${String(comparison.headCommit ?? 'working changes').slice(0, 12)}`
    : 'Working changes';
  const staleBanner = acknowledgment?.stale
    ? '<p class="workspace-pub-stale-banner" role="alert"><strong>Change updated — review again.</strong> Source or graph scope changed after the previous acknowledgment.</p>'
    : '';
  const unresolvedItems = unresolvedConsumers.map((item) =>
    `<li><strong>${escapeHtml(item.projectName ?? item.projectId)}</strong> · <span class="workspace-citation-unresolved" data-citation-state="unresolved">Source citation unresolved</span></li>`
  ).join('');
  const existingTaskItems = existingTasks.map((t) =>
    `<li><label><input type="checkbox" name="linkTaskId" value="${escapeHtml(t.id)}" checked/> Link existing task: <strong>${escapeHtml(t.title)}</strong> (${escapeHtml(t.status)})</label></li>`
  ).join('');
  const componentItems = components.map((c) =>
    `<li><strong>${escapeHtml(c.projectId ?? 'Project')} · ${escapeHtml(c.label ?? c.componentId ?? 'Component')}</strong> — ${escapeHtml(evidenceState(c.coverage?.status))}</li>`
  ).join('');

  return `<dialog class="workspace-publication-dialog" closedby="any" aria-labelledby="workspace-pub-dialog-title" data-publication-review-dialog>
    <form method="dialog" class="workspace-publication-sheet" data-publication-review-form>
      <header>
        <small>Publication review</small>
        <h2 id="workspace-pub-dialog-title">Review sharing &amp; follow-up work</h2>
        <p>Revision scope: <code>${escapeHtml(sourceSummary)}</code></p>
      </header>
      ${staleBanner}
      <p class="workspace-pub-copy">Sharing records the unresolved impact. Merge and deployment checks remain independent.</p>
      <section>
        <h3>Known affected components (${components.length})</h3>
        ${componentItems ? `<ul>${componentItems}</ul>` : '<p class="workspace-empty-hint">No deterministic downstream consumers matched.</p>'}
        ${unresolvedItems ? `<ul>${unresolvedItems}</ul>` : ''}
      </section>
      ${unknowns.length ? `<section><h3>Explicit unknowns (${unknowns.length})</h3><ul>${unknowns.map((u) => `<li>${escapeHtml(u)}</li>`).join('')}</ul></section>` : ''}
      <section>
        <h3>Follow-up repair coordination</h3>
        ${existingTaskItems ? `<ul>${existingTaskItems}</ul>` : '<p class="workspace-empty-hint">No existing coordination tasks linked yet.</p>'}
        <label class="workspace-pub-checkbox"><input type="checkbox" name="createFollowUpTasks" value="true" checked/> Create or update scoped consumer repair task proposals</label>
      </section>
      <footer class="workspace-publication-actions">
        <button type="submit" value="return" data-publication-action="return">Return to edit</button>
        <button type="submit" value="keep-local" data-publication-action="keep-local">Keep local</button>
        <button type="button" class="workspace-btn-handoff" data-publication-action="share">Share assessment</button>
      </footer>
    </form>
  </dialog>`;
}

const nextAction = (status) => ({
  passed: 'Review the exact source and check targets before sharing this result.',
  failed: 'Repair the failing behavior, then rerun the reviewed checks.',
  missing: 'Configure or run the missing required checks.',
  stale: 'Reassess the changed source and rerun affected checks.',
  unknown: 'Review dependency, relevance, permission and provenance gaps.',
})[status];

export function workspaceAssessmentMarkup(assessment, { refreshable = false, entryTab = 'explore', projectFilter = '', alsoAffectedOutsideProject = [], existingTasks = [] } = {}) {
  const destination = entryTab === 'tasks' ? 'tasks' : 'explore';
  const entryLabel = destination === 'tasks' ? 'Assess a linked PR in Tasks' : 'Assess a change in Explore';
  if (!assessment) return `<section class="workspace-change-summary" data-workspace-assessment aria-live="polite"><h2>What remains unproven?</h2><p>No change has been assessed in this workspace view.</p><button type="button" data-workspace-tab="${destination}">${entryLabel}</button></section>`;
  if (assessment.loading) return '<section class="workspace-change-summary" data-workspace-assessment role="status"><h2>What remains unproven?</h2><p>Reassessing current source and evidence…</p></section>';
  if (assessment.error) return `<section class="workspace-change-summary" data-workspace-assessment role="status"><h2>Assessment unavailable</h2><p>${escapeHtml(assessment.error)}</p>${refreshable ? '<button type="button" data-refresh-assessment>Retry assessment</button>' : ''}</section>`;
  const candidate = assessment.kind === 'candidate';
  const comparison = assessment.comparison ?? {};
  const components = Array.isArray(assessment.components) ? assessment.components : [];
  const limitations = [...(assessment.verification?.limitations ?? []), ...(assessment.analysis?.gaps ?? []), ...(assessment.identityLimitations ?? [])];
  const omitted = assessment.omitted ?? {};
  const bounded = Object.values(omitted).some(value => Number(value) > 0);
  if (bounded) limitations.push('This bounded view omits additional results. Open the full assessment before concluding coverage.');
  const ledgerStatus = evidenceState(assessment.verification?.status);
  const status = candidate ? 'unknown' : ledgerStatus === 'failed' ? 'failed'
    : bounded || !components.length ? 'unknown' : ledgerStatus;
  const count = assessment.verification?.counts ?? {};
  const counts = [...evidenceStates].map(state => `${state}: ${Number(count[state] ?? 0)}`).join(' · ');
  const scopeLabel = comparison.mode === 'unstaged' && comparison.dirty && comparison.totalChangedFiles === 0
    ? ' · index differs from HEAD; no unstaged files'
    : comparison.dirty ? comparison.mode === 'staged' ? ' + staged changes' : comparison.mode === 'unstaged' ? ' + unstaged changes' : ' + working changes' : '';
  const source = comparison.baseCommit || comparison.headCommit
    ? `${String(comparison.baseCommit ?? 'unknown').slice(0, 12)} → ${String(comparison.headCommit ?? 'working changes').slice(0, 12)}${scopeLabel}`
    : 'Source revision not pinned';
  const rows = components.map(component => {
    const row = component.coverage ?? {};
    const rowStatus = candidate ? 'unknown' : evidenceState(row.status);
    const checks = Array.isArray(row.checks) ? row.checks.filter(check => check.required !== false) : [];
    const reasons = [...(row.reasons ?? []), ...checks.filter(check => check.status !== 'passed').map(check => check.reason).filter(Boolean)];
    if (component.changed) reasons.unshift(component.changeLocation === 'indexed-symbol-overlap'
      ? 'Baseline-matched symbol range overlaps a changed hunk; contract effect is unconfirmed.'
      : component.changeLocation === 'indexed-line-overlap'
        ? 'Indexed line overlaps a changed hunk; semantic effect is unconfirmed.'
        : 'Changed file association; symbol effect is unconfirmed.');
    if (candidate) reasons.push('Candidate impact only; required checks and results have not been established.');
    const citation = component.source?.path ? `${component.source.path}${component.source.line ? `:${component.source.line}` : ''}` : '';
    const effectBadge = component.effect ? ` <span class="workspace-delta-badge" data-delta-effect="${escapeHtml(component.effect)}">${escapeHtml(deltaEffectLabel(component.effect))}</span>` : '';
    return `<tr><th scope="row">${escapeHtml(component.projectId ?? 'Unknown project')} · ${escapeHtml(component.label ?? component.componentId ?? 'Affected component')}${effectBadge}${citation ? `<small>${escapeHtml(citation)}</small>` : ''}</th><td>${escapeHtml(rowStatus)}</td><td>${escapeHtml(reasons.join(' ') || (rowStatus === 'passed' ? 'Listed required checks passed for this exact target.' : 'Evidence not available.'))}</td></tr>`;
  }).join('');
  const candidateChecks = candidate && assessment.candidateChecks?.length ? `<p>Candidate checks, not executed: ${escapeHtml(assessment.candidateChecks.join(', '))}</p>` : '';
  const semanticComparisons = Array.isArray(assessment.semanticComparisons) && assessment.semanticComparisons.length
    ? assessment.semanticComparisons.slice(0, 5).map(result => `<li>${escapeHtml(result.path)} · ${escapeHtml(result.status)} · ${escapeHtml(result.reason)}${result.changes?.length ? `<ul>${result.changes.slice(0, 20).map(change => `<li>${escapeHtml(change.location)}: ${escapeHtml(change.kind)} (${escapeHtml(change.effect)} · <span class="workspace-delta-badge" data-delta-effect="${escapeHtml(change.effect)}">${escapeHtml(deltaEffectLabel(change.effect))}</span>)</li>`).join('')}</ul>` : ''}</li>`).join('') : '';
  const outsideComponents = [
    ...alsoAffectedOutsideProject,
    ...(projectFilter ? components.filter(c => c.projectId && c.projectId !== projectFilter).map(c => ({
      projectId: c.projectId,
      label: c.label ?? c.componentId,
      status: evidenceState(c.coverage?.status),
      reason: c.coverage?.checks?.[0]?.reason ?? 'Affected downstream consumer outside focused project.',
    })) : []),
  ];
  const outsideSection = outsideComponents.length
    ? `<section class="workspace-outside-impact" data-outside-project-impact><h3>Also affected outside this project</h3><ul>${outsideComponents.map(item => `<li><strong>${escapeHtml(item.projectName ?? item.projectId)} · ${escapeHtml(item.label)}</strong> (<span data-evidence-state="${escapeHtml(evidenceState(item.status))}">${escapeHtml(item.status ?? 'unknown')}</span>) — ${escapeHtml(item.reason)}</li>`).join('')}</ul></section>`
    : '';
  const pubDialog = workspacePublicationReviewMarkup(assessment, { existingTasks, unresolvedConsumers: assessment.unresolvedConsumers ?? [], acknowledgment: assessment.acknowledgment ?? null });
  return `<section class="workspace-change-summary" data-workspace-assessment aria-label="Change verification summary" aria-live="polite"><header><div><h2>${candidate ? 'Candidate change impact' : 'What remains unproven?'}</h2>${assessment.subject ? `<p>${escapeHtml(assessment.subject)}</p>` : ''}<p>${escapeHtml(source)}${comparison.totalChangedFiles != null ? ` · ${escapeHtml(comparison.totalChangedFiles)} changed files` : ''}</p></div><strong class="workspace-change-state" data-evidence-state="${status}">${status}</strong></header>
    <p>${candidate ? 'This PR assessment suggests affected paths. It does not establish current verification coverage.' : nextAction(status)}</p>
    <p class="workspace-change-counts">Required checks — ${escapeHtml(counts)}</p>
    ${candidateChecks}
    ${semanticComparisons ? `<h3>OpenAPI structural comparison</h3><ul>${semanticComparisons}</ul>` : ''}
    <div tabindex="0" role="region" aria-label="Affected components" class="workspace-change-table table-wrapper"><table style="--label-1:'Affected component';--label-2:'Evidence';--label-3:'Reason or next work'"><thead><tr><th scope="col">Affected component</th><th scope="col">Evidence</th><th scope="col">Reason or next work</th></tr></thead><tbody>${rows || '<tr><td colspan="3">No readable affected component is mapped. Coverage remains unknown.</td></tr>'}</tbody></table></div>
    ${outsideSection}
    ${limitations.length ? `<ul class="workspace-change-gaps">${limitations.map(reason => `<li>${escapeHtml(reason)}</li>`).join('')}</ul>` : ''}
    <div class="workspace-change-actions"><button type="button" data-workspace-tab="${destination}">${destination === 'tasks' ? 'Inspect linked PR in Tasks' : 'Inspect change in Explore'}</button><button type="button" data-open-publication-review>Review sharing &amp; follow-up work</button>${refreshable ? '<button type="button" data-refresh-assessment>Reassess current source</button>' : ''}</div>
    ${pubDialog}
    <small>${candidate ? 'Candidate at the PR revision read above; reassess after its head changes.' : `Assessed ${escapeHtml(assessment.evaluatedAt ?? 'at an unknown time')}. Source can change after this assessment. Listed checks are not a universal safety guarantee.`}</small></section>`;
}

export function workspaceTabMarkup(tab) {
  return `<nav class="workspace-view-tabs" aria-label="Workspace views">${WORKSPACE_TABS.map(([key,label]) => `<button type="button" data-workspace-tab="${key}" ${key === tab ? 'aria-current="page"' : ''}>${label}</button>`).join('')}</nav>`;
}

export function workspaceTaskDetailMarkup(task, context = {}, { canEdit = true, isBusy = false, canPrepareHandoff = true, selectedStatus = null, handoffDeliveryState = null } = {}) {
  if (!task) return '';
  const decisions = Array.isArray(context.decisions) ? context.decisions : [];
  const evidence = Array.isArray(context.evidence) ? context.evidence : [];
  const receipts = Array.isArray(context.receipts) ? context.receipts : [];
  const comments = Array.isArray(context.comments) ? context.comments : [];
  const scope = Array.isArray(task.scope) ? task.scope : [];
  const revisionSet = Array.isArray(task.revisionSet ?? task.revision_set) ? (task.revisionSet ?? task.revision_set) : [];
  const unresolvedCitation = task.citationStatus === 'source_citation_unresolved' || task.unresolvedCitation || (Array.isArray(context.unresolvedConsumers) && context.unresolvedConsumers.length > 0);
  const deliveryState = handoffDeliveryState && HANDOFF_STATES.has(handoffDeliveryState) ? handoffDeliveryState : (context.handoffState && HANDOFF_STATES.has(context.handoffState) ? context.handoffState : null);

  return `
    <article class="workspace-task-detail" data-workspace-task-detail="${escapeHtml(task.id)}">
      <header class="workspace-task-detail-header">
        <button type="button" class="workspace-btn-back" data-close-workspace-task aria-label="Back to tasks">← Back to tasks</button>
        <div class="workspace-task-title-group">
          <h2>${escapeHtml(task.title)}</h2>
          <span class="workspace-task-status-badge" data-task-status="${escapeHtml(task.status)}">${escapeHtml(task.status)}</span>
          ${unresolvedCitation ? '<span class="workspace-citation-unresolved" data-citation-state="unresolved">Source citation unresolved</span>' : ''}
        </div>
        <p class="workspace-task-scope">
          <span>Owning project: <strong>${escapeHtml(task.projectName ?? task.projectId)}</strong></span>
          ${scope.length > 1 ? ` · <span>Cross-project scope: ${scope.map(s => `<span class="workspace-scope-pill">${escapeHtml(s.projectKey ?? s.projectId)}</span>`).join(' ')}</span>` : ''}
        </p>
      </header>
      
      <div class="workspace-task-actions">
        <label class="workspace-task-status-select-label">
          Update status:
          <select data-task-status-select="${escapeHtml(task.id)}" ${isBusy || !canEdit ? 'disabled' : ''}>
            ${['proposed', 'open', 'in_progress', 'in_review', 'blocked', 'completed', 'archived'].map(st => `<option value="${st}" ${st === (selectedStatus ?? task.status) ? 'selected' : ''}>${st.replaceAll('_', ' ')}</option>`).join('')}
          </select>
        </label>
        ${canPrepareHandoff ? `<button type="button" class="workspace-btn-prepare" data-prepare-context="${escapeHtml(task.id)}">Prepare context</button><button type="button" class="workspace-btn-handoff" data-task-handoff="${escapeHtml(task.id)}" title="Assemble bounded context pack for IDE coding agents">Prepare Agent Handoff</button>` : '<span class="workspace-empty-hint">Open this task in a connected companion or IDE to prepare an agent handoff.</span>'}
        ${deliveryState ? `<span class="workspace-handoff-state-badge" data-handoff-state="${escapeHtml(deliveryState)}">${escapeHtml(deliveryState)}</span>` : ''}
      </div>

      <section class="workspace-task-section" data-task-section="work">
        <h3>Work · Objective &amp; Scope</h3>
        ${task.description ? `<p class="workspace-task-desc">${escapeHtml(task.description)}</p>` : '<p class="workspace-empty-hint">No task description provided.</p>'}
      </section>

      <section class="workspace-task-section" data-task-section="context">
        <h3>Context · Pinned Revision Set</h3>
        ${revisionSet.length ? `
          <ul class="workspace-revision-list">
            ${revisionSet.map(rev => `<li><strong>${escapeHtml(rev.projectKey ?? rev.projectId)}</strong>: <code>${escapeHtml(String(rev.commit ?? '').slice(0, 12))}</code></li>`).join('')}
          </ul>
        ` : '<p class="workspace-empty-hint">No source revision pinned. Verification remains unknown.</p>'}
        <p class="workspace-advisory-disclosure" data-advisory-boundary="data-only">Advisory discussion and decisions are stored as data only and omitted by default from automatic agent instructions.</p>
      </section>

      <div class="workspace-task-sections-grid">
        <section class="workspace-task-section">
          <h3>Decisions (${decisions.length})</h3>
          ${decisions.length ? `<ul class="workspace-task-list">${decisions.map(d => `<li>${escapeHtml(d.body ?? d.title ?? d.summary)}</li>`).join('')}</ul>` : '<p class="workspace-empty-hint">No decisions recorded yet.</p>'}
        </section>

        <section class="workspace-task-section" data-task-section="checks">
          <h3>Checks · Verification Receipts (${receipts.length})</h3>
          ${receipts.length ? `<ul class="workspace-task-list">${receipts.map(r => `<li><strong class="workspace-evidence-badge" data-evidence-state="unknown">Reported ${escapeHtml(r.result ?? 'unknown')}</strong> ${escapeHtml(r.summary ?? 'Receipt')} <small>${escapeHtml(r.freshness ?? '')}</small></li>`).join('')}</ul><p class="workspace-empty-hint">Receipt labels are claims until their producer, scope, revision and required checks are accepted.</p>` : '<p class="workspace-empty-hint">No verification receipts yet. Coverage remains unknown.</p>'}
        </section>
      </div>

      ${evidence.length ? `<section class="workspace-task-section"><h3>Evidence (${evidence.length})</h3><ul class="workspace-task-list">${evidence.map(entry => `<li>${escapeHtml(entry.kind ?? 'Evidence')} · ${escapeHtml(entry.producer ?? 'Unknown producer')} <small>${escapeHtml(entry.freshness ?? '')}</small></li>`).join('')}</ul></section>` : ''}

      <section class="workspace-task-section" data-task-section="activity">
        <h3>Activity · Discussion (${comments.length})</h3>
        <div class="workspace-comments-thread">
          ${comments.map(c => `
            <div class="workspace-comment-card">
              <p>${escapeHtml(c.body)}</p>
              ${c.createdAt ? `<small>${escapeHtml(new Date(c.createdAt).toLocaleString())}</small>` : ''}
            </div>
          `).join('') || '<p class="workspace-empty-hint">No comments yet.</p>'}
        </div>
        ${canEdit ? `
          <form class="workspace-comment-form" data-task-comment-form="${escapeHtml(task.id)}">
            <input type="text" name="comment" placeholder="Add a note, decision citation, or handoff checkpoint…" required ${isBusy ? 'disabled' : ''}/>
            <button type="submit" ${isBusy ? 'disabled' : ''}>Add comment</button>
          </form>
        ` : ''}
      </section>
    </article>
  `;
}

export function workspaceReleaseMarkup(release = null, projectFilter = '') {
  const observations = Array.isArray(release?.observations) ? release.observations : [];
  const pairs = Array.isArray(release?.pairs) ? release.pairs : [];
  const environment = release?.environment?.name ?? release?.environment ?? 'No environment selected';
  const enforcement = release?.enforcement?.state === 'enforced' ? 'Enforced by protected deployment controller' : 'Deployment gate not enforced';
  const pairRows = pairs.map((pair) => {
    const status = evidenceState(pair.status);
    const outside = projectFilter && pair.producerProjectId !== projectFilter && pair.consumerProjectId !== projectFilter;
    const producer = `${pair.producerLabel ?? pair.producerProjectId ?? 'Restricted producer'} @ ${String(pair.producerRevision ?? 'unknown').slice(0, 12)}`;
    const consumer = `${pair.consumerLabel ?? pair.consumerProjectId ?? 'Restricted consumer'} @ ${String(pair.consumerRevision ?? 'unknown').slice(0, 12)}`;
    return `<tr><th scope="row">${escapeHtml(producer)}<small>→ ${escapeHtml(consumer)}</small></th><td>${escapeHtml(pair.cohort ?? 'Unknown cohort')}${outside ? '<small>Also affected outside this project</small>' : ''}</td><td><strong class="workspace-evidence-badge" data-evidence-state="${status}">${status}</strong></td><td>${escapeHtml(pair.reason ?? 'Exact pair evidence is unavailable.')}</td></tr>`;
  }).join('');
  const observationRows = observations.map((item) => `<li><strong>${escapeHtml(item.label ?? item.projectId ?? 'Restricted source')}</strong> · ${escapeHtml(item.cohort ?? 'Active status unknown')} · <code>${escapeHtml(String(item.revision ?? 'unknown').slice(0, 12))}</code>${item.observedAt ? ` <small>Observed ${escapeHtml(item.observedAt)}</small>` : ''}</li>`).join('');
  return `<section class="workspace-release" data-kmaps-section="compatibility" aria-label="Compatibility and rollout"><header><div><h2>Compatibility &amp; rollout</h2><p>${escapeHtml(environment)} · ${escapeHtml(enforcement)}</p></div></header>
    <p>Candidate checks apply to exact version pairs. A passing proposed pair does not clear a failing deployed consumer.</p>
    <h3>Observed versions</h3>${observationRows ? `<ul>${observationRows}</ul>` : '<p>No trusted deployment observations are available. Active versions are unknown.</p>'}
    <h3 id="workspace-release-pairs-heading">Required producer and consumer pairs</h3><div tabindex="0" role="region" aria-labelledby="workspace-release-pairs-heading" class="workspace-change-table table-wrapper"><table style="--label-1:'Version pair';--label-2:'Cohort';--label-3:'Evidence';--label-4:'Reason'"><thead><tr><th scope="col">Version pair</th><th scope="col">Cohort</th><th scope="col">Evidence</th><th scope="col">Reason</th></tr></thead><tbody>${pairRows || '<tr><td colspan="4">No version pairs have been established. Deployment compatibility remains unknown.</td></tr>'}</tbody></table></div>
    ${release?.enforcement?.reason ? `<p>${escapeHtml(release.enforcement.reason)}</p>` : ''}</section>`;
}

export function workspaceWorkQueueMarkup(model, tasks = [], projectFilter = '') {
  const queueItems = [];
  if (model.assessment && !assessmentIsClean(model.assessment)) {
    queueItems.push({
      kind: 'assessment',
      title: model.assessment.subject ?? 'Assessed working changes require review',
      source: model.assessment.comparison?.baseCommit ? `${String(model.assessment.comparison.baseCommit).slice(0, 8)} → ${String(model.assessment.comparison.headCommit ?? 'working').slice(0, 8)}` : 'Working tree',
      reason: 'Impacts and unproven checks await publication review.',
      actionAttr: 'data-open-publication-review',
      actionLabel: 'Review sharing & follow-up work',
    });
  }
  for (const task of tasks.filter(t => ['proposed', 'open', 'in_progress', 'blocked'].includes(t.status)).slice(0, 4)) {
    queueItems.push({
      kind: 'task',
      title: task.title,
      source: task.projectName ?? task.projectId ?? 'Workspace',
      reason: task.status === 'proposed' ? 'Proposed consumer repair awaiting adoption.' : `Status: ${task.status.replaceAll('_', ' ')}`,
      actionAttr: `data-open-workspace-task="${escapeHtml(task.projectId)}:${escapeHtml(task.id)}"`,
      actionLabel: 'Open repair task',
    });
  }
  const blockedPairs = (model.releaseCompatibility?.pairs ?? []).filter(p => ['failed', 'missing', 'unknown'].includes(p.status));
  if (blockedPairs.length) {
    queueItems.push({
      kind: 'release',
      title: `${blockedPairs.length} producer/consumer version pair${blockedPairs.length === 1 ? '' : 's'} unproven or blocked`,
      source: model.releaseCompatibility?.environment?.name ?? 'Environment',
      reason: blockedPairs[0].reason ?? 'Coexistence compatibility is not established.',
      actionAttr: 'data-workspace-tab="kmaps"',
      actionLabel: 'Inspect blocked pair',
    });
  }
  for (const item of model.alsoAffectedOutsideProject ?? []) {
    queueItems.push({
      kind: 'outside-impact',
      title: `${item.projectName ?? item.projectId} · ${item.label}`,
      source: 'Also affected outside this project',
      reason: item.reason,
      actionAttr: 'data-workspace-tab="explore"',
      actionLabel: 'Inspect outside impact',
    });
  }
  const mergeStatus = model.assessment ? evidenceState(model.assessment.verification?.status) : 'unknown';
  const deployEnforcement = model.releaseCompatibility?.enforcement?.state === 'enforced' ? 'enforced' : 'unavailable';
  const deployStatus = deployEnforcement === 'unavailable' ? 'Deployment gate not enforced' : (model.releaseCompatibility?.canDeploy ? 'Permitted for exact candidate' : 'Blocked');

  return `<section class="workspace-work-queue" data-workspace-work-queue aria-label="Prioritized work queue">
    <header class="workspace-work-queue-header">
      <h2>Prioritized work queue</h2>
      <div class="workspace-gate-strip">
        <span class="workspace-gate-pill" data-merge-check-state="${escapeHtml(mergeStatus)}">Merge check: <strong>${escapeHtml(mergeStatus)}</strong></span>
        <span class="workspace-gate-pill" data-deployment-gate-state="${escapeHtml(deployEnforcement)}">Deployment gate: <strong>${escapeHtml(deployStatus)}</strong></span>
      </div>
    </header>
    ${queueItems.length ? `<ul class="workspace-work-queue-list">${queueItems.map(item => `<li class="workspace-work-queue-item"><div><strong>${escapeHtml(item.title)}</strong> <small>${escapeHtml(item.source)}</small><p>${escapeHtml(item.reason)}</p></div><button type="button" ${item.actionAttr}>${escapeHtml(item.actionLabel)}</button></li>`).join('')}</ul>` : '<p class="workspace-empty-hint">No immediate blockers queued. Select a source in Explore to assess changes.</p>'}
  </section>`;
}

function assessmentIsClean(assessment) {
  return assessment && assessment.kind !== 'candidate' && assessment.verification?.status === 'passed' && !Object.values(assessment.omitted ?? {}).some(v => Number(v) > 0);
}

export function workspaceViewMarkup(model, tab = 'home', projectFilter = '', options = {}) {
  const allProjects = model.allProjects ?? model.projects ?? [];
  const projects = (model.projects ?? []).filter((project) => !projectFilter || project.id === projectFilter);
  const ids = new Set(projects.map((project) => project.id));
  const tasks = (model.tasks ?? []).filter((task) =>
    (!projectFilter && !task.projectId && !(task.projectIds ?? []).length) ||
    ids.has(task.projectId) || (task.projectIds ?? []).some((id) => ids.has(id)));
  const contracts = (model.contracts ?? []).filter((contract) => ids.has(contract.projectId));
  const targets = (model.targets ?? []).filter((target) => ids.has(target.projectId));
  const mode = model.workspace?.mode === 'team' ? 'Team' : 'Free Local';
  const filter = `<div class="workspace-view-actions">${mode === 'Free Local' ? '<button type="button" data-upgrade-workspace>Upgrade this workspace to Team</button>' : ''}<label class="workspace-view-filter">Project <select data-workspace-project-filter aria-label="Filter workspace projects"><option value="">All projects</option>${allProjects.map((project) => `<option value="${escapeHtml(project.id)}" ${project.id === projectFilter ? 'selected' : ''}>${escapeHtml(project.name)}</option>`).join('')}</select></label></div>`;

  const selectedTaskId = options.selectedTaskId ?? model.selectedTaskId ?? '';
  const currentTask = selectedTaskId ? tasks.find(t => t.id === selectedTaskId || t.externalId === selectedTaskId) : null;

  let content = '';
  if (tab === 'home') {
    content = `${workspaceWorkQueueMarkup(model, tasks, projectFilter)}<div class="workspace-view-grid">${projects.map((project) => `<button class="workspace-view-project" data-open-workspace-project="${escapeHtml(project.id)}"><strong>${escapeHtml(project.name)}</strong><span>${escapeHtml(project.kind ?? 'Local source')}</span><small>${escapeHtml(project.detail ?? 'Project source')}</small></button>`).join('') || card('No projects', 'Add a project in workspace settings.')}</div><div class="workspace-view-grid">${card(`${tasks.length} tasks`, 'Work across the selected projects')}${card(`${contracts.length} contracts`, 'Indexed contract inventory')}${card(`${targets.length} source targets`, 'Indexed implementation context')}</div>`;
  } else if (tab === 'explore') {
    content = `<div class="workspace-view-grid">${targets.map((target) => card(target.label, target.kind, `${target.projectName ?? target.projectId} · ${target.source ?? 'Indexed knowledge'}`)).join('') || card('Knowledge unavailable', model.capabilities?.knowledge ?? 'Index a local project or synchronize Team knowledge to explore it.')}</div>`;
  } else if (tab === 'tasks') {
    if (currentTask) {
      content = workspaceTaskDetailMarkup(currentTask, options.taskContext ?? model.taskContext ?? {}, options);
    } else {
      content = `<div class="workspace-view-grid">${tasks.map((task) => `<button class="workspace-view-project" data-open-workspace-task="${escapeHtml(task.projectId)}:${escapeHtml(task.id)}"><strong>${escapeHtml(task.title)}</strong><span>${escapeHtml(task.status)}</span><small>${escapeHtml(task.projectName ?? task.projectId)}</small></button>`).join('') || card('No tasks', 'Create a task in a project or synchronize Team tasks.')}</div>`;
    }
  } else if (tab === 'kmaps') {
    const contractCards = contracts.map((contract) => {
      const evClassKey = String(contract.evidenceClass ?? 'extracted').toLowerCase();
      const evClassLabel = EVIDENCE_CLASS_LABELS[evClassKey] ?? contract.evidenceClass ?? 'Extracted';
      const uncertainActions = evClassKey === 'suggested'
        ? `<div class="workspace-kmap-link-actions"><button type="button" data-confirm-link="${escapeHtml(contract.id)}">Confirm link</button><button type="button" data-ignore-link="${escapeHtml(contract.id)}">Ignore</button></div>`
        : '';
      return `<article class="workspace-view-card" data-contract-id="${escapeHtml(contract.id ?? '')}"><strong>${escapeHtml(`${contract.method ?? 'API'} ${contract.route ?? contract.title ?? ''}`.trim())}</strong><span>${escapeHtml(contract.projectName ?? contract.projectId)}</span><small>${escapeHtml(contract.evidence ?? 'Contract inventory')} · <span class="workspace-evidence-class" data-evidence-class="${escapeHtml(evClassKey)}">${escapeHtml(evClassLabel)}</span></small>${uncertainActions}</article>`;
    }).join('') || card('No shared contracts', model.capabilities?.contracts ?? 'Index local source or synchronize contracts to see the workspace K-Map.');
    content = `<section class="workspace-kmaps-contracts" data-kmaps-section="contracts"><h2>Contracts &amp; dependencies</h2><div class="workspace-view-grid">${contractCards}</div></section>${workspaceReleaseMarkup(model.releaseCompatibility, projectFilter)}`;
  } else if (tab === 'tools') {
    const capDetails = model.capabilityDetails ?? {};
    const toolCard = (key, title, fallback) => {
      const detail = capDetails[key];
      const text = model.capabilities?.[key] ?? detail?.reason ?? fallback;
      const badge = detail?.availability ? `<small>State: ${escapeHtml(detail.availability.replaceAll('_', ' '))} · Action: ${escapeHtml(detail.permittedAction ?? 'Inspect')}</small>` : '';
      return `<article class="workspace-view-card" data-capability-card="${escapeHtml(key)}"><strong>${escapeHtml(title)}</strong><span>${escapeHtml(text)}</span>${badge}</article>`;
    };
    content = `<div class="workspace-view-grid">${toolCard('verify', 'Verify changes', 'Select an available local or authorized CI runner.')}${toolCard('source', 'Source and diffs', 'Select a project to inspect source.')}${toolCard('agents', 'Agent handoff', 'Open a task to prepare bounded context.')}${toolCard('settings', 'Workspace settings', 'Manage projects and access for this workspace.')}</div>`;
  }

  if (tab === 'home' || tab === 'tasks' || (['explore', 'kmaps'].includes(tab) && model.assessment)) {
    content = workspaceAssessmentMarkup(model.assessment, {
      refreshable: model.assessmentRefreshable === true,
      entryTab: model.assessmentEntryTab,
      projectFilter,
      alsoAffectedOutsideProject: model.alsoAffectedOutsideProject ?? [],
      existingTasks: tasks,
    }) + content;
  }

  return `<section class="workspace-view" aria-label="${escapeHtml(model.workspace?.name ?? 'Workspace')}"><header class="workspace-view-header"><div><small>${mode} workspace</small><h1>${escapeHtml(model.workspace?.name ?? 'Workspace')}</h1><p>${projects.length} project${projects.length === 1 ? '' : 's'} in view</p></div>${filter}</header>${workspaceTabMarkup(tab)}<div class="workspace-view-content">${content}</div></section>`;
}
