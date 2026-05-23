import { createHash } from 'node:crypto';

export function dedupId({ source, repository, packageName, externalId }) {
  const key = `${source}:${repository}:${packageName}:${externalId}`;
  return createHash('sha1').update(key).digest('hex').slice(0, 12);
}

const SEVERITY_MAP = {
  critical: 'CRITICAL',
  high: 'HIGH',
  moderate: 'MEDIUM',
  medium: 'MEDIUM',
  low: 'LOW',
};

export function normalizeSeverity(input) {
  if (!input) return 'MEDIUM';
  return SEVERITY_MAP[String(input).toLowerCase()] ?? 'MEDIUM';
}

// Collapse multiple findings that share a dedupId into a single canonical finding.
// Dependabot can emit several alerts for the same (repo, package, advisory) tuple
// — e.g. when an old alert is dismissed and a new one is opened on the same
// vulnerability after a manifest change. Both alerts hash to the same dedupId
// but may report different states. Without merging, the reconcile loop's
// last-wins logic produces order-dependent yo-yo behavior between runs.
//
// Rule: OPEN beats FIXED. If any finding for a dedupId is OPEN, the merged finding
// is OPEN. Only when every finding for a dedupId is FIXED do we keep a FIXED one.
export function mergeFindingsByDedupId(findings) {
  const byKey = new Map();
  for (const f of findings) {
    const existing = byKey.get(f.dedupId);
    if (!existing) {
      byKey.set(f.dedupId, f);
      continue;
    }
    if (existing.state !== 'OPEN' && f.state === 'OPEN') {
      byKey.set(f.dedupId, f);
    }
  }
  return Array.from(byKey.values());
}

// Filter findings by repository name (exact match on `owner/repo`).
// Semantics (matches rsync's include/exclude):
//   - If `include` is non-empty, only findings whose repository is in `include` survive.
//   - Then, any finding whose repository is in `exclude` is removed.
//   - Empty/missing lists mean "no filter on that axis".
// Findings whose repository field is missing or empty are dropped when an include
// filter is set (they can't possibly match) and kept otherwise.
export function filterFindings(findings, { include = [], exclude = [] } = {}) {
  const includeSet = new Set((include ?? []).filter(Boolean));
  const excludeSet = new Set((exclude ?? []).filter(Boolean));

  let result = findings;
  if (includeSet.size > 0) {
    result = result.filter(f => f.repository && includeSet.has(f.repository));
  }
  if (excludeSet.size > 0) {
    result = result.filter(f => !excludeSet.has(f.repository));
  }
  return result;
}
