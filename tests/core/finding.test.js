import { describe, it, expect } from 'vitest';
import { dedupId, normalizeSeverity, filterFindings, mergeFindingsByDedupId } from '../../src/core/finding.js';

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

describe('filterFindings', () => {
  const findings = [
    { repository: 'org/a', dedupId: '1' },
    { repository: 'org/b', dedupId: '2' },
    { repository: 'org/c', dedupId: '3' },
    { repository: 'org/d', dedupId: '4' },
  ];

  it('returns everything when no include or exclude is given', () => {
    expect(filterFindings(findings)).toHaveLength(4);
    expect(filterFindings(findings, {})).toHaveLength(4);
    expect(filterFindings(findings, { include: [], exclude: [] })).toHaveLength(4);
  });

  it('keeps only repos in the include list', () => {
    const out = filterFindings(findings, { include: ['org/a', 'org/c'] });
    expect(out.map(f => f.repository)).toEqual(['org/a', 'org/c']);
  });

  it('drops repos in the exclude list', () => {
    const out = filterFindings(findings, { exclude: ['org/b', 'org/d'] });
    expect(out.map(f => f.repository)).toEqual(['org/a', 'org/c']);
  });

  it('applies include first, then exclude (intersection minus exclude)', () => {
    const out = filterFindings(findings, {
      include: ['org/a', 'org/b', 'org/c'],
      exclude: ['org/b'],
    });
    expect(out.map(f => f.repository)).toEqual(['org/a', 'org/c']);
  });

  it('drops findings without a repository when include is set', () => {
    const noRepoFindings = [...findings, { repository: '', dedupId: 'x' }, { dedupId: 'y' }];
    const out = filterFindings(noRepoFindings, { include: ['org/a'] });
    expect(out.map(f => f.dedupId)).toEqual(['1']);
  });

  it('keeps findings without a repository when only exclude is set', () => {
    const noRepoFindings = [...findings, { dedupId: 'y' }];
    const out = filterFindings(noRepoFindings, { exclude: ['org/a'] });
    expect(out.map(f => f.dedupId)).toEqual(['2', '3', '4', 'y']);
  });

  it('handles undefined entries inside the lists gracefully', () => {
    const out = filterFindings(findings, { include: ['org/a', null, undefined, ''] });
    expect(out.map(f => f.repository)).toEqual(['org/a']);
  });
});

describe('mergeFindingsByDedupId', () => {
  it('keeps findings with different dedupIds untouched', () => {
    const input = [
      { dedupId: 'a', state: 'OPEN' },
      { dedupId: 'b', state: 'FIXED' },
      { dedupId: 'c', state: 'OPEN' },
    ];
    const out = mergeFindingsByDedupId(input);
    expect(out).toHaveLength(3);
    expect(out.map(f => f.dedupId).sort()).toEqual(['a', 'b', 'c']);
  });

  it('when one alert is OPEN and one is FIXED on the same dedupId, OPEN wins', () => {
    const input = [
      { dedupId: 'a', state: 'FIXED', metadata: { alertNumber: 1 } },
      { dedupId: 'a', state: 'OPEN', metadata: { alertNumber: 2 } },
    ];
    const out = mergeFindingsByDedupId(input);
    expect(out).toHaveLength(1);
    expect(out[0].state).toBe('OPEN');
    expect(out[0].metadata.alertNumber).toBe(2);
  });

  it('OPEN-wins is independent of input order (OPEN first)', () => {
    const input = [
      { dedupId: 'a', state: 'OPEN', metadata: { alertNumber: 2 } },
      { dedupId: 'a', state: 'FIXED', metadata: { alertNumber: 1 } },
    ];
    const out = mergeFindingsByDedupId(input);
    expect(out).toHaveLength(1);
    expect(out[0].state).toBe('OPEN');
    expect(out[0].metadata.alertNumber).toBe(2);
  });

  it('keeps a FIXED finding when every alert for that dedupId is FIXED', () => {
    const input = [
      { dedupId: 'a', state: 'FIXED', metadata: { alertNumber: 1 } },
      { dedupId: 'a', state: 'FIXED', metadata: { alertNumber: 2 } },
    ];
    const out = mergeFindingsByDedupId(input);
    expect(out).toHaveLength(1);
    expect(out[0].state).toBe('FIXED');
  });

  it('handles three-way merge correctly (FIXED, FIXED, OPEN → OPEN)', () => {
    const input = [
      { dedupId: 'a', state: 'FIXED', metadata: { alertNumber: 1 } },
      { dedupId: 'a', state: 'FIXED', metadata: { alertNumber: 2 } },
      { dedupId: 'a', state: 'OPEN', metadata: { alertNumber: 3 } },
    ];
    const out = mergeFindingsByDedupId(input);
    expect(out).toHaveLength(1);
    expect(out[0].state).toBe('OPEN');
  });

  it('handles empty input', () => {
    expect(mergeFindingsByDedupId([])).toEqual([]);
  });
});
