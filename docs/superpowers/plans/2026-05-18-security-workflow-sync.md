# security-workflow-sync Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a Dockerized CLI tool that incrementally syncs GitHub Dependabot alerts into Asana tasks, idempotently, with team-assignment ownership preservation.

**Architecture:** Stateless reconciliation engine. Provider-agnostic core (`SecurityFinding` + reconcile loop) sits between a source provider (Dependabot via GitHub REST) and a workflow provider (Asana). Dedup identity is `sha1("github:<repo>:<package>:<ghsa>").slice(0,12)`, stored in a `Deduplication ID` custom text field on each Asana task. The sync command is safe to run on a cron — repeated invocations produce identical state. A separate `bootstrap` command creates the required Asana project resources (sections + custom fields) and prints the env vars the user must export for the sync command.

**Tech Stack:** Node 24, plain JS (no TS), ESM (`type: module`), zero runtime dependencies, native `fetch`, `node:crypto` for SHA1, `node:util` `parseArgs` for CLI parsing. Tests with vitest (only dev dep). Docker base `node:24.14.1-alpine`.

---

## Domain Model

`SecurityFinding` (provider-neutral):
```js
{
  source: 'github',                       // string
  externalId: 'GHSA-xxxx-xxxx-xxxx',      // advisory id from Dependabot
  repository: 'owner/repo',               // owner/name
  packageName: 'lodash',                  // package ecosystem-agnostic name
  ecosystem: 'npm',                       // npm, pip, maven, ...
  severity: 'CRITICAL'|'HIGH'|'MEDIUM'|'LOW',
  title: 'Prototype pollution in lodash <4.17.21',
  advisoryUrl: 'https://github.com/advisories/GHSA-xxxx',
  remediation: '4.17.21',                 // first patched version, may be null
  state: 'OPEN'|'FIXED',                  // OPEN if alert.state==='open', else FIXED
  metadata: { ghsaSummary, cveId, ... }
}
```

`dedupId(finding) = sha1(`${source}:${repository}:${packageName}:${externalId}`).slice(0,12)`.

## Asana Project Shape

Sections (created by `bootstrap`):
- `Team Assignment` — one task per repository, manually annotated with Tech Team
- `Critical`
- `High`
- `Medium`
- `Low`

Custom fields on the project (text or single-select enum, created by `bootstrap`):
- `Deduplication ID` (text) — identity
- `Severity` (enum: Critical / High / Medium / Low)
- `Repository` (enum, single-select, options added dynamically as new repos appear)
- `Package` (enum, single-select, options added dynamically)
- `Advisory` (text) — GHSA id
- `Advisory URL` (text)
- `Tech Team` (enum, single-select) — populated by user inside Team Assignment tasks; mirrored onto vuln tasks at sync time

## File Structure

```
security-workflow-sync/
├── package.json
├── vitest.config.js
├── Dockerfile
├── .dockerignore
├── .gitignore
├── README.md
├── bin/
│   └── sws.js                          # shebang entry, delegates to src/cli.js
├── src/
│   ├── cli.js                          # parseArgs, command dispatch (sync | bootstrap)
│   ├── config.js                       # env var loading + validation
│   ├── core/
│   │   ├── finding.js                  # SecurityFinding builder + dedupId
│   │   ├── reconcile.js                # provider-agnostic reconciliation engine
│   │   └── logger.js                   # stderr structured logging, --quiet flag
│   ├── sources/
│   │   ├── github-client.js            # fetch wrapper, link-header pagination
│   │   └── dependabot.js               # alerts → SecurityFinding[]
│   ├── providers/
│   │   └── asana/
│   │       ├── client.js               # asanaRequest, offset pagination
│   │       ├── schema.js               # SECTION_NAMES, FIELD_NAMES, SEVERITY_TO_SECTION
│   │       ├── provider.js             # implements WorkflowProvider interface
│   │       └── bootstrap.js            # creates sections + custom fields
│   └── commands/
│       ├── sync.js                     # wires source → core → provider
│       └── bootstrap.js                # invokes providers/asana/bootstrap.js
└── tests/
    ├── core/
    │   ├── finding.test.js
    │   └── reconcile.test.js
    ├── sources/
    │   └── dependabot.test.js
    └── providers/asana/
        ├── client.test.js
        └── provider.test.js
```

## Reconciliation Contract

`WorkflowProvider` interface (duck-typed in JS):
```js
{
  loadContext(): Promise<void>,                              // fetches sections, fields, team mapping
  listExistingTickets(): Promise<Map<dedupId, Ticket>>,
  createTicket(finding): Promise<{action:'created', dedupId}>,
  updateTicket(finding, existing): Promise<{action:'updated'|'reopened'|'noop', dedupId}>,
  closeTicket(existing): Promise<{action:'closed', dedupId}>,
}
```

`reconcile(findings, provider)`:
1. `await provider.loadContext()`
2. `existing = await provider.listExistingTickets()` — `Map<dedupId, Ticket>`
3. For each finding in `findings`:
   - if state===OPEN and not in `existing` → `createTicket`
   - if state===OPEN and in `existing` → `updateTicket` (which internally decides update/reopen/noop)
   - if state===FIXED and in `existing` and `!existing.completed` → `closeTicket`
   - if state===FIXED and not in `existing` → skip (never created, no work to do)
4. Return counts `{created, updated, reopened, closed, skipped}`

No "auto-complete from missing-in-feed" — closure is driven by explicit `state !== 'open'` from Dependabot (user decision).

---

## Tasks

### Task 1: Project scaffolding

**Files:**
- Create: `package.json`
- Create: `.gitignore`
- Create: `.dockerignore`
- Create: `vitest.config.js`

- [ ] **Step 1: Write `package.json`**

```json
{
  "name": "security-workflow-sync",
  "version": "0.1.0",
  "description": "Sync security findings (GitHub Dependabot) into engineering workflow tools (Asana).",
  "type": "module",
  "bin": { "sws": "./bin/sws.js" },
  "engines": { "node": ">=24" },
  "scripts": {
    "test": "vitest run",
    "test:watch": "vitest",
    "sync": "node bin/sws.js sync",
    "bootstrap": "node bin/sws.js bootstrap"
  },
  "devDependencies": {
    "vitest": "^2.1.0"
  },
  "license": "MIT"
}
```

- [ ] **Step 2: Write `.gitignore`**

```
node_modules
.env
.env.*
dist
coverage
.DS_Store
```

- [ ] **Step 3: Write `.dockerignore`**

```
node_modules
.git
.gitignore
docs
tests
coverage
.env
.env.*
*.md
!README.md
```

- [ ] **Step 4: Write `vitest.config.js`**

```js
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.js'],
    globals: false,
  },
});
```

- [ ] **Step 5: Install deps**

Run: `npm install`
Expected: lockfile created, only vitest under node_modules (plus transitive).

- [ ] **Step 6: Commit**

```bash
git init
git add package.json .gitignore .dockerignore vitest.config.js
git commit -m "chore: project scaffolding"
```

---

### Task 2: SecurityFinding + dedupId

**Files:**
- Create: `src/core/finding.js`
- Test: `tests/core/finding.test.js`

- [ ] **Step 1: Write failing test**

```js
// tests/core/finding.test.js
import { describe, it, expect } from 'vitest';
import { dedupId, normalizeSeverity } from '../../src/core/finding.js';

describe('dedupId', () => {
  it('is stable for the same identity tuple', () => {
    const a = dedupId({ source: 'github', repository: 'org/repo', packageName: 'lodash', externalId: 'GHSA-1' });
    const b = dedupId({ source: 'github', repository: 'org/repo', packageName: 'lodash', externalId: 'GHSA-1' });
    expect(a).toBe(b);
  });

  it('differs when repository differs', () => {
    const a = dedupId({ source: 'github', repository: 'org/a', packageName: 'lodash', externalId: 'GHSA-1' });
    const b = dedupId({ source: 'github', repository: 'org/b', packageName: 'lodash', externalId: 'GHSA-1' });
    expect(a).not.toBe(b);
  });

  it('differs when package differs', () => {
    const a = dedupId({ source: 'github', repository: 'org/r', packageName: 'lodash', externalId: 'GHSA-1' });
    const b = dedupId({ source: 'github', repository: 'org/r', packageName: 'axios', externalId: 'GHSA-1' });
    expect(a).not.toBe(b);
  });

  it('is 12 hex chars', () => {
    const id = dedupId({ source: 'github', repository: 'org/r', packageName: 'p', externalId: 'GHSA-1' });
    expect(id).toMatch(/^[0-9a-f]{12}$/);
  });
});

describe('normalizeSeverity', () => {
  it('uppercases known GitHub severities', () => {
    expect(normalizeSeverity('critical')).toBe('CRITICAL');
    expect(normalizeSeverity('High')).toBe('HIGH');
    expect(normalizeSeverity('moderate')).toBe('MEDIUM'); // GitHub uses "moderate"
    expect(normalizeSeverity('low')).toBe('LOW');
  });

  it('defaults unknown to MEDIUM', () => {
    expect(normalizeSeverity('???')).toBe('MEDIUM');
    expect(normalizeSeverity(undefined)).toBe('MEDIUM');
  });
});
```

