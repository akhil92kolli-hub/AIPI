const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));

export function changeAssessmentPanelMarkup(projects) {
  const roots = projects.flatMap(project => (project.sourceContext?.roots ?? []).map((root, index) => ({
    projectId: project.id, name: project.name, index, kind: root.kind ?? 'source',
  })));
  if (!roots.length) return '<section class="section-block"><h2>Assess a change</h2><p>Register a local Git source root to assess its changes.</p></section>';
  return `<section class="section-block" data-change-assessment-panel><h2>What changed, and what remains unproven?</h2>
    <p>Compare a registered Git source with an explicit baseline. This reads files and dependency evidence without running tests or replaying requests.</p>
    <form data-change-assessment-form class="modal-form-section">
      <label class="field-label">Changed project and source<select class="field" name="source">${roots.map(root => `<option value="${escape(JSON.stringify([root.projectId, root.index]))}">${escape(root.name)} · ${escape(root.kind)} ${root.index + 1}</option>`).join('')}</select></label>
      <label class="field-label">Baseline commit or local ref<input class="field" name="baseline" value="HEAD" maxlength="512" required></label>
      <label class="field-label">Compare<select class="field" name="mode"><option value="working-tree">Current working changes</option><option value="staged">Staged changes only</option><option value="unstaged">Unstaged changes only</option><option value="commits">Two commits</option></select></label>
      <p class="supporting-copy">Staged compares the baseline with the Git index. Unstaged compares the index with working files and requires the current HEAD baseline. Untracked files appear only in current working changes.</p>
      <label class="field-label">Proposed commit or local ref <span class="optional-label">For two-commit comparisons</span><input class="field" name="head" maxlength="512" placeholder="feature-branch or commit SHA" disabled></label>
      <button class="primary-button" type="submit">Assess change</button>
    </form><div data-change-assessment-result role="status" aria-live="polite"></div>
  </section>`;
}

export function changeAssessmentResultMarkup(result) {
  const changed = result.comparison;
  const comparisonLabel = changed.mode === 'staged' ? 'staged changes' : changed.mode === 'unstaged' ? 'unstaged changes' : changed.mode === 'commits' ? 'selected commit' : 'working changes';
  const selectedState = changed.mode === 'unstaged' && changed.dirty && changed.totalChangedFiles === 0
    ? ' · index differs from HEAD; no unstaged files' : changed.dirty ? ` + ${comparisonLabel}` : '';
  return `<div class="section-block"><h3>Assessment: ${escape(result.verification.status)}</h3>
    <p>${escape(changed.baseCommit?.slice(0, 12))} → ${escape(changed.headCommit?.slice(0, 12))}${selectedState} · ${escape(changed.totalChangedFiles)} changed files</p>
    <p>Checked ${escape(result.evaluatedAt)}. Reassess after editing source or changing the environment. This assessment request did not run checks.</p>
    <h4>Changed files</h4><ul>${changed.files.map(file => `<li>${escape(file.status)} ${escape(file.path)}${file.previousPath ? ` ← ${escape(file.previousPath)}` : ''}${file.binary ? ' · binary' : ''}${file.lineRanges?.length ? ` · changed new lines ${escape(file.lineRanges.slice(0, 3).map(range => range.newLines ? `${range.newStart}-${range.newStart + range.newLines - 1}` : `after ${range.newStart}`).join(', '))}${file.lineRanges.length > 3 ? ' and more' : ''}` : ''}</li>`).join('') || '<li>No file differences from this baseline.</li>'}</ul>
    <h4>Affected components and verification obligations</h4>
    <div style="overflow-x:auto"><table><thead><tr><th scope="col">Component</th><th scope="col">Dependency evidence</th><th scope="col">Verification</th></tr></thead><tbody>${result.components.map(component => `<tr><td>${escape(component.projectId)} · ${escape(component.label)}${component.source ? `<br><small>${escape(component.source.path)}${component.source.line ? `:${escape(component.source.line)}${component.source.endLine && component.source.endLine > component.source.line ? `-${escape(component.source.endLine)}` : ''}` : ''}${component.source.rangeMethod === 'python-indentation-heuristic' ? ' · heuristic span' : component.source.rangeMethod === 'typescript-ast' ? ' · AST span' : ''}</small>` : ''}</td><td>${component.changed ? component.changeLocation === 'indexed-symbol-overlap' ? 'Baseline-matched indexed span overlaps a changed hunk; behavior or contract effect unconfirmed' : component.changeLocation === 'indexed-line-overlap' ? 'Indexed line overlaps a changed hunk; semantic effect unconfirmed' : 'Changed file association; symbol effect unconfirmed' : 'Related consumer'} · ${escape(component.confidence)}${component.paths.some(chain => chain.some(hop => hop.stale)) ? '<br>Prior relationship evidence needs review.' : ''}</td><td>${escape(component.coverage?.status ?? 'unknown')}<ul>${(component.coverage?.checks ?? []).map(check => `<li>${escape(check.kind)}: ${escape(check.status)} — ${escape(check.reason)}</li>`).join('')}</ul></td></tr>`).join('') || '<tr><td colspan="3">No indexed component mapping found. Coverage remains unknown.</td></tr>'}</tbody></table></div>
    <h4>Coverage limits</h4><ul>${[...(result.analysis?.gaps ?? []), ...(result.identityLimitations ?? [])].map(gap => `<li>${escape(gap)}</li>`).join('')}</ul>
    ${Object.values(result.omitted ?? {}).some(count => count > 0) ? `<p>Some details are omitted from this bounded view: ${escape(JSON.stringify(result.omitted))}.</p>` : ''}
    <p>${escape(result.coverage)}</p>
    ${result.components.some(component => component.obligations?.some(check => check.configured)) ? '<button type="button" class="secondary-button" data-review-assessment>Review configured checks</button>' : ''}
    <div data-change-review role="status" aria-live="polite"></div></div>`;
}

