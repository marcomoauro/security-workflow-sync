import { fetchWithRetry } from '../core/fetch-retry.js';

const GITHUB_API = 'https://api.github.com';

export function createGithubClient({ token, fetchImpl = fetch, logger } = {}) {
  if (!token) throw new Error('GITHUB_TOKEN is required');

  async function request(path, { method = 'GET', query } = {}) {
    const url = new URL(GITHUB_API + path);
    if (query) for (const [k, v] of Object.entries(query)) if (v != null) url.searchParams.set(k, String(v));

    const res = await fetchWithRetry(url, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'security-workflow-sync',
      },
    }, {
      fetchImpl,
      logger,
      label: `GitHub ${method} ${path}`,
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`GitHub ${method} ${path} → ${res.status}: ${body.slice(0, 500)}`);
    }
    return { data: await res.json(), link: res.headers.get('link') };
  }

  // Auto-paginate using Link header (rel="next").
  // `onPage({ page, count, hasNext })` is invoked once per HTTP request, after the response
  // arrives but before items are yielded — useful for progress logging on long pulls.
  async function* paginate(path, query = {}, { onPage } = {}) {
    let url = path;
    let q = { per_page: 100, ...query };
    let pageNum = 0;
    while (url) {
      const { data, link } = await request(url, { query: q });
      pageNum++;
      const next = parseNext(link);
      onPage?.({ page: pageNum, count: data.length, hasNext: !!next });
      yield* data;
      if (!next) return;
      // After the first call, switch to following the absolute next URL
      url = next.replace(GITHUB_API, '');
      q = undefined;
    }
  }

  return { request, paginate };
}

function parseNext(linkHeader) {
  if (!linkHeader) return null;
  // <https://api.github.com/...>; rel="next", <...>; rel="last"
  for (const part of linkHeader.split(',')) {
    const m = part.trim().match(/^<([^>]+)>;\s*rel="next"$/);
    if (m) return m[1];
  }
  return null;
}