- [ ] **Step 2: Run tests, confirm they fail**

Run: `npx vitest run tests/core/finding.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/core/finding.js`**

```js
import { createHash } from 'node:crypto';

export function dedupId({ source, repository, packageName, externalId }) {
  const key = `${source}:${repository}:${packageName}:${externalId}`;
  return createHash('sha1').update(key).digest('hex').slice(0, 12);
}

const SEVERITY_MAP = {
  critical: 'CRITICAL',
  high: 'HIGH',
  moderate: 'MEDIUM',
  medium: 'MEDIUM',
  low: 'LOW',
};

export function normalizeSeverity(input) {
  if (!input) return 'MEDIUM';
  return SEVERITY_MAP[String(input).toLowerCase()] ?? 'MEDIUM';
}
```

- [ ] **Step 4: Run tests, confirm pass**

Run: `npx vitest run tests/core/finding.test.js`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/core/finding.js tests/core/finding.test.js
git commit -m "feat(core): SecurityFinding dedupId + severity normalization"
```

---

### Task 3: Reconciliation engine

**Files:**
- Create: `src/core/reconcile.js`
- Test: `tests/core/reconcile.test.js`

- [ ] **Step 1: Write failing test**

```js
// tests/core/reconcile.test.js
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

  it('calls loadContext exactly once before listing', async () => {
    const provider = makeProvider();
    await reconcile([], provider);
    expect(provider.loadContext).toHaveBeenCalledOnce();
    expect(provider.listExistingTickets).toHaveBeenCalledOnce();
  });
});
```

- [ ] **Step 2: Run tests, confirm fail**

Run: `npx vitest run tests/core/reconcile.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/core/reconcile.js`**

```js
export async function reconcile(findings, provider) {
  await provider.loadContext();
  const existing = await provider.listExistingTickets();

  const result = { created: 0, updated: 0, reopened: 0, closed: 0, skipped: 0, noop: 0 };

  for (const finding of findings) {
    const ticket = existing.get(finding.dedupId);

    if (finding.state === 'OPEN') {
      if (!ticket) {
        await provider.createTicket(finding);
        result.created++;
      } else {
        const { action } = await provider.updateTicket(finding, ticket);
        if (action === 'updated') result.updated++;
        else if (action === 'reopened') result.reopened++;
        else result.noop++;
      }
    } else {
      // FIXED (or any non-OPEN normalized state)
      if (ticket && !ticket.completed) {
        await provider.closeTicket(ticket);
        result.closed++;
      } else {
        result.skipped++;
      }
    }
  }

  return result;
}
```

- [ ] **Step 4: Run tests, confirm pass**

Run: `npx vitest run tests/core/reconcile.test.js`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add src/core/reconcile.js tests/core/reconcile.test.js
git commit -m "feat(core): reconciliation engine"
```

---

### Task 4: Logger

**Files:**
- Create: `src/core/logger.js`

- [ ] **Step 1: Implement (trivial, no test needed)**

```js
// All logs go to stderr; stdout is reserved for machine-readable summaries.
export function createLogger({ quiet = false } = {}) {
  return {
    info(msg, ...rest) { if (!quiet) process.stderr.write(`[info] ${msg} ${rest.map(fmt).join(' ')}\n`.trimEnd() + '\n'); },
    warn(msg, ...rest) { process.stderr.write(`[warn] ${msg} ${rest.map(fmt).join(' ')}\n`.trimEnd() + '\n'); },
    error(msg, ...rest) { process.stderr.write(`[error] ${msg} ${rest.map(fmt).join(' ')}\n`.trimEnd() + '\n'); },
  };
}

function fmt(v) {
  if (v == null) return '';
  if (typeof v === 'string') return v;
  try { return JSON.stringify(v); } catch { return String(v); }
}
```

- [ ] **Step 2: Commit**

```bash
git add src/core/logger.js
git commit -m "feat(core): logger"
```

---

### Task 5: GitHub client (REST, fetch, pagination)

**Files:**
- Create: `src/sources/github-client.js`

- [ ] **Step 1: Implement**

```js
const GITHUB_API = 'https://api.github.com';

export function createGithubClient({ token, fetchImpl = fetch }) {
  if (!token) throw new Error('GITHUB_TOKEN is required');

  async function request(path, { method = 'GET', query } = {}) {
    const url = new URL(GITHUB_API + path);
    if (query) for (const [k, v] of Object.entries(query)) if (v != null) url.searchParams.set(k, String(v));

    const res = await fetchImpl(url, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'security-workflow-sync',
      },
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`GitHub ${method} ${path} → ${res.status}: ${body.slice(0, 500)}`);
    }
    return { data: await res.json(), link: res.headers.get('link') };
  }

  // Auto-paginate using Link header (rel="next")
  async function* paginate(path, query = {}) {
    let url = path;
    let q = { per_page: 100, ...query };
    while (url) {
      const { data, link } = await request(url, { query: q });
      yield* data;
      const next = parseNext(link);
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
```

(No tests for this thin wrapper directly — its behavior is exercised in the dependabot tests.)

- [ ] **Step 2: Commit**

```bash
git add src/sources/github-client.js
git commit -m "feat(sources): GitHub REST client with pagination"
```

---

### Task 6: Dependabot source (alerts → findings)

**Files:**
- Create: `src/sources/dependabot.js`
- Test: `tests/sources/dependabot.test.js`

- [ ] **Step 1: Write failing test**

```js
// tests/sources/dependabot.test.js
import { describe, it, expect, vi } from 'vitest';
import { fetchDependabotFindings } from '../../src/sources/dependabot.js';

function mockFetch(pages) {
  // pages: array of arrays — each element is one page response
  let i = 0;
  return vi.fn(async () => {
    const body = pages[i] ?? [];
    const hasNext = i < pages.length - 1;
    i++;
    return {
      ok: true,
      status: 200,
      json: async () => body,
      text: async () => JSON.stringify(body),
      headers: {
        get: (h) => h.toLowerCase() === 'link' && hasNext
          ? '<https://api.github.com/orgs/o/dependabot/alerts?page=2>; rel="next"'
          : null,
      },
    };
  });
}

const sampleAlert = (overrides = {}) => ({
  number: 1,
  state: 'open',
  security_advisory: {
    ghsa_id: 'GHSA-aaaa-bbbb-cccc',
    summary: 'Prototype pollution in lodash',
    severity: 'high',
    cve_id: 'CVE-2024-0001',
  },
  security_vulnerability: {
    package: { name: 'lodash', ecosystem: 'npm' },
    first_patched_version: { identifier: '4.17.21' },
  },
  html_url: 'https://github.com/o/r/security/dependabot/1',
  repository: { full_name: 'o/r' },
  ...overrides,
});

describe('fetchDependabotFindings', () => {
  it('maps Dependabot alerts to SecurityFinding[]', async () => {
    const fetchImpl = mockFetch([[sampleAlert()]]);
    const findings = await fetchDependabotFindings({ org: 'o', token: 't', fetchImpl });
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      source: 'github',
      externalId: 'GHSA-aaaa-bbbb-cccc',
      repository: 'o/r',
      packageName: 'lodash',
      ecosystem: 'npm',
      severity: 'HIGH',
      state: 'OPEN',
      remediation: '4.17.21',
    });
    expect(findings[0].dedupId).toMatch(/^[0-9a-f]{12}$/);
    expect(findings[0].advisoryUrl).toContain('GHSA-aaaa-bbbb-cccc');
  });

  it('marks non-open alerts as FIXED', async () => {
    const fetchImpl = mockFetch([[
      sampleAlert({ state: 'fixed' }),
      sampleAlert({ number: 2, state: 'dismissed' }),
      sampleAlert({ number: 3, state: 'auto_dismissed' }),
    ]]);
    const findings = await fetchDependabotFindings({ org: 'o', token: 't', fetchImpl });
    expect(findings.every(f => f.state === 'FIXED')).toBe(true);
  });

  it('follows pagination via Link header', async () => {
    const fetchImpl = mockFetch([
      [sampleAlert({ number: 1 })],
      [sampleAlert({ number: 2, security_advisory: { ghsa_id: 'GHSA-zzzz', summary: 'x', severity: 'low' }, security_vulnerability: { package: { name: 'axios', ecosystem: 'npm' } } })],
    ]);
    const findings = await fetchDependabotFindings({ org: 'o', token: 't', fetchImpl });
    expect(findings).toHaveLength(2);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('uses normalized severity (moderate→MEDIUM)', async () => {
    const fetchImpl = mockFetch([[sampleAlert({ security_advisory: { ghsa_id: 'GHSA-x', summary: 's', severity: 'moderate' } })]]);
    const findings = await fetchDependabotFindings({ org: 'o', token: 't', fetchImpl });
    expect(findings[0].severity).toBe('MEDIUM');
  });
});
```

