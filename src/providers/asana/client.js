import { fetchWithRetry } from '../../core/fetch-retry.js';

const ASANA_BASE = 'https://app.asana.com/api/1.0';

export function createAsanaClient({ token, fetchImpl = fetch, logger } = {}) {
  if (!token) throw new Error('ASANA_ACCESS_TOKEN is required');

  async function request(method, path, body, { query } = {}) {
    const url = new URL(ASANA_BASE + path);
    if (query) for (const [k, v] of Object.entries(query)) if (v != null) url.searchParams.set(k, String(v));

    const res = await fetchWithRetry(url, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: body !== undefined ? JSON.stringify({ data: body }) : undefined,
    }, {
      fetchImpl,
      logger,
      label: `Asana ${method} ${path}`,
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Asana ${method} ${path} → ${res.status}: ${text.slice(0, 500)}`);
    }
    const json = await res.json();
    return json.data;
  }

  // Asana uses offset-based pagination via { next_page: { offset } } in the *envelope*,
  // not in `data`. We need access to the envelope, so we use a sibling helper.
  // `onPage({ page, count, hasNext })` is invoked once per HTTP request, after the
  // response arrives but before items are yielded — useful for progress logging.
  async function* paginate(path, query = {}, { onPage } = {}) {
    const url = new URL(ASANA_BASE + path);
    const q = { limit: 100, ...query };
    for (const [k, v] of Object.entries(q)) if (v != null) url.searchParams.set(k, String(v));

    let pageNum = 0;
    while (true) {
      const res = await fetchWithRetry(url, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/json',
        },
      }, {
        fetchImpl,
        logger,
        label: `Asana GET ${url.pathname}`,
      });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`Asana GET ${url.pathname} → ${res.status}: ${text.slice(0, 500)}`);
      }
      const envelope = await res.json();
      pageNum++;
      const items = envelope.data ?? [];
      const next = envelope.next_page?.offset;
      onPage?.({ page: pageNum, count: items.length, hasNext: !!next });
      for (const item of items) yield item;
      if (!next) return;
      url.searchParams.set('offset', next);
    }
  }

  return { request, paginate };
}
