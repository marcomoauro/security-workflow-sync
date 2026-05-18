import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createAsanaProvider } from '../../../src/providers/asana/provider.js';

function fakeClient() {
  return {
    request: vi.fn(),
    paginate: vi.fn(),
  };
}

function setupContext(client) {
  // 1. custom_field_settings
  client.request.mockImplementation(async (method, path) => {
    if (path.includes('/custom_field_settings')) {
      return [
        { custom_field: { gid: 'cf-dedup', name: 'Deduplication ID', resource_subtype: 'text' } },
        { custom_field: { gid: 'cf-sev', name: 'Severity', resource_subtype: 'enum', enum_options: [
          { gid: 'sev-crit', name: 'Critical' }, { gid: 'sev-high', name: 'High' },
          { gid: 'sev-med', name: 'Medium' }, { gid: 'sev-low', name: 'Low' },
        ] } },
        { custom_field: { gid: 'cf-repo', name: 'Repository', resource_subtype: 'enum', enum_options: [
          { gid: 'repo-1', name: 'org/repo-1' },
        ] } },
        { custom_field: { gid: 'cf-pkg', name: 'Package', resource_subtype: 'enum', enum_options: [] } },
        { custom_field: { gid: 'cf-adv', name: 'Advisory', resource_subtype: 'text' } },
        { custom_field: { gid: 'cf-advurl', name: 'Advisory URL', resource_subtype: 'text' } },
        { custom_field: { gid: 'cf-team', name: 'Tech Team', resource_subtype: 'enum', enum_options: [
          { gid: 'team-platform', name: 'Platform' },
        ] } },
      ];
    }
    if (path.endsWith('/sections')) {
      return [
        { gid: 'sec-team', name: 'Team Assignment' },
        { gid: 'sec-crit', name: 'Critical' },
        { gid: 'sec-high', name: 'High' },
        { gid: 'sec-med', name: 'Medium' },
        { gid: 'sec-low', name: 'Low' },
      ];
    }
    throw new Error(`unmocked request ${method} ${path}`);
  });
}

