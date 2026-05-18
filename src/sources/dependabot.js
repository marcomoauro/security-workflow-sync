import { createGithubClient } from './github-client.js';
import { dedupId, normalizeSeverity } from '../core/finding.js';

export async function fetchDependabotFindings({ org, token, fetchImpl }) {
  const gh = createGithubClient({ token, fetchImpl });
  const findings = [];
  for await (const alert of gh.paginate(`/orgs/${org}/dependabot/alerts`, { per_page: 100 })) {
    findings.push(toFinding(alert));
  }
  return findings;
}

function toFinding(alert) {
  const advisory = alert.security_advisory ?? {};
  const vuln = alert.security_vulnerability ?? {};
  const pkg = vuln.package ?? {};
  const repository = alert.repository?.full_name ?? '';
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
