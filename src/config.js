export function loadConfig(env = process.env) {
  const required = ['GITHUB_TOKEN', 'GITHUB_ORG', 'ASANA_ACCESS_TOKEN', 'ASANA_PROJECT_GID'];
  const missing = required.filter(k => !env[k]);
  return {
    githubToken: env.GITHUB_TOKEN,
    githubOrg: env.GITHUB_ORG,
    asanaToken: env.ASANA_ACCESS_TOKEN,
    asanaProjectGid: env.ASANA_PROJECT_GID,
    asanaWorkspaceGid: env.ASANA_WORKSPACE_GID, // optional for bootstrap; auto-detected when omitted and the PAT has access to exactly one workspace
    missing,
  };
}

export function assertSyncConfig(cfg) {
  if (cfg.missing.length) throw new Error(`Missing required env vars: ${cfg.missing.join(', ')}`);
}

export function assertBootstrapConfig(cfg) {
  if (!cfg.asanaToken) throw new Error('Missing required env var for bootstrap: ASANA_ACCESS_TOKEN');
}
