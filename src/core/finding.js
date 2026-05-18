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