- [ ] **Step 2: Run tests, confirm fail**

Run: `npx vitest run tests/sources/dependabot.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/sources/dependabot.js`**

```js
import { createGithubClient } from './github-client.js';
import { dedupId, normalizeSeverity } from '../core/finding.js';

export async function fetchDependabotFindings({ org, token, fetchImpl }) {
  const gh = createGithubClient({ token, fetchImpl });
  const findings = [];
  for await (const alert of gh.paginate(`/orgs/${org}/dependabot/alerts`, { state: 'auto', per_page: 100 })) {
    findings.push(toFinding(alert));
  }
  return findings;
}

function toFinding(alert) {
  const advisory = alert.security_advisory ?? {};
  const vuln = alert.security_vulnerability ?? {};
  const pkg = vuln.package ?? {};
  const repository = alert.repository?.full_name ?? '';
  const externalId = advisory.ghsa_id;
  const packageName = pkg.name ?? 'unknown';

  const finding = {
    source: 'github',
    externalId,
    repository,
    packageName,
    ecosystem: pkg.ecosystem ?? 'unknown',
    severity: normalizeSeverity(advisory.severity),
    title: advisory.summary ?? `${packageName} ${externalId}`,
    advisoryUrl: alert.html_url,
    remediation: vuln.first_patched_version?.identifier ?? null,
    state: alert.state === 'open' ? 'OPEN' : 'FIXED',
    metadata: {
      cveId: advisory.cve_id ?? null,
      alertNumber: alert.number,
      alertState: alert.state,
    },
  };
  finding.dedupId = dedupId(finding);
  return finding;
}
```

Note: GitHub's `state` query param accepts `open`, `fixed`, `dismissed`, `auto_dismissed`. Passing `state=auto` is not valid — instead **omit** the filter and the API returns all states. Adjust the call to `gh.paginate(\`/orgs/${org}/dependabot/alerts\`, { per_page: 100 })`.

Fix the implementation before running tests:

```js
for await (const alert of gh.paginate(`/orgs/${org}/dependabot/alerts`, { per_page: 100 })) {
```

- [ ] **Step 4: Run tests, confirm pass**

Run: `npx vitest run tests/sources/dependabot.test.js`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/sources/dependabot.js tests/sources/dependabot.test.js
git commit -m "feat(sources): Dependabot alerts → SecurityFinding[]"
```

---

### Task 7: Asana client

**Files:**
- Create: `src/providers/asana/client.js`
- Test: `tests/providers/asana/client.test.js`

- [ ] **Step 1: Write failing test**

```js
// tests/providers/asana/client.test.js
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
```

- [ ] **Step 2: Run tests, confirm fail**

Run: `npx vitest run tests/providers/asana/client.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/providers/asana/client.js`**

```js
const ASANA_BASE = 'https://app.asana.com/api/1.0';

export function createAsanaClient({ token, fetchImpl = fetch }) {
  if (!token) throw new Error('ASANA_ACCESS_TOKEN is required');

  async function request(method, path, body, { query } = {}) {
    const url = new URL(ASANA_BASE + path);
    if (query) for (const [k, v] of Object.entries(query)) if (v != null) url.searchParams.set(k, String(v));

    const res = await fetchImpl(url, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: body !== undefined ? JSON.stringify({ data: body }) : undefined,
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
  async function* paginate(path, query = {}) {
    const url = new URL(ASANA_BASE + path);
    const q = { limit: 100, ...query };
    for (const [k, v] of Object.entries(q)) if (v != null) url.searchParams.set(k, String(v));

    while (true) {
      const res = await fetchImpl(url, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/json',
        },
      });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`Asana GET ${url.pathname} → ${res.status}: ${text.slice(0, 500)}`);
      }
      const envelope = await res.json();
      for (const item of envelope.data ?? []) yield item;
      const next = envelope.next_page?.offset;
      if (!next) return;
      url.searchParams.set('offset', next);
    }
  }

  return { request, paginate };
}
```

- [ ] **Step 4: Run tests, confirm pass**

Run: `npx vitest run tests/providers/asana/client.test.js`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/providers/asana/client.js tests/providers/asana/client.test.js
git commit -m "feat(asana): API client with pagination"
```

---

### Task 8: Asana schema constants

**Files:**
- Create: `src/providers/asana/schema.js`

- [ ] **Step 1: Implement**

```js
export const SECTION_TEAM_ASSIGNMENT = 'Team Assignment';

export const SECTION_BY_SEVERITY = {
  CRITICAL: 'Critical',
  HIGH: 'High',
  MEDIUM: 'Medium',
  LOW: 'Low',
};

export const FIELD = {
  DEDUP: 'Deduplication ID',
  SEVERITY: 'Severity',
  REPOSITORY: 'Repository',
  PACKAGE: 'Package',
  ADVISORY: 'Advisory',
  ADVISORY_URL: 'Advisory URL',
  TECH_TEAM: 'Tech Team',
};

export const SEVERITY_ENUM_OPTIONS = [
  { name: 'Critical', color: 'red' },
  { name: 'High', color: 'orange' },
  { name: 'Medium', color: 'yellow' },
  { name: 'Low', color: 'cool-gray' },
];

export const SEVERITY_TO_OPTION_NAME = {
  CRITICAL: 'Critical',
  HIGH: 'High',
  MEDIUM: 'Medium',
  LOW: 'Low',
};
```

- [ ] **Step 2: Commit**

```bash
git add src/providers/asana/schema.js
git commit -m "feat(asana): schema constants for sections and custom fields"
```

---

### Task 9: Asana provider — loadContext + listExistingTickets

**Files:**
- Create: `src/providers/asana/provider.js`
- Test: `tests/providers/asana/provider.test.js`

This task and the next four (10–13) all add behavior to the same `provider.js` file. Each task adds one method and one block of tests.

- [ ] **Step 1: Write failing test**

```js
// tests/providers/asana/provider.test.js
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
    // Team Assignment section listing for team mapping
    client.paginate.mockImplementation(function* () { /* default empty */ }.bind(null));
    client.paginate.mockReturnValue((async function* () {})());

    await provider.loadContext();
    // Should have requested custom field settings and sections
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
```

- [ ] **Step 2: Run tests, confirm fail**

Run: `npx vitest run tests/providers/asana/provider.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/providers/asana/provider.js` (initial)**

