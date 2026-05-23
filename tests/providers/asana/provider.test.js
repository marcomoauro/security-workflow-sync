import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createAsanaProvider, buildTaskName, buildTaskNotes } from '../../../src/providers/asana/provider.js';

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
        { custom_field: { gid: 'cf-dedup', name: 'SWS: Deduplication ID', resource_subtype: 'text' } },
        { custom_field: { gid: 'cf-sev', name: 'SWS: Severity', resource_subtype: 'enum', enum_options: [
          { gid: 'sev-crit', name: 'Critical' }, { gid: 'sev-high', name: 'High' },
          { gid: 'sev-med', name: 'Medium' }, { gid: 'sev-low', name: 'Low' },
        ] } },
        { custom_field: { gid: 'cf-repo', name: 'SWS: Repository', resource_subtype: 'enum', enum_options: [
          { gid: 'repo-1', name: 'org/repo-1' },
        ] } },
        { custom_field: { gid: 'cf-pkg', name: 'SWS: Package', resource_subtype: 'enum', enum_options: [] } },
        { custom_field: { gid: 'cf-adv', name: 'SWS: Advisory', resource_subtype: 'text' } },
        { custom_field: { gid: 'cf-advurl', name: 'SWS: Advisory URL', resource_subtype: 'text' } },
        { custom_field: { gid: 'cf-team', name: 'SWS: Tech Team', resource_subtype: 'enum', enum_options: [
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
        { custom_field: { gid: 'cf-dedup', name: 'SWS: Deduplication ID', resource_subtype: 'text' } },
        { custom_field: { gid: 'cf-sev', name: 'SWS: Severity', resource_subtype: 'enum', enum_options: [
          { gid: 'sev-crit', name: 'Critical' }, { gid: 'sev-high', name: 'High' },
          { gid: 'sev-med', name: 'Medium' }, { gid: 'sev-low', name: 'Low' },
        ] } },
        { custom_field: { gid: 'cf-repo', name: 'SWS: Repository', resource_subtype: 'enum', enum_options: [
          { gid: 'repo-1', name: 'org/repo-1' },
        ] } },
        { custom_field: { gid: 'cf-pkg', name: 'SWS: Package', resource_subtype: 'enum', enum_options: [] } },
        { custom_field: { gid: 'cf-adv', name: 'SWS: Advisory', resource_subtype: 'text' } },
        { custom_field: { gid: 'cf-advurl', name: 'SWS: Advisory URL', resource_subtype: 'text' } },
        { custom_field: { gid: 'cf-team', name: 'SWS: Tech Team', resource_subtype: 'enum', enum_options: [
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
        { custom_field: { gid: 'cf-dedup', name: 'SWS: Deduplication ID', resource_subtype: 'text' } },
        { custom_field: { gid: 'cf-sev', name: 'SWS: Severity', resource_subtype: 'enum', enum_options: [
          { gid: 'sev-crit', name: 'Critical' }, { gid: 'sev-high', name: 'High' },
          { gid: 'sev-med', name: 'Medium' }, { gid: 'sev-low', name: 'Low' },
        ] } },
        { custom_field: { gid: 'cf-repo', name: 'SWS: Repository', resource_subtype: 'enum', enum_options: [
          { gid: 'repo-1', name: 'org/repo-1' },
        ] } },
        { custom_field: { gid: 'cf-pkg', name: 'SWS: Package', resource_subtype: 'enum', enum_options: [] } },
        { custom_field: { gid: 'cf-adv', name: 'SWS: Advisory', resource_subtype: 'text' } },
        { custom_field: { gid: 'cf-advurl', name: 'SWS: Advisory URL', resource_subtype: 'text' } },
        { custom_field: { gid: 'cf-team', name: 'SWS: Tech Team', resource_subtype: 'enum', enum_options: [] } },
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
    expect(optCall[2].name).toBe('brand-new-package');
    expect(typeof optCall[2].color).toBe('string'); // color is deterministic; specific value covered by schema tests
    expect(provider._ctx.fields['SWS: Package'].options.get('brand-new-package')).toBe('pkg-new');
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
    const f = findingFor();
    const existing = {
      gid: 'T1', dedupId: 'd', completed: false,
      // name and notes must match what buildTask* would produce, otherwise the drift
      // detector forces a PUT to refresh them.
      name: buildTaskName(f),
      notes: buildTaskNotes(f),
      customFields: [
        { gid: 'cf-sev', enum_value: { gid: 'sev-high' } },
        { gid: 'cf-team', enum_value: { gid: 'team-platform' } },
      ],
      sectionGids: ['sec-high'],
    };
    provider._ctx.teamMapping.set('org/repo-1', 'team-platform');

    client.request.mockResolvedValue({});
    const out = await provider.updateTicket(f, existing);
    expect(out.action).toBe('noop');
    // No PUT issued
    expect(client.request.mock.calls.find(c => c[0] === 'PUT' && c[1].startsWith('/tasks/'))).toBeUndefined();
  });

  it('forces a PUT when the existing notes no longer match what we would generate (drift)', async () => {
    const f = findingFor();
    const existing = {
      gid: 'T1', dedupId: 'd', completed: false,
      name: buildTaskName(f),
      notes: 'Old notes from a previous schema — missing Vulnerable versions line, etc.',
      customFields: [
        { gid: 'cf-sev', enum_value: { gid: 'sev-high' } },
        { gid: 'cf-team', enum_value: { gid: 'team-platform' } },
      ],
      sectionGids: ['sec-high'],
    };
    provider._ctx.teamMapping.set('org/repo-1', 'team-platform');

    client.request.mockResolvedValue({});
    const out = await provider.updateTicket(f, existing);
    expect(out.action).toBe('updated');
    const putCall = client.request.mock.calls.find(c => c[0] === 'PUT' && c[1] === '/tasks/T1');
    expect(putCall).toBeDefined();
    expect(putCall[2].notes).toBe(buildTaskNotes(f));
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

describe('AsanaProvider.ensureTeamAssignmentTasks', () => {
  let client, provider, logger;
  beforeEach(async () => {
    client = fakeClient();
    logger = { info: vi.fn(), warn() {}, error() {} };
    provider = createAsanaProvider({ client, projectGid: 'P', logger });
    setupContext(client);
    client.paginate.mockReturnValue((async function* () {})());
    await provider.loadContext();
  });

  it('creates a placeholder task for each unseen repository in the Team Assignment section', async () => {
    // Pretend we already have a Team Assignment for org/repo-1
    provider._ctx.teamMapping.set('org/repo-1', 'team-platform');
    // Add a known placeholder name set
    provider._ctx.knownTeamAssignmentRepos = new Set(['org/repo-1']);

    client.request.mockImplementation(async (method, path, body) => {
      if (path === '/custom_fields/cf-repo/enum_options') return { gid: 'repo-2', name: body.name };
      if (path === '/tasks') return { gid: 'NEW' };
      return {};
    });

    await provider.ensureTeamAssignmentTasks(['org/repo-1', 'org/repo-2']);

    const postTasks = client.request.mock.calls.filter(c => c[0] === 'POST' && c[1] === '/tasks');
    expect(postTasks).toHaveLength(1);
    expect(postTasks[0][2]).toMatchObject({
      name: 'org/repo-2',
      projects: ['P'],
      memberships: [{ project: 'P', section: 'sec-team' }],
      custom_fields: { 'cf-repo': 'repo-2' },
    });
  });

  it('logs progress for each placeholder created with a counter', async () => {
    provider._ctx.knownTeamAssignmentRepos = new Set();
    client.request.mockImplementation(async (method, path, body) => {
      if (path.startsWith('/custom_fields/') && path.endsWith('/enum_options')) {
        return { gid: `opt-${body.name}`, name: body.name };
      }
      if (path === '/tasks') return { gid: 'NEW' };
      return {};
    });

    await provider.ensureTeamAssignmentTasks(['a/repo', 'b/repo', 'c/repo']);

    const messages = logger.info.mock.calls.map(c => c[0]);
    const perItem = messages.filter(m => /^Team Assignment placeholder \d+\/\d+:/.test(m));
    expect(perItem).toHaveLength(3);
    expect(perItem[0]).toBe('Team Assignment placeholder 1/3: "a/repo".');
    expect(perItem[1]).toBe('Team Assignment placeholder 2/3: "b/repo".');
    expect(perItem[2]).toBe('Team Assignment placeholder 3/3: "c/repo".');
  });

  it('logs a "nothing to do" message when all repos are already known', async () => {
    provider._ctx.knownTeamAssignmentRepos = new Set(['a/repo', 'b/repo']);
    await provider.ensureTeamAssignmentTasks(['a/repo', 'b/repo']);

    const messages = logger.info.mock.calls.map(c => c[0]);
    expect(messages).toContain('All repositories already have a Team Assignment placeholder.');
    // No POST /tasks should have been issued
    expect(client.request.mock.calls.find(c => c[0] === 'POST' && c[1] === '/tasks')).toBeUndefined();
  });
});

describe('AsanaProvider.ensureEnumOption (case-insensitive caching)', () => {
  let client, provider;
  beforeEach(async () => {
    client = fakeClient();
    provider = createAsanaProvider({ client, projectGid: 'P', logger: { info() {}, warn() {}, error() {} } });
  });

  it('reuses an existing option when the package name only differs in case (Werkzeug vs werkzeug)', async () => {
    // setupContext seeds Severity with options Critical/High/Medium/Low.
    // Simulate the existing Package field having "Werkzeug" already as an option.
    client.request.mockImplementation(async (method, path) => {
      if (path.includes('/custom_field_settings')) {
        return [
          { custom_field: { gid: 'cf-dedup', name: 'SWS: Deduplication ID', resource_subtype: 'text' } },
          { custom_field: { gid: 'cf-sev', name: 'SWS: Severity', resource_subtype: 'enum', enum_options: [
            { gid: 'sev-crit', name: 'Critical' }, { gid: 'sev-high', name: 'High' },
            { gid: 'sev-med', name: 'Medium' }, { gid: 'sev-low', name: 'Low' },
          ] } },
          { custom_field: { gid: 'cf-repo', name: 'SWS: Repository', resource_subtype: 'enum', enum_options: [] } },
          { custom_field: { gid: 'cf-pkg', name: 'SWS: Package', resource_subtype: 'enum', enum_options: [
            { gid: 'pkg-werkzeug', name: 'Werkzeug' }, // capital W stored
          ] } },
          { custom_field: { gid: 'cf-adv', name: 'SWS: Advisory', resource_subtype: 'text' } },
          { custom_field: { gid: 'cf-advurl', name: 'SWS: Advisory URL', resource_subtype: 'text' } },
          { custom_field: { gid: 'cf-team', name: 'SWS: Tech Team', resource_subtype: 'enum', enum_options: [] } },
        ];
      }
      if (path.endsWith('/sections')) return [
        { gid: 'sec-team', name: 'Team Assignment' },
        { gid: 'sec-crit', name: 'Critical' }, { gid: 'sec-high', name: 'High' },
        { gid: 'sec-med', name: 'Medium' }, { gid: 'sec-low', name: 'Low' },
      ];
      if (method === 'POST' && path === '/tasks') return { gid: 'NEW' };
      if (method === 'POST' && path.includes('/enum_options')) return { gid: 'should-not-be-called' };
      return {};
    });
    client.paginate.mockReturnValue((async function* () {})());
    await provider.loadContext();

    // Now create a ticket for a finding whose package name is "werkzeug" (lowercase).
    // The cache should hit the existing "Werkzeug" option and skip the POST entirely.
    const finding = {
      dedupId: 'd', source: 'github', externalId: 'GHSA-x', repository: 'org/r',
      packageName: 'werkzeug', severity: 'HIGH', title: 't',
      advisoryUrl: 'u', remediation: null,
    };
    await provider.createTicket(finding);

    const enumPostCalls = client.request.mock.calls.filter(
      c => c[0] === 'POST' && c[1] === '/custom_fields/cf-pkg/enum_options'
    );
    expect(enumPostCalls).toHaveLength(0);

    const createCall = client.request.mock.calls.find(c => c[0] === 'POST' && c[1] === '/tasks');
    expect(createCall[2].custom_fields['cf-pkg']).toBe('pkg-werkzeug');
  });

  it('recovers from Asana enum_option_duplicate_name by refreshing the field and reusing the existing option', async () => {
    // Seed context — Package field starts with NO options in our cache.
    let refreshCallCount = 0;
    client.request.mockImplementation(async (method, path, body) => {
      if (path.includes('/custom_field_settings')) {
        return [
          { custom_field: { gid: 'cf-dedup', name: 'SWS: Deduplication ID', resource_subtype: 'text' } },
          { custom_field: { gid: 'cf-sev', name: 'SWS: Severity', resource_subtype: 'enum', enum_options: [
            { gid: 'sev-high', name: 'High' },
          ] } },
          { custom_field: { gid: 'cf-repo', name: 'SWS: Repository', resource_subtype: 'enum', enum_options: [] } },
          { custom_field: { gid: 'cf-pkg', name: 'SWS: Package', resource_subtype: 'enum', enum_options: [] } },
          { custom_field: { gid: 'cf-adv', name: 'SWS: Advisory', resource_subtype: 'text' } },
          { custom_field: { gid: 'cf-advurl', name: 'SWS: Advisory URL', resource_subtype: 'text' } },
          { custom_field: { gid: 'cf-team', name: 'SWS: Tech Team', resource_subtype: 'enum', enum_options: [] } },
        ];
      }
      if (path.endsWith('/sections')) return [
        { gid: 'sec-team', name: 'Team Assignment' },
        { gid: 'sec-high', name: 'High' },
        { gid: 'sec-crit', name: 'Critical' }, { gid: 'sec-med', name: 'Medium' }, { gid: 'sec-low', name: 'Low' },
      ];
      // The refresh fetch — returns the stale option that's already on the server
      if (method === 'GET' && path === '/custom_fields/cf-pkg') {
        refreshCallCount++;
        return { gid: 'cf-pkg', enum_options: [{ gid: 'pkg-existing-werkzeug', name: 'Werkzeug' }] };
      }
      // The POST that triggers the duplicate-name error
      if (method === 'POST' && path === '/custom_fields/cf-pkg/enum_options') {
        throw new Error('Asana POST /custom_fields/cf-pkg/enum_options → 403: An enum option already exists with the name: Werkzeug. (enum_option_duplicate_name)');
      }
      if (method === 'POST' && path.includes('/enum_options')) return { gid: `opt-${Math.random()}` };
      if (method === 'POST' && path === '/tasks') return { gid: 'NEW' };
      return {};
    });
    client.paginate.mockReturnValue((async function* () {})());
    await provider.loadContext();

    const finding = {
      dedupId: 'd', source: 'github', externalId: 'GHSA-x', repository: 'org/r',
      packageName: 'Werkzeug', severity: 'HIGH', title: 't',
      advisoryUrl: 'u', remediation: null,
    };
    await provider.createTicket(finding);

    expect(refreshCallCount).toBe(1);
    const createCall = client.request.mock.calls.find(c => c[0] === 'POST' && c[1] === '/tasks');
    expect(createCall[2].custom_fields['cf-pkg']).toBe('pkg-existing-werkzeug');
  });
});

describe('buildTaskNotes', () => {
  it('includes vulnerable version range when present', () => {
    const out = buildTaskNotes({
      externalId: 'GHSA-x', advisoryUrl: 'https://example/GHSA-x',
      repository: 'org/r', packageName: 'lodash', ecosystem: 'npm',
      severity: 'HIGH', remediation: '4.17.21',
      vulnerableVersionRange: '< 4.17.21',
      title: 'Prototype pollution',
      manifestPaths: [],
    });
    expect(out).toContain('Vulnerable versions: < 4.17.21');
  });

  it('omits Vulnerable versions line when range is missing', () => {
    const out = buildTaskNotes({
      externalId: 'GHSA-x', advisoryUrl: 'u', repository: 'org/r',
      packageName: 'p', severity: 'LOW', remediation: null,
      vulnerableVersionRange: null, title: 't', manifestPaths: [],
    });
    expect(out).not.toContain('Vulnerable versions:');
  });

  it('lists all affected manifests as a bullet block', () => {
    const out = buildTaskNotes({
      externalId: 'GHSA-x', advisoryUrl: 'u', repository: 'org/r',
      packageName: 'p', severity: 'LOW', remediation: null,
      manifestPaths: ['package.json', 'subdir/package.json', 'docker/package.json'],
      title: 't',
    });
    expect(out).toContain('Affected manifests:');
    expect(out).toContain('  - package.json');
    expect(out).toContain('  - subdir/package.json');
    expect(out).toContain('  - docker/package.json');
  });

  it('omits Affected manifests block when array is empty or missing', () => {
    const out = buildTaskNotes({
      externalId: 'GHSA-x', advisoryUrl: 'u', repository: 'org/r',
      packageName: 'p', severity: 'LOW', remediation: null, title: 't',
      manifestPaths: [],
    });
    expect(out).not.toContain('Affected manifests:');
  });
});
