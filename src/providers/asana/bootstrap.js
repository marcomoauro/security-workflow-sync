import { FIELD, SEVERITY_ENUM_OPTIONS, FIELD_DISPLAY_ORDER, SECTION_DISPLAY_ORDER } from './schema.js';

// One spec per logical field. The bootstrap iterates FIELD_DISPLAY_ORDER (not this map's
// key order) so the visual order in Asana is decoupled from this dictionary.
const FIELD_SPECS = {
  [FIELD.DEDUP]: { resource_subtype: 'text' },
  [FIELD.ADVISORY]: { resource_subtype: 'text' },
  [FIELD.ADVISORY_URL]: { resource_subtype: 'text' },
  [FIELD.SEVERITY]: { resource_subtype: 'enum', enum_options: SEVERITY_ENUM_OPTIONS },
  [FIELD.REPOSITORY]: { resource_subtype: 'enum', enum_options: [{ name: '—', color: 'cool-gray' }] },
  [FIELD.PACKAGE]: { resource_subtype: 'enum', enum_options: [{ name: '—', color: 'cool-gray' }] },
  [FIELD.TECH_TEAM]: { resource_subtype: 'enum', enum_options: [{ name: '—', color: 'cool-gray' }] },
};

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

// Asana custom fields live at workspace scope and their names must be unique within the workspace.
// We look up by name first and reuse the existing field if present, so re-running bootstrap
// after a partial failure (or just a second time) doesn't crash on "duplicate name".
async function findCustomFieldByName({ client, workspaceGid, name }) {
  for await (const field of client.paginate(`/workspaces/${workspaceGid}/custom_fields`, {
    opt_fields: 'gid,name,resource_subtype',
  })) {
    if (field.name === name) return field;
  }
  return null;
}

export async function ensureCustomField({ client, workspaceGid, projectGid, name, body, logger }) {
  const existing = await findCustomFieldByName({ client, workspaceGid, name });
  let fieldGid;
  if (existing) {
    if (body.resource_subtype && existing.resource_subtype && existing.resource_subtype !== body.resource_subtype) {
      throw new Error(
        `Cannot reuse existing Asana custom field "${name}" (gid ${existing.gid}): ` +
        `expected type "${body.resource_subtype}", found "${existing.resource_subtype}". ` +
        `Rename or delete the conflicting field in your Asana workspace and re-run bootstrap. ` +
        `(Tip: this tool prefixes its field names with "SWS:" — if you see a SWS-prefixed field of the wrong type, it's leftover from a previous version.)`
      );
    }
    fieldGid = existing.gid;
    logger.info(`Reusing existing custom field "${name}" (${fieldGid}).`);
  } else {
    const created = await client.request('POST', '/custom_fields', {
      workspace: workspaceGid,
      name,
      ...body,
    });
    fieldGid = created.gid;
    logger.info(`Created custom field "${name}" (${fieldGid}).`);
  }

  try {
    await client.request('POST', `/projects/${projectGid}/addCustomFieldSetting`, { custom_field: fieldGid });
  } catch (err) {
    // addCustomFieldSetting is idempotent in spirit but Asana may 400 if the field is already
    // attached to the project. Swallow that specific case; rethrow anything else.
    if (!/already/i.test(err.message)) throw err;
    logger.info(`Custom field "${name}" was already attached to project ${projectGid}.`);
  }
  return fieldGid;
}

export async function bootstrapAsanaProject({ client, workspaceGid, teamGid, projectName, logger }) {
  logger.info(`Creating Asana project "${projectName}" in workspace ${workspaceGid}…`);

  const projectBody = { name: projectName, workspace: workspaceGid, default_view: 'board' };
  if (teamGid) projectBody.team = teamGid;
  const project = await client.request('POST', '/projects', projectBody);
  logger.info(`Created project ${project.gid}.`);

  // 1. Sections — created in SECTION_DISPLAY_ORDER (most-urgent severities first,
  // Team Assignment last). Asana shows sections in creation order on the board view.
  // (Asana auto-creates a default "Untitled section" on every new project; we leave it.)
  for (const name of SECTION_DISPLAY_ORDER) {
    await client.request('POST', `/projects/${project.gid}/sections`, { name });
    logger.info(`Created section "${name}".`);
  }

  // 2. Custom fields — iterated in FIELD_DISPLAY_ORDER (actionable info first,
  // identifiers last). Asana shows fields in the order they were added to the project.
  // Reuse workspace-level fields when present (idempotent on re-bootstrap).
  // Repository / Package / Tech Team are seeded with a single placeholder option
  // because Asana rejects enum custom fields with 0 options; real options are added
  // lazily by the sync command's ensureEnumOption() as new repos/packages appear.
  for (const name of FIELD_DISPLAY_ORDER) {
    await ensureCustomField({
      client, workspaceGid, projectGid: project.gid, name, logger,
      body: FIELD_SPECS[name],
    });
  }

  return { projectGid: project.gid };
}
