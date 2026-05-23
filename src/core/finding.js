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
