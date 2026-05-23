// Retry wrapper for transient HTTP failures.
//
// What's retried:
//   - 429 Too Many Requests   (rate limit)        → honors Retry-After if present
//   - 500, 502, 503, 504      (server hiccups)    → exponential backoff
//   - thrown network errors   (ECONNRESET, etc.)  → exponential backoff
//
// What is NOT retried:
//   - 2xx (returned as-is)
//   - 3xx redirects (fetch follows them by default)
//   - 4xx other than 429 (these are caller bugs, not transient)
//
// Backoff: baseDelay * 2^attempt + small jitter, capped at MAX_BACKOFF_MS.

const RETRYABLE_STATUSES = new Set([429, 500, 502, 503, 504]);
const MAX_BACKOFF_MS = 30_000;

export async function fetchWithRetry(url, init, opts = {}) {
  const {
    fetchImpl = fetch,
    maxRetries = 5,
    baseDelayMs = 300,
    sleep = defaultSleep,
    logger,
    label = `${init?.method ?? 'GET'} ${url}`,
  } = opts;

  for (let attempt = 0; ; attempt++) {
    let res;
    try {
      res = await fetchImpl(url, init);
    } catch (err) {
      if (attempt >= maxRetries) throw err;
      const delay = backoff(attempt, baseDelayMs);
      logger?.warn?.(`${label} failed: ${err.message} — retrying in ${delay}ms (attempt ${attempt + 1}/${maxRetries}).`);
      await sleep(delay);
      continue;
    }

    if (res.ok || !RETRYABLE_STATUSES.has(res.status) || attempt >= maxRetries) {
      return res;
    }

    const retryAfter = parseRetryAfter(res.headers);
    const delay = retryAfter ?? backoff(attempt, baseDelayMs);
    logger?.warn?.(`${label} → ${res.status} — retrying in ${delay}ms (attempt ${attempt + 1}/${maxRetries}).`);
    await sleep(delay);
  }
}

function backoff(attempt, baseDelayMs) {
  const exp = baseDelayMs * (2 ** attempt);
  const jitter = Math.random() * 100;
  return Math.min(exp + jitter, MAX_BACKOFF_MS);
}

function parseRetryAfter(headers) {
  const v = headers?.get?.('retry-after');
  if (!v) return null;
  const secs = Number(v);
  if (Number.isFinite(secs) && secs >= 0) return secs * 1000;
  // Could be an HTTP-date; ignore — we'll fall back to exponential backoff.
  return null;
}

function defaultSleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