export function changeAssessmentReviewMarkup(review) {
  return `<h4>Reviewed execution plan</h4><p>Approval applies to the listed commands and current source snapshots. These checks may run project code.</p>
    <ul>${review.checks.map(check => `<li>${escape(check.projectId)} · ${escape(check.componentId)}: <code>${escape(JSON.stringify(check.command))}</code></li>`).join('') || '<li>No executable checks are ready.</li>'}</ul>
    ${review.gaps.length ? `<p>Remaining setup gaps: ${escape(review.gaps.join(' '))}</p>` : ''}
    ${review.checks.length ? '<button type="button" class="primary-button" data-run-assessment>Run reviewed checks</button>' : ''}
    ${review.checks.length ? '<label><input type="checkbox" data-share-assessment> I reviewed these commands and approve including their arguments and source revision IDs in a local package manifest.</label><br><button type="button" class="secondary-button" data-export-assessment>Export package manifest</button>' : ''}
    <p>${escape(review.note)}</p>`;
}

export function mountChangeAssessmentPanel(container, { workspaceId, request, onAssessment }) {
  const panel = container.querySelector('[data-change-assessment-panel]');
  if (!panel) return;
  const form = panel.querySelector('form'), result = panel.querySelector('[data-change-assessment-result]');
  form.elements.mode.addEventListener('change', () => {
    form.elements.head.disabled = form.elements.mode.value !== 'commits';
    form.elements.head.required = !form.elements.head.disabled;
  });
  let generation = 0;
  let lastPayload = null, reviewed = null;
  form.addEventListener('submit', async event => {
    event.preventDefault();
    const current = ++generation, button = form.querySelector('button[type="submit"]');
    lastPayload = null; reviewed = null;
    button.disabled = true; result.textContent = 'Reading Git changes and dependency evidence…';
    try {
      const [project_id, root_index] = JSON.parse(form.elements.source.value);
      const mode = form.elements.mode.value;
      const payload = { project_id, root_index, base_ref: form.elements.baseline.value.trim(), mode,
        ...(mode === 'commits' ? { head_ref: form.elements.head.value.trim() } : {}), limit: 30 };
      const response = await request(`/api/workspaces/${encodeURIComponent(workspaceId)}/change-assessment`, {
        method: 'POST', body: JSON.stringify(payload),
      });
      if (current === generation && panel.isConnected) {
        lastPayload = payload;
        result.innerHTML = changeAssessmentResultMarkup(response.assessment);
        onAssessment?.({ payload, assessment: response.assessment });
      }
    } catch (error) { if (current === generation && panel.isConnected) result.textContent = `Assessment unavailable: ${error.message}`; }
    finally { if (current === generation) button.disabled = false; }
  });
  result.addEventListener('click', async event => {
    const reviewButton = event.target.closest('[data-review-assessment]');
    const runButton = event.target.closest('[data-run-assessment]');
    const exportButton = event.target.closest('[data-export-assessment]');
    if ((!reviewButton && !runButton && !exportButton) || !lastPayload) return;
    const current = generation;
    const button = reviewButton ?? runButton ?? exportButton;
    button.disabled = true;
    const reviewArea = result.querySelector('[data-change-review]');
    if (reviewArea && !exportButton) reviewArea.textContent = reviewButton ? 'Preparing exact check targets…' : 'Running reviewed checks…';
    try {
      if (reviewButton) {
        const response = await request(`/api/workspaces/${encodeURIComponent(workspaceId)}/change-assessment/review`, {
          method: 'POST', body: JSON.stringify(lastPayload),
        });
        if (current === generation && panel.isConnected && reviewArea) {
          reviewed = response.review;
          reviewArea.innerHTML = changeAssessmentReviewMarkup(reviewed);
        }
      } else if (exportButton && reviewed?.reviewHash) {
        if (!reviewArea?.querySelector('[data-share-assessment]')?.checked) {
          throw new Error('Review the commands and select the package sharing checkbox first.');
        }
        const response = await request(`/api/workspaces/${encodeURIComponent(workspaceId)}/change-assessment/package`, {
          method: 'POST', body: JSON.stringify({ ...lastPayload, review_hash: reviewed.reviewHash, share_source: true }),
        });
        if (current === generation && panel.isConnected) {
          const blob = new Blob([`${JSON.stringify(response.manifest, null, 2)}\n`], { type: 'application/json' });
          const link = document.createElement('a');
          const objectUrl = URL.createObjectURL(blob);
          link.href = objectUrl;
          link.download = `aipi-verification-${String(workspaceId).replace(/[^A-Za-z0-9_-]/g, '_')}.json`;
          link.click();
          setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
          const message = document.createElement('p');
          message.textContent = response.manifest.complete
            ? 'Package manifest exported. A teammate must bind and check source revisions, then explicitly approve execution.'
            : `Incomplete package manifest exported: ${response.manifest.gaps.join(' ')}`;
          reviewArea.append(message);
        }
      } else if (reviewed?.reviewHash) {
        const response = await request(`/api/workspaces/${encodeURIComponent(workspaceId)}/change-assessment/execute`, {
          method: 'POST', body: JSON.stringify({ ...lastPayload, review_hash: reviewed.reviewHash }),
        });
        if (current === generation && panel.isConnected) {
          reviewed = null;
          result.innerHTML = `<p>Executed ${escape(response.run.receipts.length)} reviewed checks${response.run.sourceChangedDuringRun ? '; source changed during execution' : ''}.</p>`
            + changeAssessmentResultMarkup(response.assessment);
          onAssessment?.({ payload: lastPayload, assessment: response.assessment });
        }
      }
    } catch (error) {
      if (current === generation && panel.isConnected && reviewArea) reviewArea.textContent = `Check operation unavailable: ${error.message}`;
    } finally { if (current === generation && button.isConnected) button.disabled = false; }
  });
}