describe('AsanaProvider.createTicket', () => {
  let client, provider;
  beforeEach(() => {
    client = fakeClient();
    provider = createAsanaProvider({ client, projectGid: 'P', logger: { info() {}, warn() {}, error() {} } });
    setupContext(client);
    client.paginate.mockReturnValue((async function* () {})());
  });

  it('creates a task with all custom fields, in the severity section, and assigns Tech Team when repo is mapped', async () => {
    // Pre-populate team mapping for repo-1
    await provider.loadContext();
    provider._ctx.teamMapping.set('org/repo-1', 'team-platform');

    // After loadContext, override request to handle the actual creation call
    // Default setupContext mock will already handle field/section lookups — we just need POST /tasks to succeed.
    client.request.mockImplementation(async (method, path, body) => {
      if (path === '/tasks' && method === 'POST') return { gid: 'NEW' };
      // re-run setupContext defaults
      if (path.includes('/custom_field_settings')) return [
        { custom_field: { gid: 'cf-dedup', name: 'Deduplication ID', resource_subtype: 'text' } },
        { custom_field: { gid: 'cf-sev', name: 'Severity', resource_subtype: 'enum', enum_options: [
          { gid: 'sev-crit', name: 'Critical' }, { gid: 'sev-high', name: 'High' },
          { gid: 'sev-med', name: 'Medium' }, { gid: 'sev-low', name: 'Low' },
        ] } },
        { custom_field: { gid: 'cf-repo', name: 'Repository', resource_subtype: 'enum', enum_options: [
          { gid: 'repo-1', name: 'org/repo-1' },
        ] } },
        { custom_field: { gid: 'cf-pkg', name: 'Package', resource_subtype: 'enum', enum_options: [] } },
        { custom_field: { gid: 'cf-adv', name: 'Advisory', resource_subtype: 'text' } },
        { custom_field: { gid: 'cf-advurl', name: 'Advisory URL', resource_subtype: 'text' } },
        { custom_field: { gid: 'cf-team', name: 'Tech Team', resource_subtype: 'enum', enum_options: [
          { gid: 'team-platform', name: 'Platform' },
        ] } },
      ];
      if (path.endsWith('/sections')) return [
        { gid: 'sec-team', name: 'Team Assignment' },
        { gid: 'sec-crit', name: 'Critical' },
        { gid: 'sec-high', name: 'High' },
        { gid: 'sec-med', name: 'Medium' },
        { gid: 'sec-low', name: 'Low' },
      ];
      // If we hit the package enum option upsert for 'lodash' that doesn't exist yet,
      // return a fake new gid so we don't blow up.
      if (path === '/custom_fields/cf-pkg/enum_options') return { gid: 'pkg-lodash', name: body.name };
      return {};
    });

    const finding = {
      dedupId: 'abc123def456',
      source: 'github',
      externalId: 'GHSA-x',
      repository: 'org/repo-1',
      packageName: 'lodash',
      severity: 'HIGH',
      title: 'Prototype pollution',
      advisoryUrl: 'https://github.com/advisories/GHSA-x',
      remediation: '4.17.21',
    };

    const out = await provider.createTicket(finding);
    expect(out.action).toBe('created');

    const createCall = client.request.mock.calls.find(c => c[0] === 'POST' && c[1] === '/tasks');
    expect(createCall).toBeDefined();
    const payload = createCall[2];
    expect(payload.projects).toEqual(['P']);
    expect(payload.memberships).toEqual([{ project: 'P', section: 'sec-high' }]);
    expect(payload.custom_fields['cf-dedup']).toBe('abc123def456');
    expect(payload.custom_fields['cf-sev']).toBe('sev-high');
    expect(payload.custom_fields['cf-repo']).toBe('repo-1');
    expect(payload.custom_fields['cf-adv']).toBe('GHSA-x');
    expect(payload.custom_fields['cf-advurl']).toBe('https://github.com/advisories/GHSA-x');
    expect(payload.custom_fields['cf-team']).toBe('team-platform');
  });

  it('creates a new Package enum option when the package is unseen', async () => {
    await provider.loadContext();
    client.request.mockImplementation(async (method, path, body) => {
      if (method === 'POST' && path === '/custom_fields/cf-pkg/enum_options') return { gid: 'pkg-new', name: body.name };
      if (method === 'POST' && path === '/tasks') return { gid: 'NEW' };
      // For loadContext re-invocations during this call we already finished; keep the defaults available
      if (path.includes('/custom_field_settings')) return [
        { custom_field: { gid: 'cf-dedup', name: 'Deduplication ID', resource_subtype: 'text' } },
        { custom_field: { gid: 'cf-sev', name: 'Severity', resource_subtype: 'enum', enum_options: [
          { gid: 'sev-crit', name: 'Critical' }, { gid: 'sev-high', name: 'High' },
          { gid: 'sev-med', name: 'Medium' }, { gid: 'sev-low', name: 'Low' },
        ] } },
        { custom_field: { gid: 'cf-repo', name: 'Repository', resource_subtype: 'enum', enum_options: [
          { gid: 'repo-1', name: 'org/repo-1' },
        ] } },
        { custom_field: { gid: 'cf-pkg', name: 'Package', resource_subtype: 'enum', enum_options: [] } },
        { custom_field: { gid: 'cf-adv', name: 'Advisory', resource_subtype: 'text' } },
        { custom_field: { gid: 'cf-advurl', name: 'Advisory URL', resource_subtype: 'text' } },
        { custom_field: { gid: 'cf-team', name: 'Tech Team', resource_subtype: 'enum', enum_options: [] } },
      ];
      if (path.endsWith('/sections')) return [
        { gid: 'sec-team', name: 'Team Assignment' },
        { gid: 'sec-crit', name: 'Critical' },
        { gid: 'sec-high', name: 'High' },
        { gid: 'sec-med', name: 'Medium' },
        { gid: 'sec-low', name: 'Low' },
      ];
      return {};
    });

    const finding = {
      dedupId: 'd', source: 'github', externalId: 'GHSA-y', repository: 'org/repo-1',
      packageName: 'brand-new-package', severity: 'LOW', title: 't', advisoryUrl: 'u', remediation: null,
    };
    await provider.createTicket(finding);
    const optCall = client.request.mock.calls.find(c => c[1] === '/custom_fields/cf-pkg/enum_options');
    expect(optCall[2]).toEqual({ name: 'brand-new-package' });
    expect(provider._ctx.fields['Package'].options.get('brand-new-package')).toBe('pkg-new');
  });

  it('omits Tech Team when repo has no mapping', async () => {
    await provider.loadContext();
    client.request.mockImplementation(async (method, path, body) => {
      if (method === 'POST' && path === '/tasks') return { gid: 'NEW' };
      if (method === 'POST' && path.includes('/enum_options')) return { gid: 'new-opt', name: body.name };
      return {};
    });

    const finding = {
      dedupId: 'e', source: 'github', externalId: 'GHSA-z', repository: 'org/unmapped',
      packageName: 'lodash', severity: 'MEDIUM', title: 't', advisoryUrl: 'u', remediation: null,
    };
    await provider.createTicket(finding);
    const createCall = client.request.mock.calls.find(c => c[0] === 'POST' && c[1] === '/tasks');
    expect(createCall[2].custom_fields['cf-team']).toBeUndefined();
  });
});