```js
import { FIELD, SECTION_BY_SEVERITY, SECTION_TEAM_ASSIGNMENT, SEVERITY_TO_OPTION_NAME } from './schema.js';

export function createAsanaProvider({ client, projectGid, logger }) {
  const ctx = {
    fields: {},         // logical name → { gid, type, options: Map<name, gid> }
    sections: {},       // logical name → gid
    teamMapping: new Map(), // repoName → techTeamGid
  };

  async function loadContext() {
    const settings = await client.request('GET', `/projects/${projectGid}/custom_field_settings`, undefined, {
      query: { opt_fields: 'custom_field.gid,custom_field.name,custom_field.resource_subtype,custom_field.enum_options.gid,custom_field.enum_options.name,custom_field.enum_options.enabled' },
    });
    for (const s of settings ?? []) {
      const cf = s.custom_field ?? s;
      if (!cf?.name) continue;
      const options = new Map();
      for (const o of cf.enum_options ?? []) options.set(o.name, o.gid);
      ctx.fields[cf.name] = { gid: cf.gid, type: cf.resource_subtype, options };
    }
    requireField(FIELD.DEDUP);
    requireField(FIELD.SEVERITY);
    requireField(FIELD.REPOSITORY);
    requireField(FIELD.PACKAGE);
    requireField(FIELD.ADVISORY);
    requireField(FIELD.ADVISORY_URL);
    requireField(FIELD.TECH_TEAM);

    const sections = await client.request('GET', `/projects/${projectGid}/sections`, undefined, {
      query: { opt_fields: 'name,gid' },
    });
    for (const sec of sections ?? []) ctx.sections[sec.name] = sec.gid;
    requireSection(SECTION_TEAM_ASSIGNMENT);
    for (const sev of Object.values(SECTION_BY_SEVERITY)) requireSection(sev);

    await loadTeamMapping();
  }

  async function loadTeamMapping() {
    const teamSectionGid = ctx.sections[SECTION_TEAM_ASSIGNMENT];
    const repoField = ctx.fields[FIELD.REPOSITORY];
    const teamField = ctx.fields[FIELD.TECH_TEAM];

    const it = client.paginate(`/sections/${teamSectionGid}/tasks`, {
      opt_fields: 'name,custom_fields.gid,custom_fields.enum_value.gid,custom_fields.enum_value.name',
    });
    for await (const task of it) {
      const fields = task.custom_fields ?? [];
      const repoOpt = fields.find(f => f.gid === repoField.gid)?.enum_value;
      const teamOpt = fields.find(f => f.gid === teamField.gid)?.enum_value;
      if (repoOpt?.name && teamOpt?.gid) ctx.teamMapping.set(repoOpt.name, teamOpt.gid);
    }
    logger.info(`Loaded team mapping for ${ctx.teamMapping.size} repositories.`);
  }

  async function listExistingTickets() {
    const dedupGid = ctx.fields[FIELD.DEDUP].gid;
    const map = new Map();
    const it = client.paginate(`/projects/${projectGid}/tasks`, {
      opt_fields: 'name,completed,custom_fields.gid,custom_fields.text_value,custom_fields.enum_value.gid,custom_fields.enum_value.name,memberships.section.gid',
    });
    for await (const task of it) {
      const dedup = (task.custom_fields ?? []).find(f => f.gid === dedupGid)?.text_value;
      if (!dedup) continue;
      map.set(dedup, {
        gid: task.gid,
        dedupId: dedup,
        completed: !!task.completed,
        name: task.name,
        customFields: task.custom_fields ?? [],
        sectionGids: (task.memberships ?? []).map(m => m.section?.gid).filter(Boolean),
      });
    }
    return map;
  }

  function requireField(name) {
    if (!ctx.fields[name]) throw new Error(`Asana project ${projectGid} is missing custom field "${name}". Run \`sws bootstrap\` first.`);
  }
  function requireSection(name) {
    if (!ctx.sections[name]) throw new Error(`Asana project ${projectGid} is missing section "${name}". Run \`sws bootstrap\` first.`);
  }

  return {
    loadContext,
    listExistingTickets,
    // createTicket, updateTicket, closeTicket — added in subsequent tasks
    _ctx: ctx, // exposed for testing only
  };
}
```

- [ ] **Step 4: Run tests, confirm pass**

Run: `npx vitest run tests/providers/asana/provider.test.js`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/providers/asana/provider.js tests/providers/asana/provider.test.js
git commit -m "feat(asana): provider loadContext + listExistingTickets"
```

---

### Task 10: Asana provider — enum option upsert + createTicket

**Files:**
- Modify: `src/providers/asana/provider.js`
- Modify: `tests/providers/asana/provider.test.js`

- [ ] **Step 1: Add tests**

Append to `tests/providers/asana/provider.test.js`:

```js
describe('AsanaProvider.createTicket', () => {
  let client, provider;
  beforeEach(() => {
    client = fakeClient();
    provider = createAsanaProvider({ client, projectGid: 'P', logger: { info() {}, warn() {}, error() {} } });
    setupContext(client);
    client.paginate.mockReturnValue((async function* () {})());
  });

  it('creates a task with all custom fields, in the severity section, and assigns Tech Team when repo is mapped', async () => {
    // Pre-populate team mapping for repo-1
    await provider.loadContext();
    provider._ctx.teamMapping.set('org/repo-1', 'team-platform');

    client.request.mockResolvedValue({ gid: 'NEW' });

    const finding = {
      dedupId: 'abc123def456',
      source: 'github',
      externalId: 'GHSA-x',
      repository: 'org/repo-1',
      packageName: 'lodash',
      severity: 'HIGH',
      title: 'Prototype pollution',
      advisoryUrl: 'https://github.com/advisories/GHSA-x',
      remediation: '4.17.21',
    };

    const out = await provider.createTicket(finding);
    expect(out.action).toBe('created');

    const createCall = client.request.mock.calls.find(c => c[0] === 'POST' && c[1] === '/tasks');
    expect(createCall).toBeDefined();
    const payload = createCall[2];
    expect(payload.projects).toEqual(['P']);
    expect(payload.memberships).toEqual([{ project: 'P', section: 'sec-high' }]);
    expect(payload.custom_fields['cf-dedup']).toBe('abc123def456');
    expect(payload.custom_fields['cf-sev']).toBe('sev-high');
    expect(payload.custom_fields['cf-repo']).toBe('repo-1');
    expect(payload.custom_fields['cf-adv']).toBe('GHSA-x');
    expect(payload.custom_fields['cf-advurl']).toBe('https://github.com/advisories/GHSA-x');
    expect(payload.custom_fields['cf-team']).toBe('team-platform');
  });

  it('creates a new Package enum option when the package is unseen', async () => {
    await provider.loadContext();

    // First call to create the enum option, then the task creation
    client.request.mockImplementation(async (method, path, body) => {
      if (method === 'POST' && path === '/custom_fields/cf-pkg/enum_options') {
        return { gid: 'pkg-new', name: body.name };
      }
      if (method === 'POST' && path === '/tasks') return { gid: 'NEW' };
      // fall through to setupContext defaults for other paths
      return setupContext._defaults?.(method, path) ?? null;
    });

    const finding = {
      dedupId: 'd', source: 'github', externalId: 'GHSA-y', repository: 'org/repo-1',
      packageName: 'brand-new-package', severity: 'LOW', title: 't', advisoryUrl: 'u', remediation: null,
    };
    await provider.createTicket(finding);
    const optCall = client.request.mock.calls.find(c => c[1] === '/custom_fields/cf-pkg/enum_options');
    expect(optCall[2]).toEqual({ name: 'brand-new-package' });
    expect(provider._ctx.fields['Package'].options.get('brand-new-package')).toBe('pkg-new');
  });

  it('omits Tech Team when repo has no mapping', async () => {
    await provider.loadContext();
    client.request.mockResolvedValue({ gid: 'NEW' });

    const finding = {
      dedupId: 'e', source: 'github', externalId: 'GHSA-z', repository: 'org/unmapped',
      packageName: 'lodash', severity: 'MEDIUM', title: 't', advisoryUrl: 'u', remediation: null,
    };
    await provider.createTicket(finding);
    const createCall = client.request.mock.calls.find(c => c[0] === 'POST' && c[1] === '/tasks');
    expect(createCall[2].custom_fields['cf-team']).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run, confirm fail**

Run: `npx vitest run tests/providers/asana/provider.test.js`
Expected: FAIL — `createTicket is not a function`.

- [ ] **Step 3: Add `createTicket` + helpers to `provider.js`**

Insert into the factory (after `listExistingTickets`):

```js
  async function ensureEnumOption(fieldName, optionName) {
    const field = ctx.fields[fieldName];
    if (!field) throw new Error(`Unknown field ${fieldName}`);
    let gid = field.options.get(optionName);
    if (gid) return gid;
    const created = await client.request('POST', `/custom_fields/${field.gid}/enum_options`, { name: optionName });
    gid = created.gid;
    field.options.set(optionName, gid);
    return gid;
  }

  function severityToSectionGid(severity) {
    const sectionName = SECTION_BY_SEVERITY[severity];
    return ctx.sections[sectionName];
  }

  function severityToOptionGid(severity) {
    const optName = SEVERITY_TO_OPTION_NAME[severity];
    return ctx.fields[FIELD.SEVERITY].options.get(optName);
  }

  function buildTaskName(f) {
    const sev = SEVERITY_TO_OPTION_NAME[f.severity] ?? f.severity;
    return `[${sev}] ${f.packageName} – ${f.repository}`;
  }

  function buildTaskNotes(f) {
    const lines = [
      `Advisory: ${f.externalId}`,
      f.advisoryUrl ? `URL: ${f.advisoryUrl}` : null,
      `Repository: ${f.repository}`,
      `Package: ${f.packageName}${f.ecosystem ? ` (${f.ecosystem})` : ''}`,
      `Severity: ${f.severity}`,
      f.remediation ? `Patched in: ${f.remediation}` : 'No patched version available yet.',
      '',
      f.title || '',
      '',
      '— Managed by security-workflow-sync. Do not change the Deduplication ID.',
    ];
    return lines.filter(l => l !== null).join('\n');
  }

  async function buildCustomFieldsPayload(f) {
    const repoOptGid = await ensureEnumOption(FIELD.REPOSITORY, f.repository);
    const pkgOptGid = await ensureEnumOption(FIELD.PACKAGE, f.packageName);
    const cf = {
      [ctx.fields[FIELD.DEDUP].gid]: f.dedupId,
      [ctx.fields[FIELD.SEVERITY].gid]: severityToOptionGid(f.severity),
      [ctx.fields[FIELD.REPOSITORY].gid]: repoOptGid,
      [ctx.fields[FIELD.PACKAGE].gid]: pkgOptGid,
      [ctx.fields[FIELD.ADVISORY].gid]: f.externalId ?? '',
      [ctx.fields[FIELD.ADVISORY_URL].gid]: f.advisoryUrl ?? '',
    };
    const teamGid = ctx.teamMapping.get(f.repository);
    if (teamGid) cf[ctx.fields[FIELD.TECH_TEAM].gid] = teamGid;
    return cf;
  }

  async function createTicket(finding) {
    const sectionGid = severityToSectionGid(finding.severity);
    const customFields = await buildCustomFieldsPayload(finding);
    await client.request('POST', '/tasks', {
      name: buildTaskName(finding),
      notes: buildTaskNotes(finding),
      projects: [projectGid],
      custom_fields: customFields,
      memberships: [{ project: projectGid, section: sectionGid }],
    });
    return { action: 'created', dedupId: finding.dedupId };
  }
