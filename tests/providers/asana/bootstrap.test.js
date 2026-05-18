import { describe, it, expect, vi } from 'vitest';
import { resolveWorkspaceGid } from '../../../src/providers/asana/bootstrap.js';

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
