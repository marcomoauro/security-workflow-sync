import { describe, it, expect, vi } from 'vitest';
import { reconcile } from '../../src/core/reconcile.js';

function makeProvider({ existing = new Map() } = {}) {
  return {
    loadContext: vi.fn().mockResolvedValue(undefined),
    listExistingTickets: vi.fn().mockResolvedValue(existing),
    createTicket: vi.fn().mockResolvedValue({ action: 'created' }),
    updateTicket: vi.fn(async (f, t) => ({ action: t.completed ? 'reopened' : 'noop' })),
    closeTicket: vi.fn().mockResolvedValue({ action: 'closed' }),
  };
}

describe('reconcile', () => {
  it('creates tickets for new OPEN findings', async () => {
    const provider = makeProvider();
    const findings = [
      { dedupId: 'a', state: 'OPEN' },
      { dedupId: 'b', state: 'OPEN' },
    ];
    const result = await reconcile(findings, provider);
    expect(provider.createTicket).toHaveBeenCalledTimes(2);
    expect(result.created).toBe(2);
  });

  it('updates tickets for existing OPEN findings', async () => {
    const existing = new Map([['a', { dedupId: 'a', completed: false }]]);
    const provider = makeProvider({ existing });
    provider.updateTicket.mockResolvedValueOnce({ action: 'updated' });
    const findings = [{ dedupId: 'a', state: 'OPEN' }];
    const result = await reconcile(findings, provider);
    expect(provider.createTicket).not.toHaveBeenCalled();
    expect(provider.updateTicket).toHaveBeenCalledOnce();
    expect(result.updated).toBe(1);
  });

  it('reopens completed tickets when finding is back to OPEN', async () => {
    const existing = new Map([['a', { dedupId: 'a', completed: true }]]);
    const provider = makeProvider({ existing });
    provider.updateTicket.mockResolvedValueOnce({ action: 'reopened' });
    const findings = [{ dedupId: 'a', state: 'OPEN' }];
    const result = await reconcile(findings, provider);
    expect(result.reopened).toBe(1);
  });

  it('closes tickets when finding is FIXED and ticket is still open', async () => {
    const existing = new Map([['a', { dedupId: 'a', completed: false }]]);
    const provider = makeProvider({ existing });
    const findings = [{ dedupId: 'a', state: 'FIXED' }];
    const result = await reconcile(findings, provider);
    expect(provider.closeTicket).toHaveBeenCalledOnce();
    expect(result.closed).toBe(1);
  });

  it('skips FIXED findings when no ticket exists', async () => {
    const provider = makeProvider();
    const findings = [{ dedupId: 'a', state: 'FIXED' }];
    const result = await reconcile(findings, provider);
    expect(provider.createTicket).not.toHaveBeenCalled();
    expect(provider.closeTicket).not.toHaveBeenCalled();
    expect(result.skipped).toBe(1);
  });

  it('skips FIXED findings when ticket already completed', async () => {
    const existing = new Map([['a', { dedupId: 'a', completed: true }]]);
    const provider = makeProvider({ existing });
    const findings = [{ dedupId: 'a', state: 'FIXED' }];
    const result = await reconcile(findings, provider);
    expect(provider.closeTicket).not.toHaveBeenCalled();
    expect(result.skipped).toBe(1);
  });

  it('lists existing tickets but does NOT call loadContext', async () => {
    const provider = makeProvider();
    await reconcile([], provider);
    expect(provider.loadContext).not.toHaveBeenCalled();
    expect(provider.listExistingTickets).toHaveBeenCalledOnce();
  });
});
