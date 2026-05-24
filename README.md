# security-workflow-sync

Bring security findings into the workflow tool your engineers already use.

## What it does

security-workflow-sync is a workflow bridge, not a security dashboard. It reads open Dependabot alerts from a GitHub organization and creates or updates corresponding tasks in the workflow tool your team uses. The sync is idempotent — running it twice produces no duplicates — so it is safe to schedule on a cron at any cadence. Team ownership is preserved across alert reopens: once a repo is assigned to a team, that assignment is never overwritten by subsequent syncs.

Destinations currently shipped: **Asana**.
Destinations planned: Jira, Linear, GitHub Issues.

The architecture is provider-agnostic at the core. Each destination plugs in by implementing a small `WorkflowProvider` interface in `src/providers/<name>/`.

---

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

### GitHub PAT

The sync reads Dependabot alerts via the GitHub REST API. Create a classic Personal Access Token with the `security_events` scope (required for private repository Dependabot alerts) plus `public_repo` if you also need alerts from public repos. For org-level access, the token must be authorized for the organization.

Reference: <https://docs.github.com/en/rest/dependabot/alerts>

This token is passed to the sync command via the `GITHUB_TOKEN` env var, alongside `GITHUB_ORG`. Both are required regardless of which destination you choose.

---

## Setup: Asana

The only destination shipped today. When Jira / Linear / GitHub Issues land, each will get its own setup section like this one. You can ignore the others and follow only the one for your tool.

### 1. Asana credentials

Create a Personal Access Token at <https://developers.asana.com/docs/personal-access-token>. The token is the only thing bootstrap needs in the common case — if the token has access to exactly one workspace it gets auto-detected.

If you belong to multiple Asana workspaces, the bootstrap command will print all of them with their GIDs and ask you to pick one by setting `ASANA_WORKSPACE_GID`.

### 2. Bootstrap the Asana project

Run bootstrap once to create the project with the required sections and custom fields:

```bash
docker run --rm --pull always \
  -e ASANA_ACCESS_TOKEN=... \
  marcomoauro/security-workflow-sync:latest bootstrap
```

(If you have multiple workspaces, add `-e ASANA_WORKSPACE_GID=...` to pick one.)

The command prints the new `ASANA_PROJECT_GID`. Copy it for the next step.

### 3. First sync

```bash
docker run --rm --pull always \
  -e GITHUB_TOKEN=... \
  -e GITHUB_ORG=... \
  -e ASANA_ACCESS_TOKEN=... \
  -e ASANA_PROJECT_GID=... \
  marcomoauro/security-workflow-sync:latest sync
```

### 4. Schedule it (GitHub Actions cron)

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
          docker run --rm --pull always \
            -e GITHUB_TOKEN=${{ secrets.SWS_GITHUB_TOKEN }} \
            -e GITHUB_ORG=${{ vars.GITHUB_ORG }} \
            -e ASANA_ACCESS_TOKEN=${{ secrets.ASANA_TOKEN }} \
            -e ASANA_PROJECT_GID=${{ vars.ASANA_PROJECT_GID }} \
            marcomoauro/security-workflow-sync:latest sync
```

### How team assignment works (Asana)

When the sync encounters a repository it has not seen before, it creates a placeholder task in the **Team Assignment** section of the Asana project, with the `SWS: Repository` custom field set to that repo's name. You then manually set the `SWS: Tech Team` enum field on that placeholder in Asana.

From the next sync onward, every alert for that repository inherits the team value from the placeholder. The team field is append-only: if you later clear it on an individual task, the next sync restores it from the placeholder — it will never be blanked out by the tool.

> ⚠️ **The tasks in the Team Assignment section are configuration records, not work items.** They are dummy placeholders the sync uses as a lookup table from repository → team. Treat them like settings, not like actionable tasks:
>
> - **Do not mark them complete.** Asana hides completed tasks from the default board view, so you would lose easy access to them, and a future re-bootstrap could re-create them as a duplicate.
> - **Do not delete them.** Deleting a placeholder loses the Tech Team mapping for that repository; the next sync would re-create it empty and you'd have to re-enter the team.
> - **Do not move them out of the Team Assignment section.** The sync looks them up by section; moving them elsewhere will make the lookup miss and the placeholder will be re-created (now as a duplicate).
>
> The only thing you should ever do on these tasks is set or change the `SWS: Tech Team` enum field. Everything else is automated.

**Important:** the append-only invariant means that **changing** the Tech Team on an existing placeholder does **not** retroactively reassign existing vulnerability tasks for that repository. It only affects:

- new vulnerability tasks created from that point onward
- existing vulnerability tasks that did not have a Tech Team set yet

If you need to move a repository's existing alerts to a different team, do it manually in Asana (multi-select + edit the Tech Team field). This is intentional: it prevents the sync tool from silently overwriting decisions a human made directly inside Asana.

### What the Asana project looks like

The `bootstrap` command produces:

- **Sections** (in this order, top-down on the board): Critical, High, Medium, Low, Team Assignment.
- **Custom fields** (all prefixed `SWS:` so they don't collide with names you may already use in your workspace):
  - `SWS: Severity` (enum: Critical / High / Medium / Low)
  - `SWS: Repository` (enum, grows dynamically as new repos appear)
  - `SWS: Package` (enum, grows dynamically)
  - `SWS: Tech Team` (enum, grows dynamically; you set this manually on placeholders)
  - `SWS: Advisory` (text — the GHSA id)
  - `SWS: Advisory URL` (text)
  - `SWS: Deduplication ID` (text — the stable identity key; **do not edit**)

Custom fields are created at the Asana workspace level. If a field with one of these names already exists (e.g. from a previous bootstrap), it is reused. Enum option colors are deterministic — the same package or repo always gets the same color across runs and projects.

---

## Filtering repositories

By default, every Dependabot alert in the GitHub organization is synced. To scope a run:

```bash
# Only sync alerts from these two repos:
docker run --rm --pull always <env vars> marcomoauro/security-workflow-sync:latest sync \
  --include-repos acme/web-app,acme/billing-service