```

Then export `createTicket` in the returned object.

- [ ] **Step 4: Run tests, confirm pass**

Run: `npx vitest run tests/providers/asana/provider.test.js`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/providers/asana/provider.js tests/providers/asana/provider.test.js
git commit -m "feat(asana): createTicket with enum option upsert and team assignment"
```

---

### Task 11: Asana provider — updateTicket (with reopen + ownership persistence)

**Files:**
- Modify: `src/providers/asana/provider.js`
- Modify: `tests/providers/asana/provider.test.js`

- [ ] **Step 1: Add tests**

```js
describe('AsanaProvider.updateTicket', () => {
  let client, provider;
  beforeEach(async () => {
    client = fakeClient();
    provider = createAsanaProvider({ client, projectGid: 'P', logger: { info() {}, warn() {}, error() {} } });
    setupContext(client);
    client.paginate.mockReturnValue((async function* () {})());
    await provider.loadContext();
  });

  function findingFor(overrides = {}) {
    return {
      dedupId: 'd', source: 'github', externalId: 'GHSA-x', repository: 'org/repo-1',
      packageName: 'lodash', severity: 'HIGH', title: 't',
      advisoryUrl: 'https://github.com/advisories/GHSA-x', remediation: '4.17.21',
      ...overrides,
    };
  }

  it('returns noop when the existing task already matches and is open', async () => {
    const existing = {
      gid: 'T1', dedupId: 'd', completed: false,
      customFields: [
        { gid: 'cf-sev', enum_value: { gid: 'sev-high' } },
        { gid: 'cf-team', enum_value: { gid: 'team-platform' } },
      ],
      sectionGids: ['sec-high'],
    };
    provider._ctx.teamMapping.set('org/repo-1', 'team-platform');

    client.request.mockResolvedValue({});
    const out = await provider.updateTicket(findingFor(), existing);
    expect(out.action).toBe('noop');
    // No PUT issued
    expect(client.request.mock.calls.find(c => c[0] === 'PUT' && c[1].startsWith('/tasks/'))).toBeUndefined();
  });

  it('reopens a completed task and adds a story', async () => {
    const existing = {
      gid: 'T1', dedupId: 'd', completed: true,
      customFields: [{ gid: 'cf-sev', enum_value: { gid: 'sev-high' } }],
      sectionGids: ['sec-high'],
    };
    client.request.mockResolvedValue({});
    const out = await provider.updateTicket(findingFor(), existing);
    expect(out.action).toBe('reopened');
    const putCall = client.request.mock.calls.find(c => c[0] === 'PUT' && c[1] === '/tasks/T1');
    expect(putCall[2].completed).toBe(false);
    const storyCall = client.request.mock.calls.find(c => c[1] === '/tasks/T1/stories');
    expect(storyCall[2].text).toMatch(/reopened/i);
  });

  it('moves the task to the new severity section when severity changed', async () => {
    const existing = {
      gid: 'T1', dedupId: 'd', completed: false,
      customFields: [{ gid: 'cf-sev', enum_value: { gid: 'sev-low' } }],
      sectionGids: ['sec-low'],
    };
    client.request.mockResolvedValue({});
    const out = await provider.updateTicket(findingFor({ severity: 'HIGH' }), existing);
    expect(out.action).toBe('updated');
    const moveCall = client.request.mock.calls.find(c => c[1] === '/sections/sec-high/addTask');
    expect(moveCall).toBeDefined();
    expect(moveCall[2]).toEqual({ task: 'T1' });
  });

  it('preserves an existing Tech Team assignment even when the repo mapping is now empty (append-only)', async () => {
    const existing = {
      gid: 'T1', dedupId: 'd', completed: false,
      customFields: [
        { gid: 'cf-sev', enum_value: { gid: 'sev-high' } },
        { gid: 'cf-team', enum_value: { gid: 'team-platform' } }, // already assigned
      ],
      sectionGids: ['sec-high'],
    };
    // No mapping in ctx → mapping says "no team"
    client.request.mockResolvedValue({});
    const out = await provider.updateTicket(findingFor(), existing);

    // Must not have overwritten the Tech Team field
    const putCall = client.request.mock.calls.find(c => c[0] === 'PUT' && c[1] === '/tasks/T1');
    if (putCall) {
      expect(putCall[2].custom_fields?.['cf-team']).toBeUndefined();
    }
    expect(['noop', 'updated']).toContain(out.action);
  });

  it('assigns Tech Team if the existing task lacks it and the repo is now mapped', async () => {
    const existing = {
      gid: 'T1', dedupId: 'd', completed: false,
      customFields: [
        { gid: 'cf-sev', enum_value: { gid: 'sev-high' } },
        // no cf-team
      ],
      sectionGids: ['sec-high'],
    };
    provider._ctx.teamMapping.set('org/repo-1', 'team-platform');
    client.request.mockResolvedValue({});
    const out = await provider.updateTicket(findingFor(), existing);
    expect(out.action).toBe('updated');
    const putCall = client.request.mock.calls.find(c => c[0] === 'PUT' && c[1] === '/tasks/T1');
    expect(putCall[2].custom_fields['cf-team']).toBe('team-platform');
  });
});
```

- [ ] **Step 2: Run, confirm fail**

Run: `npx vitest run tests/providers/asana/provider.test.js`
Expected: FAIL — `updateTicket is not a function`.

- [ ] **Step 3: Implement `updateTicket`**

Add to the factory:

