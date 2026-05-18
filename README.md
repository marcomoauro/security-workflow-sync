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

Create a Personal Access Token at https://developers.asana.com/docs/personal-access-token.

Find your `ASANA_WORKSPACE_GID` by opening Asana in a browser and navigating to any project. The workspace GID appears in the URL:
```
https://app.asana.com/0/<workspace_gid>/...
```

### Step 2 — GitHub credentials

Create a GitHub Personal Access Token (classic) with `read:org` and `repo` scopes. The token must be granted at the org level so it can read org-wide Dependabot alerts. See https://docs.github.com/en/rest/dependabot/alerts for the required permissions.

### Step 3 — Bootstrap the Asana project

Run bootstrap once to create the project with the required sections and custom fields:

```bash
docker run --rm \
  -e ASANA_ACCESS_TOKEN=... \
  -e ASANA_WORKSPACE_GID=... \
  ghcr.io/<your-org>/security-workflow-sync:latest bootstrap
```

The command prints the new `ASANA_PROJECT_GID`. Copy it for the next step.

### Step 4 — Run the first sync

```bash
docker run --rm \
  -e GITHUB_TOKEN=... \
  -e GITHUB_ORG=... \
  -e ASANA_ACCESS_TOKEN=... \
  -e ASANA_PROJECT_GID=... \
  ghcr.io/<your-org>/security-workflow-sync:latest sync
```

## How team assignment works

When the sync encounters a repository it has not seen before, it creates a placeholder task in the **Team Assignment** section with the Repository custom field set to that repo's name. You then manually set the **Tech Team** enum field on that placeholder in Asana.

From the next sync onward, every alert for that repository inherits the team value from the placeholder. The team field is append-only: if you later clear it on an individual task, the next sync restores it from the placeholder — it will never be blanked out by the tool.

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
            ghcr.io/<your-org>/security-workflow-sync:latest sync
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
