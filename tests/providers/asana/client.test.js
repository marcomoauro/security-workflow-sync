import { describe, it, expect, vi } from 'vitest';
import { createAsanaClient } from '../../../src/providers/asana/client.js';

function mockOk(json, opts = {}) {
  return { ok: true, status: 200, json: async () => json, text: async () => JSON.stringify(json), headers: { get: () => null }, ...opts };
}

describe('asana client', () => {
  it('wraps request bodies in {data: ...} and unwraps response', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(mockOk({ data: { gid: '1' } }));
    const c = createAsanaClient({ token: 't', fetchImpl });
    const out = await c.request('POST', '/tasks', { name: 'x' });
    expect(out).toEqual({ gid: '1' });
    const call = fetchImpl.mock.calls[0];
    expect(call[1].method).toBe('POST');
    expect(JSON.parse(call[1].body)).toEqual({ data: { name: 'x' } });
    expect(call[1].headers.Authorization).toBe('Bearer t');
  });

  it('throws on non-ok response with status and body excerpt', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce({
      ok: false, status: 403, headers: { get: () => null },
      json: async () => ({ errors: [{ message: 'forbidden' }] }),
      text: async () => '{"errors":[{"message":"forbidden"}]}',
    });
    const c = createAsanaClient({ token: 't', fetchImpl });
    await expect(c.request('GET', '/x')).rejects.toThrow(/403/);
  });

  it('paginate yields items across multiple offset pages', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(mockOk({ data: [{ gid: '1' }, { gid: '2' }], next_page: { offset: 'OFF' } }))
      .mockResolvedValueOnce(mockOk({ data: [{ gid: '3' }], next_page: null }));
    const c = createAsanaClient({ token: 't', fetchImpl });
    const items = [];
    for await (const it of c.paginate('/projects/1/tasks')) items.push(it);
    expect(items.map(i => i.gid)).toEqual(['1', '2', '3']);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(new URL(fetchImpl.mock.calls[1][0]).searchParams.get('offset')).toBe('OFF');
  });
});
