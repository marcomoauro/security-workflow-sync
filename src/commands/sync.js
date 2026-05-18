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