# Skip a noisy archived repo:
docker run --rm --pull always <env vars> marcomoauro/security-workflow-sync:latest sync \
  --exclude-repos acme/archived-thing

# Combine: include first, exclude second
docker run --rm --pull always <env vars> marcomoauro/security-workflow-sync:latest sync \
  --include-repos acme/web-app,acme/billing-service \
  --exclude-repos acme/web-app
# → effectively syncs only acme/billing-service
```

Matching is **exact** on `owner/repo` (no globs, no regex). Tasks already in the destination for repos that the filter excludes are **left untouched** — the filter scopes one run, it does not purge state. If you want to permanently remove a repo, delete its tasks manually in the destination.

**Performance note:** when `--include-repos` is set, the tool fetches alerts from each repo individually via the repo-level Dependabot API, instead of paginating the entire organization. For a single repo this turns a ~60-second org-wide fetch into a few hundred milliseconds. `--exclude-repos` still requires the full org-level fetch (we can't know what to skip without seeing it all).

---

## Idempotency and the dedup key

These properties hold regardless of which destination you target.

Each finding is identified by a stable deduplication key, computed in the provider-agnostic core:

```
sha1("github:<owner/repo>:<package>:<GHSA>").slice(0, 12)
```

This key is stored on every created task; how it's stored is provider-specific (Asana uses a text custom field called `SWS: Deduplication ID`).

Consequences:

- Running sync twice in a row creates zero new tasks.
- When GitHub reopens an alert (state goes back to `open` after being fixed), the existing task is reopened with a story/comment note rather than a duplicate being created.
- When an alert is fixed or dismissed on GitHub, the corresponding task is closed with a story/comment note explaining the reason.
- When GitHub emits multiple alerts for the same `(repo, package, advisory)` triple — typical when the vuln spans multiple manifests, or after a dismiss-then-reopen — they collapse into a single task with `OPEN` winning over `FIXED`.
- The sync is safe to run at any cadence — every 5 minutes, every hour, whatever your team prefers.

---

## What this tool does NOT do

- **It is not a vulnerability scanner.** Dependabot does the scanning; this tool bridges its output into your workflow. If you skip the [Required GitHub setup](#required-github-setup-do-this-first) above, the sync will run successfully and create zero tasks — because there is nothing to read.
- **It does not enable Dependabot for you.** You must flip the GitHub toggles yourself, either per-repo or org-wide.
- **It is not a dashboard.** The dashboard is your workflow tool, where your team already lives.
- **It does not filter by severity.** Every open alert becomes a task. Use your workflow tool's built-in filtering if you want to focus on a specific severity level.

## Roadmap

- Jira destination provider
- Linear destination provider
- GitHub Issues destination provider
- Optional Dynatrace enrichment (runtime exposure overlay)

## Development

```bash
git clone <repo>
cd security-workflow-sync
npm install
npm test
```

To add a new destination, create `src/providers/<name>/provider.js` implementing the `WorkflowProvider` interface (`loadContext`, `listExistingTickets`, `createTicket`, `updateTicket`, `closeTicket`, plus optional helpers like `ensureTeamAssignmentTasks`). The core in `src/core/` knows nothing about specific destinations.

## License

MIT.
