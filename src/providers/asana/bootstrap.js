import { FIELD, SECTION_BY_SEVERITY, SECTION_TEAM_ASSIGNMENT, SEVERITY_ENUM_OPTIONS } from './schema.js';

export async function resolveWorkspaceGid({ client, logger }) {
  const me = await client.request('GET', '/users/me');
  const workspaces = me?.workspaces ?? [];

  if (workspaces.length === 0) {
    throw new Error('The provided Asana access token has no workspaces. Check the token and try again.');
  }

  if (workspaces.length === 1) {
    const [w] = workspaces;
    logger.info(`Auto-detected Asana workspace: ${w.name} (${w.gid}).`);
    return w.gid;
  }

  const list = workspaces.map(w => `  - ${w.name}: ${w.gid}`).join('\n');
  throw new Error(
    `Multiple Asana workspaces detected. Set ASANA_WORKSPACE_GID to one of:\n${list}`
  );
}

export async function bootstrapAsanaProject({ client, workspaceGid, teamGid, projectName, logger }) {
  logger.info(`Creating Asana project "${projectName}" in workspace ${workspaceGid}…`);

  const projectBody = { name: projectName, workspace: workspaceGid, default_view: 'board' };
  if (teamGid) projectBody.team = teamGid;
  const project = await client.request('POST', '/projects', projectBody);
  logger.info(`Created project ${project.gid}.`);

  // 1. Sections (Asana auto-creates a default "Untitled section" we leave alone)
  const sectionsToCreate = [SECTION_TEAM_ASSIGNMENT, ...Object.values(SECTION_BY_SEVERITY)];
  for (const name of sectionsToCreate) {
    await client.request('POST', `/projects/${project.gid}/sections`, { name });
    logger.info(`Created section "${name}".`);
  }

  // 2. Custom fields
  const textFields = [FIELD.DEDUP, FIELD.ADVISORY, FIELD.ADVISORY_URL];
  for (const name of textFields) {
    const field = await client.request('POST', '/custom_fields', {
      workspace: workspaceGid,
      resource_subtype: 'text',
      name,
    });
    await client.request('POST', `/projects/${project.gid}/addCustomFieldSetting`, {
      custom_field: field.gid,
    });
    logger.info(`Created text custom field "${name}" (${field.gid}).`);
  }

  // Severity enum: pre-populated
  const severity = await client.request('POST', '/custom_fields', {
    workspace: workspaceGid,
    resource_subtype: 'enum',
    name: FIELD.SEVERITY,
    enum_options: SEVERITY_ENUM_OPTIONS,
  });
  await client.request('POST', `/projects/${project.gid}/addCustomFieldSetting`, { custom_field: severity.gid });
  logger.info(`Created enum custom field "${FIELD.SEVERITY}".`);

  // Repository / Package / Tech Team: empty enums, options grow at sync time
  for (const name of [FIELD.REPOSITORY, FIELD.PACKAGE, FIELD.TECH_TEAM]) {
    const field = await client.request('POST', '/custom_fields', {
      workspace: workspaceGid,
      resource_subtype: 'enum',
      name,
      enum_options: [],
    });
    await client.request('POST', `/projects/${project.gid}/addCustomFieldSetting`, { custom_field: field.gid });
    logger.info(`Created enum custom field "${name}".`);
  }

  return { projectGid: project.gid };
}