```js
  async function updateTicket(finding, existing) {
    const newSevGid = severityToOptionGid(finding.severity);
    const newSectionGid = severityToSectionGid(finding.severity);

    const cfMap = new Map();
    for (const cf of existing.customFields ?? []) cfMap.set(cf.gid, cf);

    const currentSevGid = cfMap.get(ctx.fields[FIELD.SEVERITY].gid)?.enum_value?.gid ?? null;
    const currentTeamGid = cfMap.get(ctx.fields[FIELD.TECH_TEAM].gid)?.enum_value?.gid ?? null;
    const currentSectionGid = existing.sectionGids?.[0] ?? null;

    const updates = {};
    const needsReopen = !!existing.completed;
    const needsSeverity = currentSevGid !== newSevGid;
    const mappedTeam = ctx.teamMapping.get(finding.repository) ?? null;
    const needsTeamAssign = !currentTeamGid && !!mappedTeam;
    const needsSectionMove = currentSectionGid !== newSectionGid;

    // Name/notes are cheap and idempotent — refresh them when anything else changes.
    let touchedFields = false;
    const customFields = {};

    if (needsSeverity) { customFields[ctx.fields[FIELD.SEVERITY].gid] = newSevGid; touchedFields = true; }
    if (needsTeamAssign) { customFields[ctx.fields[FIELD.TECH_TEAM].gid] = mappedTeam; touchedFields = true; }

    const willPut = needsReopen || touchedFields;

    if (willPut) {
      updates.name = buildTaskName(finding);
      updates.notes = buildTaskNotes(finding);
      if (touchedFields) updates.custom_fields = customFields;
      if (needsReopen) updates.completed = false;
      await client.request('PUT', `/tasks/${existing.gid}`, updates);
    }

    if (needsReopen) {
      await client.request('POST', `/tasks/${existing.gid}/stories`, {
        text: 'Reopened automatically: this Dependabot alert is open again.',
      });
    }

    if (needsSectionMove && newSectionGid) {
      await client.request('POST', `/sections/${newSectionGid}/addTask`, { task: existing.gid });
    }

    if (needsReopen) return { action: 'reopened', dedupId: finding.dedupId };
    if (willPut || needsSectionMove) return { action: 'updated', dedupId: finding.dedupId };
    return { action: 'noop', dedupId: finding.dedupId };
  }
```

Export it in the returned object.

- [ ] **Step 4: Run tests, confirm pass**

Run: `npx vitest run tests/providers/asana/provider.test.js`
Expected: all tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/providers/asana/provider.js tests/providers/asana/provider.test.js
git commit -m "feat(asana): updateTicket with reopen and append-only team assignment"
```

---

### Task 12: Asana provider — closeTicket

**Files:**
- Modify: `src/providers/asana/provider.js`
- Modify: `tests/providers/asana/provider.test.js`

- [ ] **Step 1: Add tests**

```js
describe('AsanaProvider.closeTicket', () => {
  let client, provider;
  beforeEach(async () => {
    client = fakeClient();
    provider = createAsanaProvider({ client, projectGid: 'P', logger: { info() {}, warn() {}, error() {} } });
    setupContext(client);
    client.paginate.mockReturnValue((async function* () {})());
    await provider.loadContext();
  });

  it('completes the task and writes a story', async () => {
    client.request.mockResolvedValue({});
    const out = await provider.closeTicket({ gid: 'T1', dedupId: 'd', completed: false });
    expect(out.action).toBe('closed');
    const putCall = client.request.mock.calls.find(c => c[0] === 'PUT' && c[1] === '/tasks/T1');
    expect(putCall[2].completed).toBe(true);
    const storyCall = client.request.mock.calls.find(c => c[1] === '/tasks/T1/stories');
    expect(storyCall[2].text).toMatch(/resolved|fixed|dismissed|closed/i);
  });
});
```

- [ ] **Step 2: Run, confirm fail**

Run: `npx vitest run tests/providers/asana/provider.test.js`
Expected: FAIL — `closeTicket is not a function`.

- [ ] **Step 3: Implement**

```js
  async function closeTicket(existing) {
    await client.request('PUT', `/tasks/${existing.gid}`, { completed: true });
    await client.request('POST', `/tasks/${existing.gid}/stories`, {
      text: 'Closed automatically: the underlying Dependabot alert is no longer open (fixed or dismissed).',
    });
    return { action: 'closed', dedupId: existing.dedupId };
  }
```

Export it.

- [ ] **Step 4: Run tests, confirm pass**

Run: `npx vitest run tests/providers/asana/provider.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/providers/asana/provider.js tests/providers/asana/provider.test.js
git commit -m "feat(asana): closeTicket"
```

---

### Task 13: Asana provider — ensure Team Assignment placeholder tasks

The reference implementation creates a Team Assignment placeholder for every repo it encounters, so the user has a single place to set team ownership. We replicate that.

**Files:**
- Modify: `src/providers/asana/provider.js`
- Modify: `tests/providers/asana/provider.test.js`

- [ ] **Step 1: Add tests**

```js
describe('AsanaProvider.ensureTeamAssignmentTasks', () => {
  let client, provider;
  beforeEach(async () => {
    client = fakeClient();
    provider = createAsanaProvider({ client, projectGid: 'P', logger: { info() {}, warn() {}, error() {} } });
    setupContext(client);
    client.paginate.mockReturnValue((async function* () {})());
    await provider.loadContext();
  });

  it('creates a placeholder task for each unseen repository in the Team Assignment section', async () => {
    // Pretend we already have a Team Assignment for org/repo-1
    provider._ctx.teamMapping.set('org/repo-1', 'team-platform');
    // Add a known placeholder name set
    provider._ctx.knownTeamAssignmentRepos = new Set(['org/repo-1']);

    client.request.mockImplementation(async (method, path, body) => {
      if (path === '/custom_fields/cf-repo/enum_options') return { gid: 'repo-2', name: body.name };
      if (path === '/tasks') return { gid: 'NEW' };
      return {};
    });

    await provider.ensureTeamAssignmentTasks(['org/repo-1', 'org/repo-2']);

    const postTasks = client.request.mock.calls.filter(c => c[0] === 'POST' && c[1] === '/tasks');
    expect(postTasks).toHaveLength(1);
    expect(postTasks[0][2]).toMatchObject({
      name: 'org/repo-2',
      projects: ['P'],
      memberships: [{ project: 'P', section: 'sec-team' }],
      custom_fields: { 'cf-repo': 'repo-2' },
    });
  });
});
```

- [ ] **Step 2: Run, confirm fail**

Run: `npx vitest run tests/providers/asana/provider.test.js`
Expected: FAIL — `ensureTeamAssignmentTasks is not a function`.

- [ ] **Step 3: Implement and adjust `loadTeamMapping` to record known repos**

In `loadTeamMapping`, after building the map, also populate `ctx.knownTeamAssignmentRepos`:

```js
  async function loadTeamMapping() {
    const teamSectionGid = ctx.sections[SECTION_TEAM_ASSIGNMENT];
    const repoField = ctx.fields[FIELD.REPOSITORY];
    const teamField = ctx.fields[FIELD.TECH_TEAM];
    ctx.knownTeamAssignmentRepos = new Set();

    const it = client.paginate(`/sections/${teamSectionGid}/tasks`, {
      opt_fields: 'name,custom_fields.gid,custom_fields.enum_value.gid,custom_fields.enum_value.name',
    });
    for await (const task of it) {
      const fields = task.custom_fields ?? [];
      const repoOpt = fields.find(f => f.gid === repoField.gid)?.enum_value;
      const teamOpt = fields.find(f => f.gid === teamField.gid)?.enum_value;
      if (repoOpt?.name) {
        ctx.knownTeamAssignmentRepos.add(repoOpt.name);
        if (teamOpt?.gid) ctx.teamMapping.set(repoOpt.name, teamOpt.gid);
      }
    }
    logger.info(`Loaded ${ctx.knownTeamAssignmentRepos.size} Team Assignment placeholders (${ctx.teamMapping.size} with a Tech Team set).`);
  }

  async function ensureTeamAssignmentTasks(repositories) {
    const teamSectionGid = ctx.sections[SECTION_TEAM_ASSIGNMENT];
    const repoField = ctx.fields[FIELD.REPOSITORY];
    let created = 0;
    for (const repo of repositories) {
      if (ctx.knownTeamAssignmentRepos?.has(repo)) continue;
      const repoOptGid = await ensureEnumOption(FIELD.REPOSITORY, repo);
      await client.request('POST', '/tasks', {
        name: repo,
        notes: 'Set the Tech Team for this repository. New Dependabot alerts will be auto-assigned to it.',
        projects: [projectGid],
        custom_fields: { [repoField.gid]: repoOptGid },
        memberships: [{ project: projectGid, section: teamSectionGid }],
      });
      ctx.knownTeamAssignmentRepos.add(repo);
      created++;
    }
    if (created > 0) logger.info(`Created ${created} Team Assignment placeholder task(s).`);
  }
