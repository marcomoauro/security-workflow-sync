import { createGithubClient } from './github-client.js';
import { dedupId, normalizeSeverity } from '../core/finding.js';

// When `includeRepos` is non-empty, fetch alerts per-repo via the repo-level endpoint
// (avoids paginating the entire org just to discard everything but a few repos).
// Otherwise fall back to the org-level endpoint.
export async function fetchDependabotFindings({ org, token, fetchImpl, logger, includeRepos = [] }) {
  const gh = createGithubClient({ token, fetchImpl });
  const findings = [];

  if (includeRepos.length > 0) {
    if (logger) logger.info(`Fetching Dependabot alerts for ${includeRepos.length} included repo(s)…`);
    for (const repoFullName of includeRepos) {
      const [owner, repo] = String(repoFullName).split('/');
      if (!owner || !repo) {
        if (logger) logger.warn(`Skipping malformed repo "${repoFullName}" (expected "owner/repo").`);
        continue;
      }
      const iterator = gh.paginate(
        `/repos/${owner}/${repo}/dependabot/alerts`,
        { per_page: 100 },
        {
          onPage: ({ page, count, hasNext }) => {
            if (!logger) return;
            const more = hasNext ? ', more pages to follow' : ', last page';
            logger.info(`${repoFullName} page ${page}: ${count} alerts${more}.`);
          },
        },
      );
      for await (const alert of iterator) {
        findings.push(toFinding(alert, repoFullName));
      }
    }
    return findings;
  }

  const iterator = gh.paginate(
    `/orgs/${org}/dependabot/alerts`,
    { per_page: 100 },
    {
      onPage: ({ page, count, hasNext }) => {
        if (!logger) return;
        const more = hasNext ? ', more pages to follow' : ', last page';
        logger.info(`Dependabot page ${page}: ${count} alerts${more}.`);
      },
    },
  );
  for await (const alert of iterator) {
    findings.push(toFinding(alert));
  }
  return findings;
}

function toFinding(alert, fallbackRepo = '') {
  const advisory = alert.security_advisory ?? {};
  const vuln = alert.security_vulnerability ?? {};
  const pkg = vuln.package ?? {};
  // Repo-level alerts may omit the `repository` field (it's implied by the URL).
  // Org-level alerts always include it. Fall back to the URL we used to fetch.
  const repository = alert.repository?.full_name ?? fallbackRepo;
  const externalId = advisory.ghsa_id ?? advisory.cve_id ?? `alert-${alert.number}`;
  const packageName = pkg.name ?? 'unknown';
  const advisoryUrl = advisory.ghsa_id
    ? `https://github.com/advisories/${advisory.ghsa_id}`
    : (alert.html_url ?? null);

  const finding = {
    source: 'github',
    externalId,
    repository,
    packageName,
    ecosystem: pkg.ecosystem ?? 'unknown',
    severity: normalizeSeverity(advisory.severity),
    title: advisory.summary ?? `${packageName} ${externalId}`,
    advisoryUrl,
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
