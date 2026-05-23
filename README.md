# security-workflow-sync

Bring security findings into the workflow tool your engineers already use.

## What it does

security-workflow-sync is a workflow bridge, not a security dashboard. It reads open Dependabot alerts from a GitHub organization and creates or updates corresponding tasks in Asana. The sync is idempotent — running it twice produces no duplicates — so it is safe to schedule on a cron at any cadence. Team ownership is preserved across alert reopens: once a repo is assigned to a team, that assignment is never overwritten by subsequent syncs.

Current integration matrix:

| Source | Destination |
|--------|-------------|
| GitHub Dependabot (org-level) | Asana |
| _(Jira, Linear, GitHub Issues coming later)_ | |

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

- **It is not a vulnerability scanner.** Dependabot does the scanning; this tool bridges its output into your workflow.
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

The architecture is a stateless reconciliation engine. The core domain (`src/core/`) knows nothing about Asana or GitHub — it speaks only in `SecurityFinding` and the `WorkflowProvider` duck-typed interface. To add a new destination (Jira, Linear, etc.), implement the five methods of that interface in `src/providers/<name>/provider.js`.

## License

MIT.
