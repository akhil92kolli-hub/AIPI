import crypto from 'node:crypto';

const reportText = (value, limit = 200) => String(value ?? '').slice(0, limit)
  .replace(/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g, ' ').replace(/[|`<>]/g, character => ({
    '|': '\\|', '`': "'", '<': '&lt;', '>': '&gt;'
  })[character]);

export function composeTeamPrReport({ pr, impact, receipts, revisionSet, projects,
  acceptReceipt = () => false, task = /** @type {{title?: string, status?: string}|null} */ (null) }) {
  if (!pr || !impact || !Array.isArray(receipts) || !Array.isArray(revisionSet) || !Array.isArray(projects)) throw new Error('PR, impact, receipts, projects and revisions are required');
  const headPinned = revisionSet.some((entry) => entry.projectKey === pr.changed_project_key && entry.commit === pr.head_sha);
  const repositories = new Map(projects.map((item) => [item.project_key, item.provider_repository_id]));
  const revisions = new Map(revisionSet.map((item) => [item.projectKey, item.commit]));
  const required = (impact.affected ?? []).flatMap((item) => (item.requiredChecks ?? []).map((name) => ({ name, projectKey: item.projectKey, repositoryId: repositories.get(item.projectKey) })));
  const checks = required.sort((a, b) => `${a.projectKey}:${a.name}`.localeCompare(`${b.projectKey}:${b.name}`)).map(({ name, projectKey, repositoryId }) => {
    const candidates = receipts.filter((item) => item.check_name === name && item.provider_repository_id === repositoryId)
      .sort((a, b) => String(b.observed_at ?? '').localeCompare(String(a.observed_at ?? '')));
    const pinnedCommit = revisions.get(projectKey);
    const exact = candidates.find((item) => item.head_sha === pinnedCommit);
    const accepted = exact && (() => { try { return acceptReceipt(exact) === true; } catch { return false; } })();
    const state = !headPinned || !pinnedCommit || impact.status === 'stale' ? 'stale'
      : exact ? exact.conclusion === 'failure' ? 'failed'
        : exact.conclusion === 'success' && accepted ? 'passed' : 'unverified'
      : candidates.length ? 'stale' : 'unverified';
    return { name, projectKey, state, producer: exact?.producer_app_id ?? null, environment: exact?.environment ?? null,
      sourceUrl: exact?.source_url ?? null, proofAccepted: Boolean(accepted) };
  });
  const status = !headPinned || impact.status === 'stale' || checks.some((entry) => entry.state === 'stale') ? 'stale'
    : checks.some((entry) => entry.state === 'failed') ? 'failed'
    : checks.some((entry) => entry.state === 'unverified') || !checks.length
      || (impact.affected ?? []).some((entry) => entry.status !== 'confirmed') ? 'unverified' : 'passed';
  const lines = [
    '<!-- aipi-team-report -->',
    '### AIPI cross-repository verification',
    `Status: **${status}** · Head: \`${pr.head_sha}\``,
    `Changed contract: \`${reportText(pr.changed_project_key)}/${reportText(pr.changed_node_key)}\``,
    `Task: ${task ? `${reportText(task.title)} (${reportText(task.status, 40)})` : 'not linked'}`,
    `Affected repositories: ${(impact.affected ?? []).map((item) => `\`${reportText(item.projectKey)}\` (${reportText(item.status, 40)})`).join(', ') || 'none confirmed'}`,
    '',
    '| Required check | Result | Producer / environment |',
    '| --- | --- | --- |',
    ...checks.map((item) => `| ${reportText(item.projectKey)}: ${reportText(item.name)} | ${item.state} | ${reportText(item.producer ?? '—')} / ${reportText(item.environment ?? '—')} |`),
    '',
    `Evidence (unverified source citations): ${(impact.affected ?? []).flatMap((item) => item.sourceRefs ?? []).slice(0, 20).map(item => reportText(item, 500)).join(', ') || 'none'}`,
  ];
  const markdown = lines.join('\n');
  return { status, checks, markdown, hash: crypto.createHash('sha256').update(markdown).digest('hex'), headPinned };
}