describe('AsanaProvider.loadContext + listExistingTickets', () => {
  let client, provider;
  beforeEach(() => {
    client = fakeClient();
    provider = createAsanaProvider({ client, projectGid: 'P', logger: { info() {}, warn() {}, error() {} } });
  });

  it('loadContext fetches fields and sections and maps them by name', async () => {
    setupContext(client);
    client.paginate.mockReturnValue((async function* () {})());

    await provider.loadContext();
    const paths = client.request.mock.calls.map(c => c[1]);
    expect(paths.some(p => p.includes('/custom_field_settings'))).toBe(true);
    expect(paths.some(p => p.endsWith('/sections'))).toBe(true);
  });

  it('listExistingTickets returns a Map keyed by dedup ID', async () => {
    setupContext(client);
    client.paginate.mockImplementation((path) => {
      if (path.startsWith('/sections/sec-team/')) return (async function* () {})();
      if (path.includes('/tasks')) {
        return (async function* () {
          yield {
            gid: 'T1',
            name: '[High] lodash – org/repo-1',
            completed: false,
            custom_fields: [
              { gid: 'cf-dedup', text_value: 'abc123def456' },
              { gid: 'cf-sev', enum_value: { gid: 'sev-high', name: 'High' } },
              { gid: 'cf-repo', enum_value: { gid: 'repo-1', name: 'org/repo-1' } },
              { gid: 'cf-team', enum_value: { gid: 'team-platform', name: 'Platform' } },
            ],
            memberships: [{ section: { gid: 'sec-high' } }],
          };
          yield {
            gid: 'T2',
            name: 'random task without dedup id',
            completed: false,
            custom_fields: [{ gid: 'cf-dedup', text_value: null }],
            memberships: [{ section: { gid: 'sec-high' } }],
          };
        })();
      }
      return (async function* () {})();
    });

    await provider.loadContext();
    const existing = await provider.listExistingTickets();
    expect(existing.size).toBe(1);
    expect(existing.get('abc123def456')).toMatchObject({
      gid: 'T1', completed: false, dedupId: 'abc123def456',
    });
  });
});

