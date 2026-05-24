import { createAsanaClient } from '../providers/asana/client.js';
import { bootstrapAsanaProject, resolveWorkspaceGid } from '../providers/asana/bootstrap.js';

export async function runBootstrap({ config, projectName, teamGid, logger }) {
  const client = createAsanaClient({ token: config.asanaToken, logger });

  const workspaceGid = config.asanaWorkspaceGid
    || await resolveWorkspaceGid({ client, logger });

  const { projectGid } = await bootstrapAsanaProject({
    client,
    workspaceGid,
    teamGid,
    projectName: projectName || 'Security Findings',
    logger,
  });

  process.stdout.write([
    '',
    'Bootstrap complete. The Asana project, sections, and custom fields are ready.',
    '',
    'Export the following env var when running `sws sync`:',
    '',
    `  ASANA_PROJECT_GID=${projectGid}`,
    '',
    'Next steps:',
    '  1. Run `sws sync` to pull current Dependabot alerts into the project.',
    '     The first sync also creates one placeholder task in the "Team Assignment"',
    '     section for each repository it encounters.',
    '  2. After that first sync, open the Asana project and set the',
    '     "SWS: Tech Team" field on each placeholder.',
    '  3. From the next sync onward, every alert for that repository will',
    '     inherit the team automatically.',
    '',
  ].join('\n'));
}
