import { describe, it, expect, vi } from 'vitest';
import { fetchWithRetry } from '../../src/core/fetch-retry.js';

const okRes = (status = 200) => ({ ok: true, status, headers: { get: () => null } });
const failRes = (status, headers = {}) => ({
  ok: false,
  status,
  headers: { get: (k) => headers[String(k).toLowerCase()] ?? null },
});

describe('fetchWithRetry', () => {
  it('returns the response immediately on success', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(okRes(200));
    const sleep = vi.fn();
    const res = await fetchWithRetry('https://x/y', {}, { fetchImpl, sleep });
    expect(res.status).toBe(200);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('does not retry on a non-retryable 4xx (e.g. 404)', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(failRes(404));
    const sleep = vi.fn();
    const res = await fetchWithRetry('https://x/y', {}, { fetchImpl, sleep });
    expect(res.status).toBe(404);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('retries on 500 and eventually succeeds', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(failRes(500))
      .mockResolvedValueOnce(failRes(500))
      .mockResolvedValueOnce(okRes(200));
    const sleep = vi.fn();
    const res = await fetchWithRetry('https://x/y', {}, { fetchImpl, sleep, maxRetries: 5 });
    expect(res.status).toBe(200);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  it('retries 503, 502, 504 as well as 500', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(failRes(503))
      .mockResolvedValueOnce(failRes(502))
      .mockResolvedValueOnce(failRes(504))
      .mockResolvedValueOnce(okRes(200));
    const sleep = vi.fn();
    const res = await fetchWithRetry('https://x/y', {}, { fetchImpl, sleep, maxRetries: 5 });
    expect(res.status).toBe(200);
    expect(fetchImpl).toHaveBeenCalledTimes(4);
  });

  it('returns the last failing response after exhausting retries (no throw)', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(failRes(500));
    const sleep = vi.fn();
    const res = await fetchWithRetry('https://x/y', {}, { fetchImpl, sleep, maxRetries: 3 });
    expect(res.status).toBe(500);
    // 1 initial attempt + 3 retries = 4 calls
    expect(fetchImpl).toHaveBeenCalledTimes(4);
  });

  it('honors Retry-After header on 429 (parsed as seconds)', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(failRes(429, { 'retry-after': '2' }))
      .mockResolvedValueOnce(okRes(200));
    const sleep = vi.fn();
    await fetchWithRetry('https://x/y', {}, { fetchImpl, sleep });
    expect(sleep).toHaveBeenCalledWith(2000);
  });

  it('falls back to exponential backoff when Retry-After is missing or unparseable', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(failRes(429)) // no Retry-After
      .mockResolvedValueOnce(okRes(200));
    const sleep = vi.fn();
    await fetchWithRetry('https://x/y', {}, { fetchImpl, sleep, baseDelayMs: 100 });
    // baseDelay 100ms * 2^0 = 100ms, plus 0..100ms jitter → between 100 and 200
    const arg = sleep.mock.calls[0][0];
    expect(arg).toBeGreaterThanOrEqual(100);
    expect(arg).toBeLessThanOrEqual(200);
  });

  it('retries on thrown network errors and eventually succeeds', async () => {
    const fetchImpl = vi.fn()
      .mockRejectedValueOnce(new Error('ECONNRESET'))
      .mockRejectedValueOnce(new Error('socket hang up'))
      .mockResolvedValueOnce(okRes(200));
    const sleep = vi.fn();
    const res = await fetchWithRetry('https://x/y', {}, { fetchImpl, sleep, maxRetries: 5 });
    expect(res.status).toBe(200);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it('rethrows the original network error after exhausting retries', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error('ECONNRESET'));
    const sleep = vi.fn();
    await expect(
      fetchWithRetry('https://x/y', {}, { fetchImpl, sleep, maxRetries: 2 })
    ).rejects.toThrow('ECONNRESET');
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it('logs a warning for each retry attempt with status and label', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(failRes(500))
      .mockResolvedValueOnce(okRes(200));
    const logger = { warn: vi.fn(), info() {}, error() {} };
    const sleep = vi.fn();
    await fetchWithRetry('https://x/y', { method: 'PUT' }, {
      fetchImpl, sleep, logger, label: 'Asana PUT /tasks/123',
    });
    expect(logger.warn).toHaveBeenCalledOnce();
    expect(logger.warn.mock.calls[0][0]).toContain('500');
    expect(logger.warn.mock.calls[0][0]).toContain('Asana PUT /tasks/123');
  });

  it('caps the backoff at 30 seconds', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(failRes(500));
    const sleep = vi.fn();
    // huge baseDelay forces capping
    await fetchWithRetry('https://x/y', {}, { fetchImpl, sleep, baseDelayMs: 60_000, maxRetries: 2 });
    for (const call of sleep.mock.calls) {
      expect(call[0]).toBeLessThanOrEqual(30_000);
    }
  });
});
