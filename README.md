# security-workflow-sync

Bring security findings into the workflow tool your engineers already use.

## What it does

security-workflow-sync is a workflow bridge, not a security dashboard. It reads open Dependabot alerts from a GitHub organization and creates or updates corresponding tasks in Asana. The sync is idempotent — running it twice produces no duplicates — so it is safe to schedule on a cron at any cadence. Team ownership is preserved across alert reopens: once a repo is assigned to a team, that assignment is never overwritten by subsequent syncs.

## Required GitHub setup (do this first)

This tool is a **bridge**, not a scanner. The scanning is done by GitHub. For the sync to find anything, two GitHub features must be enabled on each repository you want to monitor:

- **Dependency graph** — GitHub parses your manifest files (`package.json`, `requirements.txt`, `pom.xml`, `Gemfile.lock`, etc.) to build the list of declared dependencies.
- **Dependabot alerts** — GitHub matches that list against the [GitHub Advisory Database](https://github.com/advisories) and produces alerts for known vulnerabilities.

**Without both enabled, the Dependabot API returns zero alerts for that repo and `sws sync` will finish with `created: 0`.** A repo with scanning disabled looks identical to a clean repo from the API's perspective — the tool cannot tell them apart and cannot warn you. **Enable these before running the sync, otherwise the tool has nothing to read.**

### Recommended: enable for the whole organization in one shot

This covers every existing repo **and** every repo created in the future. The "automatically enable for new repositories" toggle is the important one — without it, new projects silently fall off the security radar.

1. Open: `https://github.com/organizations/<your-org>/settings/security_analysis`
2. Under **Dependency graph**:
   - Click **Enable all** to turn it on for every current repository.
   - Tick **Automatically enable for new public repositories** _and_ **for new private repositories**.
3. Under **Dependabot alerts**, do the same:
   - Click **Enable all**.
   - Tick **Automatically enable for new repositories** (public + private).

GitHub's full guide: <https://docs.github.com/en/organizations/keeping-your-organization-secure/managing-security-settings-for-your-organization>

### Alternative: enable per-repository

If you only want to monitor a handful of repos and don't want to flip the org-level switch:

1. Open the repo, then **Settings → Code security and analysis**.
2. Turn on **Dependency graph**.
3. Turn on **Dependabot alerts**.

Give GitHub a few minutes to run the first scan before invoking `sws sync` — otherwise the run will look empty.

GitHub's full guide: <https://docs.github.com/en/code-security/dependabot/dependabot-alerts/configuring-dependabot-alerts>

## Quickstart

### Step 1 — Asana credentials

Create a Personal Access Token at https://developers.asana.com/docs/personal-access-token. The token is the only thing bootstrap needs in the common case — if the token has access to exactly one workspace it gets auto-detected.

If you belong to multiple Asana workspaces, the bootstrap command will print all of them with their GIDs and ask you to pick one by setting `ASANA_WORKSPACE_GID`.

### Step 2 — GitHub credentials

Create a GitHub PAT (classic) with the `security_events` scope (required for private repository Dependabot alerts) plus `public_repo` if you also need alerts from public repos. For org-level access, the token must be authorized for the organization. See https://docs.github.com/en/rest/dependabot/alerts for the required permissions.

### Step 3 — Bootstrap the Asana project

Run bootstrap once to create the project with the required sections and custom fields:

```bash
docker run --rm \
  -e ASANA_ACCESS_TOKEN=... \
  marcomoauro/security-workflow-sync:latest bootstrap
```

(If you have multiple workspaces, add `-e ASANA_WORKSPACE_GID=...` to pick one.)

The command prints the new `ASANA_PROJECT_GID`. Copy it for the next step.

### Step 4 — Run the first sync

```bash
docker run --rm \
  -e GITHUB_TOKEN=... \
  -e GITHUB_ORG=... \
  -e ASANA_ACCESS_TOKEN=... \
  -e ASANA_PROJECT_GID=... \
  marcomoauro/security-workflow-sync:latest sync
```

## Filtering repositories

By default, every Dependabot alert in the GitHub organization is synced. To scope a run:

```bash
# Only sync alerts from these two repos:
docker run --rm <env vars> marcomoauro/security-workflow-sync:latest sync \
  --include-repos acme/web-app,acme/billing-service

# Skip a noisy archived repo:
docker run --rm <env vars> marcomoauro/security-workflow-sync:latest sync \
  --exclude-repos acme/archived-thing

# Combine: include first, exclude second
docker run --rm <env vars> marcomoauro/security-workflow-sync:latest sync \
  --include-repos acme/web-app,acme/billing-service \
  --exclude-repos acme/web-app
# → effectively syncs only acme/billing-service
```

Matching is **exact** on `owner/repo` (no globs, no regex). Tasks already in Asana for repos that the filter excludes are **left untouched** — the filter scopes one run, it does not purge state. If you want to permanently remove a repo, delete its tasks manually in Asana.

**Performance note:** when `--include-repos` is set, the tool fetches alerts from each repo individually via the repo-level Dependabot API, instead of paginating the entire organization. For a single repo this turns a ~60-second org-wide fetch into a few hundred milliseconds. `--exclude-repos` still requires the full org-level fetch (we can't know what to skip without seeing it all).

## How team assignment works

When the sync encounters a repository it has not seen before, it creates a placeholder task in the **Team Assignment** section with the Repository custom field set to that repo's name. You then manually set the **Tech Team** enum field on that placeholder in Asana.

From the next sync onward, every alert for that repository inherits the team value from the placeholder. The team field is append-only: if you later clear it on an individual task, the next sync restores it from the placeholder — it will never be blanked out by the tool.

**Important:** the append-only invariant means that **changing** the Tech Team on an existing placeholder does **not** retroactively reassign existing vulnerability tasks for that repository. It only affects:
- new vulnerability tasks created from that point onward
- existing vulnerability tasks that did not have a Tech Team set yet

If you need to move a repository's existing alerts to a different team, do it manually in Asana (multi-select + edit the Tech Team field). This is intentional: it prevents the sync tool from silently overwriting decisions a human made directly inside Asana.

## Idempotency and the dedup key

Each finding is identified by a stable deduplication key:

```
sha1("github:<owner/repo>:<package>:<GHSA>").slice(0, 12)
```

This key is stored in a custom field called **Deduplication ID** on every task.

Consequences:

- Running sync twice in a row creates zero new tasks.
- When GitHub reopens an alert (state goes back to `open` after being fixed), the existing task is reopened with a story note rather than a duplicate being created.
- When an alert is fixed or dismissed on GitHub, the corresponding task is closed with a story note explaining the reason.
- The sync is safe to run at any cadence — every 5 minutes, every hour, whatever your team prefers.

## Cron example (GitHub Actions)

```yaml
name: security-workflow-sync
on:
  schedule:
    - cron: '0 * * * *'
  workflow_dispatch:

jobs:
  sync:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: Sync Dependabot to Asana
        run: |
          docker run --rm \
            -e GITHUB_TOKEN=${{ secrets.SWS_GITHUB_TOKEN }} \
            -e GITHUB_ORG=${{ vars.GITHUB_ORG }} \
            -e ASANA_ACCESS_TOKEN=${{ secrets.ASANA_TOKEN }} \
            -e ASANA_PROJECT_GID=${{ vars.ASANA_PROJECT_GID }} \
            marcomoauro/security-workflow-sync:latest sync
```

## What this tool does NOT do

- **It is not a vulnerability scanner.** Dependabot does the scanning; this tool bridges its output into your workflow. If you skip the [Required GitHub setup](#required-github-setup-do-this-first) above, the sync will run successfully and create zero tasks — because there is nothing to read.
- **It does not enable Dependabot for you.** You must flip the GitHub toggles yourself, either per-repo or org-wide.
- **It is not a dashboard.** The dashboard is Asana, where your team already lives.
- **It does not filter by severity.** Every open alert becomes a task. Use Asana's built-in filtering if you want to focus on a specific severity level.

## Roadmap

- Jira destination provider
- Linear destination provider
- GitHub Issues destination provider
- Optional severity-based filtering
- Optional Dynatrace enrichment (runtime exposure overlay)

## Development

```bash
git clone <repo>
cd security-workflow-sync
npm install
npm test
```

The architecture is a stateless reconciliation engine. The core (`src/core/`) speaks only in `SecurityFinding` and a `WorkflowProvider` duck-typed interface — it knows nothing about GitHub or Asana. Providers translate those generic concepts into a specific tool's API.

### How the Asana provider is laid out

All Asana-specific code lives under `src/providers/asana/`. There are four files; each has one job.

```
src/providers/asana/
├── client.js       HTTP layer. Wraps fetch with auth, the {data: ...} envelope,
│                   offset-based pagination, and retries on 5xx / 429 (via
│                   src/core/fetch-retry.js).
│
├── schema.js       Field & section names, display order, the deterministic
│                   colour palette for enum options, and the pickEnumColor()
│                   helper. Pure constants and pure functions, no I/O.
│
├── bootstrap.js    The one-shot setup: resolveWorkspaceGid() (auto-detect
│                   from PAT), ensureCustomField() (idempotent reuse by name),
│                   and bootstrapAsanaProject() (sections + custom fields in
│                   the documented display order).
│
└── provider.js     The implementation of WorkflowProvider:
                    loadContext, listExistingTickets, createTicket,
                    updateTicket, closeTicket, ensureTeamAssignmentTasks.
                    Plus pure renderers buildTaskName / buildTaskNotes
                    (exported so the drift detector can compare strings).
```

The provider is wired into the CLI by `src/commands/sync.js` and `src/commands/bootstrap.js`. Both files import directly from `src/providers/asana/` — when a second provider is added, those two `import` lines become the dispatch point (config decides which provider's factory to call).

### Working on the Asana provider — common changes

| Goal | File | What changes |
|---|---|---|
| Add a new custom field to every task | `schema.js` + `bootstrap.js` + `provider.js` | Add a `FIELD.NAME` constant, an entry in `FIELD_SPECS`, an entry in `FIELD_DISPLAY_ORDER`, then read/write it in `buildCustomFieldsPayload` (create path) and `updateTicket` (update path). |
| Change the notes layout | `provider.js` (`buildTaskNotes`) | Pure function. Tests in `tests/providers/asana/provider.test.js > buildTaskNotes`. The drift detector will auto-update existing tasks on the next sync. |
| Reorder sections or fields on the board | `schema.js` (`SECTION_DISPLAY_ORDER` / `FIELD_DISPLAY_ORDER`) | One-line change. **Note:** Asana doesn't expose an API to reorder resources of an existing project — the new order only applies to projects bootstrapped after the change. |
| Tune the colour palette for new enum options | `schema.js` (`ENUM_OPTION_COLORS`) | Pre-existing options keep their assigned colour; only new ones get the new palette. |
| Change retry behaviour | `src/core/fetch-retry.js` (defaults) or pass `maxRetries` / `baseDelayMs` from `client.js` | The wrapper is provider-agnostic; both Asana and GitHub clients use it. |
| Add a new method to the provider | `provider.js` | Export it on the returned object. The reconcile engine only calls the five methods of `WorkflowProvider`; anything beyond is provider-private (e.g. `ensureTeamAssignmentTasks` is Asana-only and is invoked directly from `sync.js`, not from `reconcile`). |

### Test layout

Tests mirror `src/`. Provider tests use a fake `client` (no HTTP) that returns canned envelope shapes — see `setupContext()` in `tests/providers/asana/provider.test.js` for the canonical mock. The Asana client itself is tested in isolation in `tests/providers/asana/client.test.js` against a mocked `fetchImpl`.

Run a focused file with `npx vitest run tests/providers/asana/provider.test.js`.

## License

MIT.
