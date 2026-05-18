import { describe, it, expect, vi } from 'vitest';
import { resolveWorkspaceGid, bootstrapAsanaProject } from '../../../src/providers/asana/bootstrap.js';

function fakeClient(workspaces) {
  return {
    request: vi.fn(async (method, path) => {
      if (method === 'GET' && path === '/users/me') return { gid: 'me', workspaces };
      throw new Error(`unmocked ${method} ${path}`);
    }),
  };
}

const silentLogger = { info() {}, warn() {}, error() {} };

describe('resolveWorkspaceGid', () => {
  it('returns the single workspace gid when the user has exactly one', async () => {
    const client = fakeClient([{ gid: 'W1', name: 'My Workspace', resource_type: 'workspace' }]);
    const gid = await resolveWorkspaceGid({ client, logger: silentLogger });
    expect(gid).toBe('W1');
  });

  it('throws when the user has no workspaces', async () => {
    const client = fakeClient([]);
    await expect(resolveWorkspaceGid({ client, logger: silentLogger })).rejects.toThrow(/no workspaces/i);
  });

  it('throws with a list of options when the user has multiple workspaces', async () => {
    const client = fakeClient([
      { gid: 'W1', name: 'Alpha' },
      { gid: 'W2', name: 'Beta' },
    ]);
    await expect(resolveWorkspaceGid({ client, logger: silentLogger }))
      .rejects.toThrow(/ASANA_WORKSPACE_GID[\s\S]*Alpha[\s\S]*W1[\s\S]*Beta[\s\S]*W2/);
  });
});

function bootstrapClient({ existingFields = [] } = {}) {
  let nextGid = 1;
  return {
    request: vi.fn(async (method, path) => {
      if (method === 'POST' && path === '/projects') return { gid: 'P' };
      return { gid: `g-${nextGid++}` };
    }),
    paginate: vi.fn(function* () {}).mockImplementation(async function* (path) {
      if (path.endsWith('/custom_fields')) {
        for (const f of existingFields) yield f;
      }
    }),
  };
}

describe('bootstrapAsanaProject', () => {
  it('never creates an enum custom field with empty enum_options (Asana rejects that)', async () => {
    const client = bootstrapClient();
    await bootstrapAsanaProject({ client, workspaceGid: 'W', projectName: 'Test', logger: silentLogger });

    const enumFieldCreations = client.request.mock.calls.filter(
      ([method, path, body]) =>
        method === 'POST' && path === '/custom_fields' && body?.resource_subtype === 'enum'
    );
    expect(enumFieldCreations.length).toBeGreaterThan(0);
    for (const [, , body] of enumFieldCreations) {
      expect(Array.isArray(body.enum_options)).toBe(true);
      expect(body.enum_options.length).toBeGreaterThanOrEqual(1);
    }
  });

  it('reuses an existing workspace custom field with the same name instead of recreating it', async () => {
    const client = bootstrapClient({
      existingFields: [
        { gid: 'existing-dedup', name: 'SWS: Deduplication ID', resource_subtype: 'text' },
        { gid: 'existing-sev', name: 'SWS: Severity', resource_subtype: 'enum' },
      ],
    });

    await bootstrapAsanaProject({ client, workspaceGid: 'W', projectName: 'Test', logger: silentLogger });

    const fieldCreationNames = client.request.mock.calls
      .filter(([method, path]) => method === 'POST' && path === '/custom_fields')
      .map(([, , body]) => body.name);

    // The reused ones must NOT be POSTed again
    expect(fieldCreationNames).not.toContain('SWS: Deduplication ID');
    expect(fieldCreationNames).not.toContain('SWS: Severity');
    // The non-existing ones must still be created
    expect(fieldCreationNames).toContain('SWS: Advisory');
    expect(fieldCreationNames).toContain('SWS: Repository');

    // Both reused fields must still get attached to the new project
    const attachedGids = client.request.mock.calls
      .filter(([method, path]) => method === 'POST' && path === '/projects/P/addCustomFieldSetting')
      .map(([, , body]) => body.custom_field);
    expect(attachedGids).toContain('existing-dedup');
    expect(attachedGids).toContain('existing-sev');
  });

  it('throws a clear error when an existing field has the wrong type', async () => {
    const client = bootstrapClient({
      existingFields: [
        // A pre-existing field named like ours but of the WRONG type (text instead of enum)
        { gid: 'wrong-type-12345', name: 'SWS: Repository', resource_subtype: 'text' },
      ],
    });

    await expect(
      bootstrapAsanaProject({ client, workspaceGid: 'W', projectName: 'Test', logger: silentLogger })
    ).rejects.toThrow(/SWS: Repository[\s\S]*wrong-type-12345[\s\S]*expected type "enum"[\s\S]*found "text"/);
  });

  it('swallows "already attached" errors from addCustomFieldSetting and keeps going', async () => {
    const client = bootstrapClient();
    // Make the first addCustomFieldSetting fail with an "already" message
    let throwOnce = true;
    client.request.mockImplementation(async (method, path, body) => {
      if (method === 'POST' && path === '/projects') return { gid: 'P' };
      if (method === 'POST' && path === '/projects/P/addCustomFieldSetting' && throwOnce) {
        throwOnce = false;
        throw new Error('Asana POST /addCustomFieldSetting → 400: custom_field already added');
      }
      return { gid: `g-${Math.random()}` };
    });

    await expect(
      bootstrapAsanaProject({ client, workspaceGid: 'W', projectName: 'Test', logger: silentLogger })
    ).resolves.toEqual({ projectGid: 'P' });
  });
});
