import { parseArgs } from 'node:util';
import { loadConfig, assertSyncConfig, assertBootstrapConfig } from './config.js';
import { createLogger } from './core/logger.js';
import { runSync } from './commands/sync.js';
import { runBootstrap } from './commands/bootstrap.js';

const HELP = `
sws — security-workflow-sync

Usage:
  sws sync [--include-repos owner/r1,owner/r2] [--exclude-repos owner/r3]
                              Sync Dependabot alerts → Asana
  sws bootstrap [--name N]    Create the Asana project (sections + custom fields)
  sws --help

Env (sync):
  GITHUB_TOKEN           PAT with security_events scope at org level
  GITHUB_ORG             GitHub org slug
  ASANA_ACCESS_TOKEN     Personal access token
  ASANA_PROJECT_GID      Target project (printed by 'sws bootstrap')

Env (bootstrap):
  ASANA_ACCESS_TOKEN
  ASANA_WORKSPACE_GID    (optional) Target workspace. Auto-detected when the
                         PAT has access to exactly one workspace.
  ASANA_TEAM_GID         (optional) The Asana team to place the project under

Flags:
  --quiet                            Suppress info logs
  --name <string>                    (bootstrap only) Project name
                                     (default: "Security Findings")
  --include-repos <csv>              (sync only) Comma-separated list of
                                     owner/repo names to include. If set, only
                                     alerts from these repos are processed.
                                     Can be repeated; values accumulate.
  --exclude-repos <csv>              (sync only) Comma-separated list of
                                     owner/repo names to skip. Applied after
                                     --include-repos. Can be repeated.

Note: tasks already in Asana for repos that the filter excludes are left
untouched (not closed, not reopened). The filter scopes one run; it does not
purge state.
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
      'include-repos': { type: 'string', multiple: true },
      'exclude-repos': { type: 'string', multiple: true },
    },
    allowPositionals: true,
  });
  const logger = createLogger({ quiet: !!values.quiet });
  const config = loadConfig();

  if (command === 'sync') {
    assertSyncConfig(config);
    await runSync({
      config,
      logger,
      includeRepos: parseCsvList(values['include-repos']),
      excludeRepos: parseCsvList(values['exclude-repos']),
    });
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

// Parse one or more --flag occurrences whose values may themselves be comma-separated.
// `--include-repos a,b --include-repos c` → ['a', 'b', 'c']. Empty input → [].
function parseCsvList(input) {
  if (!input) return [];
  const items = Array.isArray(input) ? input : [input];
  return items
    .flatMap(s => String(s).split(','))
    .map(s => s.trim())
    .filter(Boolean);
}