```

Export `ensureTeamAssignmentTasks`.

- [ ] **Step 4: Run tests, confirm pass**

Run: `npx vitest run tests/providers/asana/provider.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/providers/asana/provider.js tests/providers/asana/provider.test.js
git commit -m "feat(asana): ensureTeamAssignmentTasks placeholders"
```

---

### Task 14: Config loader

**Files:**
- Create: `src/config.js`

- [ ] **Step 1: Implement**

```js
export function loadConfig(env = process.env) {
  const required = ['GITHUB_TOKEN', 'GITHUB_ORG', 'ASANA_ACCESS_TOKEN', 'ASANA_PROJECT_GID'];
  const missing = required.filter(k => !env[k]);
  return {
    githubToken: env.GITHUB_TOKEN,
    githubOrg: env.GITHUB_ORG,
    asanaToken: env.ASANA_ACCESS_TOKEN,
    asanaProjectGid: env.ASANA_PROJECT_GID,
    asanaWorkspaceGid: env.ASANA_WORKSPACE_GID, // only required for bootstrap
    missing,
  };
}

export function assertSyncConfig(cfg) {
  if (cfg.missing.length) throw new Error(`Missing required env vars: ${cfg.missing.join(', ')}`);
}

export function assertBootstrapConfig(cfg) {
  const need = ['ASANA_ACCESS_TOKEN', 'ASANA_WORKSPACE_GID'];
  const missing = need.filter(k => {
    if (k === 'ASANA_ACCESS_TOKEN') return !cfg.asanaToken;
    if (k === 'ASANA_WORKSPACE_GID') return !cfg.asanaWorkspaceGid;
    return false;
  });
  if (missing.length) throw new Error(`Missing required env vars for bootstrap: ${missing.join(', ')}`);
}
```

- [ ] **Step 2: Commit**

```bash
git add src/config.js
git commit -m "feat: env-based config loader"
```

---

### Task 15: Sync command

**Files:**
- Create: `src/commands/sync.js`

- [ ] **Step 1: Implement**

```js
import { fetchDependabotFindings } from '../sources/dependabot.js';
import { reconcile } from '../core/reconcile.js';
import { createAsanaClient } from '../providers/asana/client.js';
import { createAsanaProvider } from '../providers/asana/provider.js';

export async function runSync({ config, logger }) {
  logger.info(`Fetching Dependabot alerts for org "${config.githubOrg}"…`);
  const findings = await fetchDependabotFindings({ org: config.githubOrg, token: config.githubToken });
  logger.info(`Fetched ${findings.length} alerts (${countByState(findings)}).`);

  const client = createAsanaClient({ token: config.asanaToken });
  const provider = createAsanaProvider({ client, projectGid: config.asanaProjectGid, logger });

  await provider.loadContext();

  const uniqueRepos = [...new Set(findings.map(f => f.repository).filter(Boolean))];
  await provider.ensureTeamAssignmentTasks(uniqueRepos);

  // Reload mapping so any *just-created* placeholders the user has since annotated are picked up next run.
  // For this run, placeholders we just created have no team yet — that's expected.

  const result = await reconcile(findings, provider);

  const summary = {
    fetched: findings.length,
    repos: uniqueRepos.length,
    ...result,
  };
  process.stdout.write(JSON.stringify(summary) + '\n');
  logger.info(`Sync complete: ${JSON.stringify(summary)}`);
  return summary;
}

function countByState(findings) {
  const open = findings.filter(f => f.state === 'OPEN').length;
  const fixed = findings.length - open;
  return `${open} open / ${fixed} fixed-or-dismissed`;
}
```

- [ ] **Step 2: Commit**

```bash
git add src/commands/sync.js
git commit -m "feat(commands): sync wires source → core → asana provider"
```

---

### Task 16: Bootstrap command

This creates the Asana project, its sections, and its custom fields, then prints `ASANA_PROJECT_GID` to stdout for the user to copy into env.

**Files:**
- Create: `src/providers/asana/bootstrap.js`
- Create: `src/commands/bootstrap.js`

- [ ] **Step 1: Implement `src/providers/asana/bootstrap.js`**

```js
import { FIELD, SECTION_BY_SEVERITY, SECTION_TEAM_ASSIGNMENT, SEVERITY_ENUM_OPTIONS } from './schema.js';

export async function bootstrapAsanaProject({ client, workspaceGid, teamGid, projectName, logger }) {
  logger.info(`Creating Asana project "${projectName}" in workspace ${workspaceGid}…`);

  const projectBody = { name: projectName, workspace: workspaceGid, default_view: 'board' };
  if (teamGid) projectBody.team = teamGid;
  const project = await client.request('POST', '/projects', projectBody);
  logger.info(`Created project ${project.gid}.`);

  // 1. Sections (Asana auto-creates a default "Untitled section" we leave alone)
  const sectionsToCreate = [SECTION_TEAM_ASSIGNMENT, ...Object.values(SECTION_BY_SEVERITY)];
  for (const name of sectionsToCreate) {
    await client.request('POST', `/projects/${project.gid}/sections`, { name });
    logger.info(`Created section "${name}".`);
  }

  // 2. Custom fields
  const textFields = [FIELD.DEDUP, FIELD.ADVISORY, FIELD.ADVISORY_URL];
  for (const name of textFields) {
    const field = await client.request('POST', '/custom_fields', {
      workspace: workspaceGid,
      resource_subtype: 'text',
      name,
    });
    await client.request('POST', `/projects/${project.gid}/addCustomFieldSetting`, {
      custom_field: field.gid,
    });
    logger.info(`Created text custom field "${name}" (${field.gid}).`);
  }

  // Severity enum: pre-populated
  const severity = await client.request('POST', '/custom_fields', {
    workspace: workspaceGid,
    resource_subtype: 'enum',
    name: FIELD.SEVERITY,
    enum_options: SEVERITY_ENUM_OPTIONS,
  });
  await client.request('POST', `/projects/${project.gid}/addCustomFieldSetting`, { custom_field: severity.gid });
  logger.info(`Created enum custom field "${FIELD.SEVERITY}".`);

  // Repository / Package / Tech Team: empty enums, options grow at sync time
  for (const name of [FIELD.REPOSITORY, FIELD.PACKAGE, FIELD.TECH_TEAM]) {
    const field = await client.request('POST', '/custom_fields', {
      workspace: workspaceGid,
      resource_subtype: 'enum',
      name,
      enum_options: [],
    });
    await client.request('POST', `/projects/${project.gid}/addCustomFieldSetting`, { custom_field: field.gid });
    logger.info(`Created enum custom field "${name}".`);
  }

  return { projectGid: project.gid };
}
```

- [ ] **Step 2: Implement `src/commands/bootstrap.js`**

```js
import { createAsanaClient } from '../providers/asana/client.js';
import { bootstrapAsanaProject } from '../providers/asana/bootstrap.js';

export async function runBootstrap({ config, projectName, teamGid, logger }) {
  const client = createAsanaClient({ token: config.asanaToken });
  const { projectGid } = await bootstrapAsanaProject({
    client,
    workspaceGid: config.asanaWorkspaceGid,
    teamGid,
    projectName: projectName || 'Security Findings',
    logger,
  });

  process.stdout.write([
    '',
    'Bootstrap complete.',
    'Export the following env var when running `sws sync`:',
    '',
    `  ASANA_PROJECT_GID=${projectGid}`,
    '',
    'Next: open the Asana project, then for each repository placeholder in the "Team Assignment" section,',
    'set the "Tech Team" enum field. From then on, new Dependabot alerts for that repository will be',
    'auto-assigned to that team.',
    '',
  ].join('\n'));
}
```

- [ ] **Step 3: Commit**

```bash
git add src/providers/asana/bootstrap.js src/commands/bootstrap.js
git commit -m "feat(commands): bootstrap asana project with sections and fields"
```

---

### Task 17: CLI entrypoint

**Files:**
- Create: `bin/sws.js`
- Create: `src/cli.js`

- [ ] **Step 1: Write `bin/sws.js`**

```js
#!/usr/bin/env node
import { main } from '../src/cli.js';

