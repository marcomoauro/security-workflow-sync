import { createAsanaClient } from '../providers/asana/client.js';
import { bootstrapAsanaProject } from '../providers/asana/bootstrap.js';

export async function runBootstrap({ config, projectName, teamGid, logger }) {
  const client = createAsanaClient({ token: config.asanaToken });
  const { projectGid } = await bootstrapAsanaProject({
    client,
    workspaceGid: config.asanaWorkspaceGid,
    teamGid,
    projectName: projectName || 'Security Findings',
    logger,
  });

  process.stdout.write([
    '',
    'Bootstrap complete.',
    'Export the following env var when running `sws sync`:',
    '',
    `  ASANA_PROJECT_GID=${projectGid}`,
    '',
    'Next: open the Asana project, then for each repository placeholder in the "Team Assignment" section,',
    'set the "Tech Team" enum field. From then on, new Dependabot alerts for that repository will be',
    'auto-assigned to that team.',
    '',
  ].join('\n'));
}