describe('AsanaProvider.updateTicket', () => {
  let client, provider;
  beforeEach(async () => {
    client = fakeClient();
    provider = createAsanaProvider({ client, projectGid: 'P', logger: { info() {}, warn() {}, error() {} } });
    setupContext(client);
    client.paginate.mockReturnValue((async function* () {})());
    await provider.loadContext();
  });

  function findingFor(overrides = {}) {
    return {
      dedupId: 'd', source: 'github', externalId: 'GHSA-x', repository: 'org/repo-1',
      packageName: 'lodash', severity: 'HIGH', title: 't',
      advisoryUrl: 'https://github.com/advisories/GHSA-x', remediation: '4.17.21',
      ...overrides,
    };
  }

  it('returns noop when the existing task already matches and is open', async () => {
    const existing = {
      gid: 'T1', dedupId: 'd', completed: false,
      customFields: [
        { gid: 'cf-sev', enum_value: { gid: 'sev-high' } },
        { gid: 'cf-team', enum_value: { gid: 'team-platform' } },
      ],
      sectionGids: ['sec-high'],
    };
    provider._ctx.teamMapping.set('org/repo-1', 'team-platform');

    client.request.mockResolvedValue({});
    const out = await provider.updateTicket(findingFor(), existing);
    expect(out.action).toBe('noop');
    // No PUT issued
    expect(client.request.mock.calls.find(c => c[0] === 'PUT' && c[1].startsWith('/tasks/'))).toBeUndefined();
  });

  it('reopens a completed task and adds a story', async () => {
    const existing = {
      gid: 'T1', dedupId: 'd', completed: true,
      customFields: [{ gid: 'cf-sev', enum_value: { gid: 'sev-high' } }],
      sectionGids: ['sec-high'],
    };
    client.request.mockResolvedValue({});
    const out = await provider.updateTicket(findingFor(), existing);
    expect(out.action).toBe('reopened');
    const putCall = client.request.mock.calls.find(c => c[0] === 'PUT' && c[1] === '/tasks/T1');
    expect(putCall[2].completed).toBe(false);
    const storyCall = client.request.mock.calls.find(c => c[1] === '/tasks/T1/stories');
    expect(storyCall[2].text).toMatch(/reopened/i);
  });

  it('moves the task to the new severity section when severity changed', async () => {
    const existing = {
      gid: 'T1', dedupId: 'd', completed: false,
      customFields: [{ gid: 'cf-sev', enum_value: { gid: 'sev-low' } }],
      sectionGids: ['sec-low'],
    };
    client.request.mockResolvedValue({});
    const out = await provider.updateTicket(findingFor({ severity: 'HIGH' }), existing);
    expect(out.action).toBe('updated');
    const moveCall = client.request.mock.calls.find(c => c[1] === '/sections/sec-high/addTask');
    expect(moveCall).toBeDefined();
    expect(moveCall[2]).toEqual({ task: 'T1' });
  });

  it('preserves an existing Tech Team assignment even when the repo mapping is now empty (append-only)', async () => {
    const existing = {
      gid: 'T1', dedupId: 'd', completed: false,
      customFields: [
        { gid: 'cf-sev', enum_value: { gid: 'sev-high' } },
        { gid: 'cf-team', enum_value: { gid: 'team-platform' } }, // already assigned
      ],
      sectionGids: ['sec-high'],
    };
    // No mapping in ctx → mapping says "no team"
    client.request.mockResolvedValue({});
    const out = await provider.updateTicket(findingFor(), existing);

    // Must not have overwritten the Tech Team field
    const putCall = client.request.mock.calls.find(c => c[0] === 'PUT' && c[1] === '/tasks/T1');
    if (putCall) {
      expect(putCall[2].custom_fields?.['cf-team']).toBeUndefined();
    }
    expect(['noop', 'updated']).toContain(out.action);
  });

  it('assigns Tech Team if the existing task lacks it and the repo is now mapped', async () => {
    const existing = {
      gid: 'T1', dedupId: 'd', completed: false,
      customFields: [
        { gid: 'cf-sev', enum_value: { gid: 'sev-high' } },
        // no cf-team
      ],
      sectionGids: ['sec-high'],
    };
    provider._ctx.teamMapping.set('org/repo-1', 'team-platform');
    client.request.mockResolvedValue({});
    const out = await provider.updateTicket(findingFor(), existing);
    expect(out.action).toBe('updated');
    const putCall = client.request.mock.calls.find(c => c[0] === 'PUT' && c[1] === '/tasks/T1');
    expect(putCall[2].custom_fields['cf-team']).toBe('team-platform');
  });
});

describe('AsanaProvider.closeTicket', () => {
  let client, provider;
  beforeEach(async () => {
    client = fakeClient();
    provider = createAsanaProvider({ client, projectGid: 'P', logger: { info() {}, warn() {}, error() {} } });
    setupContext(client);
    client.paginate.mockReturnValue((async function* () {})());
    await provider.loadContext();
  });

  it('completes the task and writes a story', async () => {
    client.request.mockResolvedValue({});
    const out = await provider.closeTicket({ gid: 'T1', dedupId: 'd', completed: false });
    expect(out.action).toBe('closed');
    const putCall = client.request.mock.calls.find(c => c[0] === 'PUT' && c[1] === '/tasks/T1');
    expect(putCall[2].completed).toBe(true);
    const storyCall = client.request.mock.calls.find(c => c[1] === '/tasks/T1/stories');
    expect(storyCall[2].text).toMatch(/resolved|fixed|dismissed|closed/i);
  });
});
