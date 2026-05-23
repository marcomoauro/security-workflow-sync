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
    vulnerable_version_range: '< 4.17.21',
    first_patched_version: { identifier: '4.17.21' },
  },
  dependency: {
    package: { name: 'lodash', ecosystem: 'npm' },
    manifest_path: 'package.json',
    scope: 'runtime',
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
      vulnerableVersionRange: '< 4.17.21',
      manifestPaths: ['package.json'],
    });
    expect(findings[0].dedupId).toMatch(/^[0-9a-f]{12}$/);
    expect(findings[0].advisoryUrl).toContain('GHSA-aaaa-bbbb-cccc');
  });

  it('produces empty manifestPaths when dependency.manifest_path is missing', async () => {
    const alert = sampleAlert();
    delete alert.dependency;
    const fetchImpl = mockFetch([[alert]]);
    const findings = await fetchDependabotFindings({ org: 'o', token: 't', fetchImpl });
    expect(findings[0].manifestPaths).toEqual([]);
  });

  it('produces null vulnerableVersionRange when not provided by the API', async () => {
    const alert = sampleAlert();
    delete alert.security_vulnerability.vulnerable_version_range;
    const fetchImpl = mockFetch([[alert]]);
    const findings = await fetchDependabotFindings({ org: 'o', token: 't', fetchImpl });
    expect(findings[0].vulnerableVersionRange).toBeNull();
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

  it('when includeRepos is set, hits the repo-level endpoint for each repo (not the org-level one)', async () => {
    // One alert per repo. mockFetch ignores URL; we'll inspect the URLs separately.
    const fetchImpl = vi.fn(async (url) => {
      const urlStr = url.toString();
      return {
        ok: true,
        status: 200,
        json: async () => urlStr.includes('/repos/o/r1/') ? [sampleAlert({ number: 10 })]
                       : urlStr.includes('/repos/o/r2/') ? [sampleAlert({ number: 20 })]
                       : [],
        text: async () => '[]',
        headers: { get: () => null }, // no next page
      };
    });

    const findings = await fetchDependabotFindings({
      org: 'o', token: 't', fetchImpl,
      includeRepos: ['o/r1', 'o/r2'],
    });

    expect(findings).toHaveLength(2);

    const urls = fetchImpl.mock.calls.map(c => c[0].toString());
    expect(urls.some(u => u.includes('/repos/o/r1/dependabot/alerts'))).toBe(true);
    expect(urls.some(u => u.includes('/repos/o/r2/dependabot/alerts'))).toBe(true);
    // Org-level endpoint must NOT be hit when includeRepos is set
    expect(urls.some(u => u.includes('/orgs/o/dependabot/alerts'))).toBe(false);
  });

  it('per-repo fetch logs progress prefixed with the repo name', async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true, status: 200,
      json: async () => [sampleAlert()],
      text: async () => '[]',
      headers: { get: () => null },
    }));
    const logger = { info: vi.fn(), warn() {}, error() {} };

    await fetchDependabotFindings({
      org: 'o', token: 't', fetchImpl, logger,
      includeRepos: ['acme/web-app'],
    });

    const messages = logger.info.mock.calls.map(c => c[0]);
    expect(messages.some(m => m.startsWith('Fetching Dependabot alerts for 1 included repo(s)'))).toBe(true);
    expect(messages.some(m => m.startsWith('acme/web-app page 1:'))).toBe(true);
  });

  it('fills the repository field from the URL when the API response omits it (repo-level)', async () => {
    // Repo-level Dependabot responses may omit the `repository` object since it's
    // implied by the URL. Verify we fill it from the include list.
    const fetchImpl = vi.fn(async () => ({
      ok: true, status: 200,
      json: async () => [{
        ...sampleAlert(),
        repository: undefined, // simulate missing field
      }],
      text: async () => '[]',
      headers: { get: () => null },
    }));

    const findings = await fetchDependabotFindings({
      org: 'o', token: 't', fetchImpl,
      includeRepos: ['acme/billing-service'],
    });

    expect(findings[0].repository).toBe('acme/billing-service');
  });
});
