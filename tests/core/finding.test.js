import { describe, it, expect } from 'vitest';
import { dedupId, normalizeSeverity } from '../../src/core/finding.js';

describe('dedupId', () => {
  it('is stable for the same identity tuple', () => {
    const a = dedupId({ source: 'github', repository: 'org/repo', packageName: 'lodash', externalId: 'GHSA-1' });
    const b = dedupId({ source: 'github', repository: 'org/repo', packageName: 'lodash', externalId: 'GHSA-1' });
    expect(a).toBe(b);
  });

  it('differs when repository differs', () => {
    const a = dedupId({ source: 'github', repository: 'org/a', packageName: 'lodash', externalId: 'GHSA-1' });
    const b = dedupId({ source: 'github', repository: 'org/b', packageName: 'lodash', externalId: 'GHSA-1' });
    expect(a).not.toBe(b);
  });

  it('differs when package differs', () => {
    const a = dedupId({ source: 'github', repository: 'org/r', packageName: 'lodash', externalId: 'GHSA-1' });
    const b = dedupId({ source: 'github', repository: 'org/r', packageName: 'axios', externalId: 'GHSA-1' });
    expect(a).not.toBe(b);
  });

  it('is 12 hex chars', () => {
    const id = dedupId({ source: 'github', repository: 'org/r', packageName: 'p', externalId: 'GHSA-1' });
    expect(id).toMatch(/^[0-9a-f]{12}$/);
  });
});

describe('normalizeSeverity', () => {
  it('uppercases known GitHub severities', () => {
    expect(normalizeSeverity('critical')).toBe('CRITICAL');
    expect(normalizeSeverity('High')).toBe('HIGH');
    expect(normalizeSeverity('moderate')).toBe('MEDIUM'); // GitHub uses "moderate"
    expect(normalizeSeverity('low')).toBe('LOW');
  });

  it('defaults unknown to MEDIUM', () => {
    expect(normalizeSeverity('???')).toBe('MEDIUM');
    expect(normalizeSeverity(undefined)).toBe('MEDIUM');
  });
});
