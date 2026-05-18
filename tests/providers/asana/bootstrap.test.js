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

describe('bootstrapAsanaProject', () => {
  it('never creates an enum custom field with empty enum_options (Asana rejects that)', async () => {
    let nextGid = 1;
    const client = {
      request: vi.fn(async (method, path, body) => {
        if (method === 'POST' && path === '/projects') return { gid: 'P' };
        return { gid: `g-${nextGid++}` };
      }),
    };

    await bootstrapAsanaProject({
      client,
      workspaceGid: 'W',
      projectName: 'Test',
      logger: silentLogger,
    });

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
});