main(process.argv.slice(2)).catch((err) => {
  process.stderr.write(`[fatal] ${err.message}\n`);
  if (process.env.SWS_DEBUG) process.stderr.write(err.stack + '\n');
  process.exit(1);
});
```

- [ ] **Step 2: Write `src/cli.js`**

```js
import { parseArgs } from 'node:util';
import { loadConfig, assertSyncConfig, assertBootstrapConfig } from './config.js';
import { createLogger } from './core/logger.js';
import { runSync } from './commands/sync.js';
import { runBootstrap } from './commands/bootstrap.js';

const HELP = `
sws — security-workflow-sync

Usage:
  sws sync                    Sync Dependabot alerts → Asana
  sws bootstrap [--name N]    Create the Asana project (sections + custom fields)
  sws --help

Env (sync):
  GITHUB_TOKEN           PAT with security_events scope at org level
  GITHUB_ORG             GitHub org slug
  ASANA_ACCESS_TOKEN     Personal access token
  ASANA_PROJECT_GID      Target project (printed by 'sws bootstrap')

Env (bootstrap):
  ASANA_ACCESS_TOKEN
  ASANA_WORKSPACE_GID    The Asana workspace to create the project in
  ASANA_TEAM_GID         (optional) The Asana team to place the project under

Flags:
  --quiet                Suppress info logs
  --name <string>        (bootstrap only) Project name (default: "Security Findings")
`;

export async function main(argv) {
  if (argv.length === 0 || argv[0] === '--help' || argv[0] === '-h') {
    process.stdout.write(HELP);
    return;
  }
  const [command, ...rest] = argv;
  const { values } = parseArgs({
    args: rest,
    options: {
      quiet: { type: 'boolean' },
      name: { type: 'string' },
    },
    allowPositionals: true,
  });
  const logger = createLogger({ quiet: !!values.quiet });
  const config = loadConfig();

  if (command === 'sync') {
    assertSyncConfig(config);
    await runSync({ config, logger });
    return;
  }
  if (command === 'bootstrap') {
    assertBootstrapConfig(config);
    await runBootstrap({ config, projectName: values.name, teamGid: process.env.ASANA_TEAM_GID, logger });
    return;
  }
  process.stderr.write(`Unknown command: ${command}\n${HELP}`);
  process.exit(2);
}
```

- [ ] **Step 3: Mark executable**

Run: `chmod +x bin/sws.js`

- [ ] **Step 4: Smoke test**

Run: `node bin/sws.js --help`
Expected: prints the help block.

Run: `node bin/sws.js sync` (without env)
Expected: exits non-zero with `Missing required env vars: …`.

- [ ] **Step 5: Commit**

```bash
git add bin/sws.js src/cli.js
chmod +x bin/sws.js
git commit -m "feat(cli): sync and bootstrap subcommands"
```

---

### Task 18: Dockerfile

**Files:**
- Create: `Dockerfile`

- [ ] **Step 1: Write `Dockerfile`**

```dockerfile
FROM node:24.14.1-alpine

WORKDIR /app

# No runtime deps — copy the lockfile + package.json so `npm ci --omit=dev` is still well-defined
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev || npm install --omit=dev

COPY bin ./bin
COPY src ./src

RUN chmod +x ./bin/sws.js

# Default to `sync` so `docker run …/security-workflow-sync` is the canonical invocation,
# but allow override (e.g. `docker run … bootstrap`).
ENTRYPOINT ["node", "/app/bin/sws.js"]
CMD ["sync"]
```

- [ ] **Step 2: Build & smoke test**

Run: `docker build -t security-workflow-sync:dev .`
Expected: build succeeds.

Run: `docker run --rm security-workflow-sync:dev --help`
Expected: help text printed.

- [ ] **Step 3: Commit**

```bash
git add Dockerfile
git commit -m "build: alpine-based Dockerfile, ENTRYPOINT sws"
```

---

### Task 19: README

**Files:**
- Create: `README.md`

- [ ] **Step 1: Write the README**

Content outline (one ~150-line README, no fluff):

1. **What it does** — one paragraph framing as a workflow bridge, not a dashboard.
2. **Quickstart** —
   - Generate `GITHUB_TOKEN` with org-level `security_events` scope.
   - Generate Asana PAT.
   - Find Asana `WORKSPACE_GID` (link to docs).
   - Run bootstrap:
     ```bash
     docker run --rm \
       -e ASANA_ACCESS_TOKEN=... \
       -e ASANA_WORKSPACE_GID=... \
       ghcr.io/<you>/security-workflow-sync:latest bootstrap
     ```
   - Copy printed `ASANA_PROJECT_GID`.
   - Run sync:
     ```bash
     docker run --rm \
       -e GITHUB_TOKEN=... \
       -e GITHUB_ORG=... \
       -e ASANA_ACCESS_TOKEN=... \
       -e ASANA_PROJECT_GID=... \
       ghcr.io/<you>/security-workflow-sync:latest sync
     ```
3. **Team assignment** — explain that the project's "Team Assignment" section has one task per repository, and the user fills in the "Tech Team" field. Every subsequent sync auto-routes new alerts.
4. **Idempotency** — explain the dedup key, that the tool is safe to cron, that ownership is append-only.
5. **Cron example** — GitHub Actions snippet or a plain crontab.
6. **What the tool does NOT do** — no dashboard, no scanning, no severity filtering (yet).
7. **Roadmap** — Jira, Linear, GitHub Issues; future filtering by severity; future enrichments.
8. **Development** — `npm install && npm test`.
9. **License** — MIT.

- [ ] **Step 2: Commit**

```bash
git add README.md
git commit -m "docs: README"
```

---

### Task 20: Full test sweep + final wiring smoke test

- [ ] **Step 1: Run the full test suite**

Run: `npm test`
Expected: all suites pass, 0 failures, > 20 tests total.

- [ ] **Step 2: Dry-run smoke test with fake env**

Without real tokens, verify the CLI's failure modes are clean:
- `node bin/sws.js sync` → exits 1 with missing-env message.
- `node bin/sws.js bootstrap` → exits 1 with missing-env message.
- `node bin/sws.js something-else` → exits 2 with usage.

- [ ] **Step 3: Final commit**

If anything was tweaked in step 2:

```bash
git add -A
git commit -m "chore: final wiring polish"
```

---

## Self-Review Checklist (run before declaring plan complete)

1. **Spec coverage:**
   - Dockerized CLI → Task 18 ✓
   - Incremental & idempotent → reconcile (Task 3) keyed by stable `dedupId` (Task 2) ✓
   - No duplicates → `Deduplication ID` custom field is the primary key both at write and read (Tasks 9, 10) ✓
   - Team assignments preserved → Task 11 (append-only) + Task 13 (placeholders) ✓
   - Provider-agnostic core → Tasks 2, 3 know nothing about Asana ✓
   - Tests → Tasks 2, 3, 6, 7, 9–13 ✓
   - Node 24, JS, ESM, vitest, minimal deps, native fetch → Task 1 + Dockerfile (Task 18) ✓
   - Severity sections + custom fields mirror reference → Tasks 8, 10 ✓
   - Reopen on regression → Task 11 ✓
   - Auto-close on Dependabot `fixed`/`dismissed`/`auto_dismissed` → Tasks 6 (state mapping) + 3 (reconcile branch) + 12 (closeTicket) ✓
   - Bootstrap that prints next-step env → Task 16 ✓

2. **Placeholder scan:** No "TBD" or "implement later"; every step has full code blocks.

3. **Type consistency:** Field/section name constants live in one file (`src/providers/asana/schema.js`, Task 8) and are imported everywhere; `dedupId` signature is `({source,repository,packageName,externalId}) → string`; `createAsanaProvider` returns the same method names referenced in `reconcile`.

---

**Plan complete.**
