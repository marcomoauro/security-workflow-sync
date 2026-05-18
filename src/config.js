export function loadConfig(env = process.env) {
  const required = ['GITHUB_TOKEN', 'GITHUB_ORG', 'ASANA_ACCESS_TOKEN', 'ASANA_PROJECT_GID'];
  const missing = required.filter(k => !env[k]);
  return {
    githubToken: env.GITHUB_TOKEN,
    githubOrg: env.GITHUB_ORG,
    asanaToken: env.ASANA_ACCESS_TOKEN,
    asanaProjectGid: env.ASANA_PROJECT_GID,
    asanaWorkspaceGid: env.ASANA_WORKSPACE_GID, // only required for bootstrap
    missing,
  };
}

export function assertSyncConfig(cfg) {
  if (cfg.missing.length) throw new Error(`Missing required env vars: ${cfg.missing.join(', ')}`);
}

export function assertBootstrapConfig(cfg) {
  const need = ['ASANA_ACCESS_TOKEN', 'ASANA_WORKSPACE_GID'];
  const missing = need.filter(k => {
    if (k === 'ASANA_ACCESS_TOKEN') return !cfg.asanaToken;
    if (k === 'ASANA_WORKSPACE_GID') return !cfg.asanaWorkspaceGid;
    return false;
  });
  if (missing.length) throw new Error(`Missing required env vars for bootstrap: ${missing.join(', ')}`);
}
