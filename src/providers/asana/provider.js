import { FIELD, SECTION_BY_SEVERITY, SECTION_TEAM_ASSIGNMENT, SEVERITY_TO_OPTION_NAME } from './schema.js';

export function createAsanaProvider({ client, projectGid, logger }) {
  const ctx = {
    fields: {},         // logical name → { gid, type, options: Map<name, gid> }
    sections: {},       // logical name → gid
    teamMapping: new Map(), // repoName → techTeamGid
  };

  async function loadContext() {
    const settings = await client.request('GET', `/projects/${projectGid}/custom_field_settings`, undefined, {
      query: { opt_fields: 'custom_field.gid,custom_field.name,custom_field.resource_subtype,custom_field.enum_options.gid,custom_field.enum_options.name,custom_field.enum_options.enabled' },
    });
    for (const s of settings ?? []) {
      const cf = s.custom_field ?? s;
      if (!cf?.name) continue;
      const options = new Map();
      for (const o of cf.enum_options ?? []) options.set(o.name, o.gid);
      ctx.fields[cf.name] = { gid: cf.gid, type: cf.resource_subtype, options };
    }
    requireField(FIELD.DEDUP);
    requireField(FIELD.SEVERITY);
    requireField(FIELD.REPOSITORY);
    requireField(FIELD.PACKAGE);
    requireField(FIELD.ADVISORY);
    requireField(FIELD.ADVISORY_URL);
    requireField(FIELD.TECH_TEAM);

    const sections = await client.request('GET', `/projects/${projectGid}/sections`, undefined, {
      query: { opt_fields: 'name,gid' },
    });
    for (const sec of sections ?? []) ctx.sections[sec.name] = sec.gid;
    requireSection(SECTION_TEAM_ASSIGNMENT);
    for (const sev of Object.values(SECTION_BY_SEVERITY)) requireSection(sev);

    await loadTeamMapping();
  }

  async function loadTeamMapping() {
    const teamSectionGid = ctx.sections[SECTION_TEAM_ASSIGNMENT];
    const repoField = ctx.fields[FIELD.REPOSITORY];
    const teamField = ctx.fields[FIELD.TECH_TEAM];

    const it = client.paginate(`/sections/${teamSectionGid}/tasks`, {
      opt_fields: 'name,custom_fields.gid,custom_fields.enum_value.gid,custom_fields.enum_value.name',
    });
    for await (const task of it) {
      const fields = task.custom_fields ?? [];
      const repoOpt = fields.find(f => f.gid === repoField.gid)?.enum_value;
      const teamOpt = fields.find(f => f.gid === teamField.gid)?.enum_value;
      if (repoOpt?.name && teamOpt?.gid) ctx.teamMapping.set(repoOpt.name, teamOpt.gid);
    }
    logger.info(`Loaded team mapping for ${ctx.teamMapping.size} repositories.`);
  }

  async function listExistingTickets() {
    const dedupGid = ctx.fields[FIELD.DEDUP].gid;
    const map = new Map();
    const it = client.paginate(`/projects/${projectGid}/tasks`, {
      opt_fields: 'name,completed,custom_fields.gid,custom_fields.text_value,custom_fields.enum_value.gid,custom_fields.enum_value.name,memberships.section.gid',
    });
    for await (const task of it) {
      const dedup = (task.custom_fields ?? []).find(f => f.gid === dedupGid)?.text_value;
      if (!dedup) continue;
      map.set(dedup, {
        gid: task.gid,
        dedupId: dedup,
        completed: !!task.completed,
        name: task.name,
        customFields: task.custom_fields ?? [],
        sectionGids: (task.memberships ?? []).map(m => m.section?.gid).filter(Boolean),
      });
    }
    return map;
  }

  function requireField(name) {
    if (!ctx.fields[name]) throw new Error(`Asana project ${projectGid} is missing custom field "${name}". Run \`sws bootstrap\` first.`);
  }
  function requireSection(name) {
    if (!ctx.sections[name]) throw new Error(`Asana project ${projectGid} is missing section "${name}". Run \`sws bootstrap\` first.`);
  }

  async function ensureEnumOption(fieldName, optionName) {
    const field = ctx.fields[fieldName];
    if (!field) throw new Error(`Unknown field ${fieldName}`);
    let gid = field.options.get(optionName);
    if (gid) return gid;
    const created = await client.request('POST', `/custom_fields/${field.gid}/enum_options`, { name: optionName });
    gid = created.gid;
    field.options.set(optionName, gid);
    return gid;
  }

  function severityToSectionGid(severity) {
    const sectionName = SECTION_BY_SEVERITY[severity];
    return ctx.sections[sectionName];
  }

  function severityToOptionGid(severity) {
    const optName = SEVERITY_TO_OPTION_NAME[severity];
    return ctx.fields[FIELD.SEVERITY].options.get(optName);
  }

  function buildTaskName(f) {
    const sev = SEVERITY_TO_OPTION_NAME[f.severity] ?? f.severity;
    return `[${sev}] ${f.packageName} – ${f.repository}`;
  }

  function buildTaskNotes(f) {
    const lines = [
      `Advisory: ${f.externalId}`,
      f.advisoryUrl ? `URL: ${f.advisoryUrl}` : null,
      `Repository: ${f.repository}`,
      `Package: ${f.packageName}${f.ecosystem ? ` (${f.ecosystem})` : ''}`,
      `Severity: ${f.severity}`,
      f.remediation ? `Patched in: ${f.remediation}` : 'No patched version available yet.',
      '',
      f.title || '',
      '',
      '— Managed by security-workflow-sync. Do not change the Deduplication ID.',
    ];
    return lines.filter(l => l !== null).join('\n');
  }

  async function buildCustomFieldsPayload(f) {
    const repoOptGid = await ensureEnumOption(FIELD.REPOSITORY, f.repository);
    const pkgOptGid = await ensureEnumOption(FIELD.PACKAGE, f.packageName);
    const cf = {
      [ctx.fields[FIELD.DEDUP].gid]: f.dedupId,
      [ctx.fields[FIELD.SEVERITY].gid]: severityToOptionGid(f.severity),
      [ctx.fields[FIELD.REPOSITORY].gid]: repoOptGid,
      [ctx.fields[FIELD.PACKAGE].gid]: pkgOptGid,
      [ctx.fields[FIELD.ADVISORY].gid]: f.externalId ?? '',
      [ctx.fields[FIELD.ADVISORY_URL].gid]: f.advisoryUrl ?? '',
    };
    const teamGid = ctx.teamMapping.get(f.repository);
    if (teamGid) cf[ctx.fields[FIELD.TECH_TEAM].gid] = teamGid;
    return cf;
  }

  async function createTicket(finding) {
    const sectionGid = severityToSectionGid(finding.severity);
    const customFields = await buildCustomFieldsPayload(finding);
    await client.request('POST', '/tasks', {
      name: buildTaskName(finding),
      notes: buildTaskNotes(finding),
      projects: [projectGid],
      custom_fields: customFields,
      memberships: [{ project: projectGid, section: sectionGid }],
    });
    return { action: 'created', dedupId: finding.dedupId };
  }

  return {
    loadContext,
    listExistingTickets,
    createTicket,
    // updateTicket, closeTicket, ensureTeamAssignmentTasks — added in subsequent tasks
    _ctx: ctx, // exposed for testing only
  };
}
