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
