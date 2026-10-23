import path from 'node:path';
import { primarySourceId } from './workspace-identity.mjs';
import { SOURCE_INDEX_VERSION } from '../contract-engine/incremental-index.mjs';

const sha = value => typeof value === 'string' && /^[a-f0-9]{40}$/i.test(value);
const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/i.test(value);

// Portable identity only comes from an attached source binding. A single
// legacy root has the deterministic primary identity; multiple unnamed roots
// stay ambiguous instead of inheriting that primary ID.
export function sourceProvenanceForTarget(project, { root = null, sourceBindingId: declaredSourceBindingId = null,
  contentHash = null, evidenceKind = 'extracted-code-fact' } = {}) {
  const roots = project?.sourceContext?.roots ?? [];
  const selected = root ? roots.filter(item => item?.path && path.resolve(item.path) === path.resolve(root))
    : declaredSourceBindingId ? roots.filter(item => item?.sourceBindingId === declaredSourceBindingId)
    : roots.length === 1 ? [roots[0]] : [];
  const selectedRoot = selected.length === 1 ? selected[0] : null;
  const bindingId = (declaredSourceBindingId && selectedRoot?.sourceBindingId !== declaredSourceBindingId ? null : selectedRoot?.sourceBindingId)
    ?? (selectedRoot && roots.length === 1 ? primarySourceId(project.id) : null);
  const binding = project?.sourceBindings?.find(item => item.id === bindingId && !item.supersededBy);
  const legacyPrimary = roots.length === 1 && bindingId === primarySourceId(project.id) && !(project?.sourceBindings?.length);
  const sourceBindingId = binding || legacyPrimary ? bindingId : null;
  const git = (project?.sourceContext?.git ?? []).find(item => selectedRoot?.path
    && [item.root, item.requestedRoot].some(value => value && path.resolve(value) === path.resolve(selectedRoot.path)));
  const revision = [git?.commit, binding?.trackingCommit, roots.length === 1 ? project?.sourceContext?.gitRevision : null].find(sha) ?? null;
  const analyzerVersion = `source-index:${SOURCE_INDEX_VERSION}`;
  return { sourceBindingId, revision, contentHash: digest(contentHash) ? contentHash : null,
    analyzerVersion, evidenceKind,
    provenanceStatus: sourceBindingId && revision && digest(contentHash) ? 'pinned' : 'incomplete' };
}
