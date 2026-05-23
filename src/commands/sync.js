import { fetchDependabotFindings } from '../sources/dependabot.js';
import { reconcile } from '../core/reconcile.js';
import { filterFindings } from '../core/finding.js';
import { createAsanaClient } from '../providers/asana/client.js';
import { createAsanaProvider } from '../providers/asana/provider.js';

export async function runSync({ config, logger, includeRepos = [], excludeRepos = [] }) {
  logger.info(`Fetching Dependabot alerts for org "${config.githubOrg}"…`);
  const fetched = await fetchDependabotFindings({ org: config.githubOrg, token: config.githubToken, logger });
  logger.info(`Fetched ${fetched.length} alerts (${countByState(fetched)}).`);

  const findings = filterFindings(fetched, { include: includeRepos, exclude: excludeRepos });
  if (findings.length !== fetched.length) {
    const includeMsg = includeRepos.length > 0 ? `include=${includeRepos.length}` : null;
    const excludeMsg = excludeRepos.length > 0 ? `exclude=${excludeRepos.length}` : null;
    const filterDesc = [includeMsg, excludeMsg].filter(Boolean).join(', ');
    logger.info(`After repo filter (${filterDesc}): ${findings.length}/${fetched.length} alerts retained.`);
  }

  const client = createAsanaClient({ token: config.asanaToken });
  const provider = createAsanaProvider({ client, projectGid: config.asanaProjectGid, logger });

  await provider.loadContext();

  const uniqueRepos = [...new Set(findings.map(f => f.repository).filter(Boolean))];
  await provider.ensureTeamAssignmentTasks(uniqueRepos);

  // Reload mapping so any *just-created* placeholders the user has since annotated are picked up next run.
  // For this run, placeholders we just created have no team yet — that's expected.

  logger.info(`Reconciling ${findings.length} findings against Asana…`);
  const result = await reconcile(findings, provider, {
    onProgress: ({ processed, total, result: r }) => {
      if (processed === total || processed % 100 === 0) {
        const pct = Math.floor((processed * 100) / Math.max(total, 1));
        logger.info(
          `Reconciling: ${processed}/${total} (${pct}%) — created ${r.created}, updated ${r.updated}, reopened ${r.reopened}, closed ${r.closed}, noop ${r.noop}, skipped ${r.skipped}`
        );
      }
    },
  });

  const summary = {
    fetched: fetched.length,
    filtered: findings.length,
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
