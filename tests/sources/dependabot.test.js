import { describe, it, expect, vi } from 'vitest';
import { fetchDependabotFindings } from '../../src/sources/dependabot.js';

function mockFetch(pages) {
  // pages: array of arrays — each element is one page response
  let i = 0;
  return vi.fn(async () => {
    const body = pages[i] ?? [];
    const hasNext = i < pages.length - 1;
    i++;
    return {
      ok: true,
      status: 200,
      json: async () => body,
      text: async () => JSON.stringify(body),
      headers: {
        get: (h) => h.toLowerCase() === 'link' && hasNext
          ? '<https://api.github.com/orgs/o/dependabot/alerts?page=2>; rel="next"'
          : null,
      },
    };
  });
}

const sampleAlert = (overrides = {}) => ({
  number: 1,
  state: 'open',
  security_advisory: {
    ghsa_id: 'GHSA-aaaa-bbbb-cccc',
    summary: 'Prototype pollution in lodash',
    severity: 'high',
    cve_id: 'CVE-2024-0001',
  },
  security_vulnerability: {
    package: { name: 'lodash', ecosystem: 'npm' },
    first_patched_version: { identifier: '4.17.21' },
  },
  html_url: 'https://github.com/o/r/security/dependabot/1',
  repository: { full_name: 'o/r' },
  ...overrides,
});

describe('fetchDependabotFindings', () => {
  it('maps Dependabot alerts to SecurityFinding[]', async () => {
    const fetchImpl = mockFetch([[sampleAlert()]]);
    const findings = await fetchDependabotFindings({ org: 'o', token: 't', fetchImpl });
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      source: 'github',
      externalId: 'GHSA-aaaa-bbbb-cccc',
      repository: 'o/r',
      packageName: 'lodash',
      ecosystem: 'npm',
      severity: 'HIGH',
      state: 'OPEN',
      remediation: '4.17.21',
    });
    expect(findings[0].dedupId).toMatch(/^[0-9a-f]{12}$/);
    expect(findings[0].advisoryUrl).toContain('GHSA-aaaa-bbbb-cccc');
  });

  it('marks non-open alerts as FIXED', async () => {
    const fetchImpl = mockFetch([[
      sampleAlert({ state: 'fixed' }),
      sampleAlert({ number: 2, state: 'dismissed' }),
      sampleAlert({ number: 3, state: 'auto_dismissed' }),
    ]]);
    const findings = await fetchDependabotFindings({ org: 'o', token: 't', fetchImpl });
    expect(findings.every(f => f.state === 'FIXED')).toBe(true);
  });

  it('follows pagination via Link header', async () => {
    const fetchImpl = mockFetch([
      [sampleAlert({ number: 1 })],
      [sampleAlert({ number: 2, security_advisory: { ghsa_id: 'GHSA-zzzz', summary: 'x', severity: 'low' }, security_vulnerability: { package: { name: 'axios', ecosystem: 'npm' } } })],
    ]);
    const findings = await fetchDependabotFindings({ org: 'o', token: 't', fetchImpl });
    expect(findings).toHaveLength(2);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('uses normalized severity (moderate→MEDIUM)', async () => {
    const fetchImpl = mockFetch([[sampleAlert({ security_advisory: { ghsa_id: 'GHSA-x', summary: 's', severity: 'moderate' } })]]);
    const findings = await fetchDependabotFindings({ org: 'o', token: 't', fetchImpl });
    expect(findings[0].severity).toBe('MEDIUM');
  });

  it('logs a progress line per page, with hasNext on intermediate pages and not on the last', async () => {
    const fetchImpl = mockFetch([
      [sampleAlert({ number: 1 })],
      [sampleAlert({ number: 2 })],
      [sampleAlert({ number: 3 })],
    ]);
    const logger = { info: vi.fn(), warn() {}, error() {} };

    await fetchDependabotFindings({ org: 'o', token: 't', fetchImpl, logger });

    const messages = logger.info.mock.calls.map(c => c[0]);
    const pageMessages = messages.filter(m => m.startsWith('Dependabot page '));
    expect(pageMessages).toHaveLength(3);
    expect(pageMessages[0]).toMatch(/^Dependabot page 1: 1 alerts, more pages to follow\.$/);
    expect(pageMessages[1]).toMatch(/^Dependabot page 2: 1 alerts, more pages to follow\.$/);
    expect(pageMessages[2]).toMatch(/^Dependabot page 3: 1 alerts, last page\.$/);
  });
});
