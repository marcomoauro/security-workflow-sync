import { FIELD, SECTION_BY_SEVERITY, SECTION_TEAM_ASSIGNMENT, SEVERITY_TO_OPTION_NAME, pickEnumColor } from './schema.js';

// Pure renderers — no closure dependencies on the provider state. Exported so that
// tests can compute the same canonical name/notes the provider will write to Asana,
// and so the drift detector in updateTicket() compares strings against the exact
// values that would be POSTed.
export function buildTaskName(f) {
  const sev = SEVERITY_TO_OPTION_NAME[f.severity] ?? f.severity;
  return `[${sev}] ${f.packageName} – ${f.repository}`;
}

export function buildTaskNotes(f) {
  const manifestsBlock = (f.manifestPaths && f.manifestPaths.length > 0)
    ? `Affected manifests:\n${f.manifestPaths.map(p => `  - ${p}`).join('\n')}`
    : null;
  const lines = [
    `Advisory: ${f.externalId}`,
    f.advisoryUrl ? `URL: ${f.advisoryUrl}` : null,
    `Repository: ${f.repository}`,
    `Package: ${f.packageName}${f.ecosystem ? ` (${f.ecosystem})` : ''}`,
    f.vulnerableVersionRange ? `Vulnerable versions: ${f.vulnerableVersionRange}` : null,
    `Severity: ${f.severity}`,
    f.remediation ? `Patched in: ${f.remediation}` : 'No patched version available yet.',
    manifestsBlock,
    '',
    f.title || '',
    '',
    '— Managed by security-workflow-sync. Do not change the Deduplication ID.',
  ];
  return lines.filter(l => l !== null).join('\n');
}

export function createAsanaProvider({ client, projectGid, logger }) {
  const ctx = {
    fields: {},         // logical name → { gid, type, options: Map<name, gid> }
    sections: {},       // logical name → gid
    teamMapping: new Map(), // repoName → techTeamGid
  };

  async function loadContext() {
    logger.info('Loading Asana project context (custom fields + sections)…');
    const settings = await client.request('GET', `/projects/${projectGid}/custom_field_settings`, undefined, {
      query: { opt_fields: 'custom_field.gid,custom_field.name,custom_field.resource_subtype,custom_field.enum_options.gid,custom_field.enum_options.name,custom_field.enum_options.enabled' },
    });
    for (const s of settings ?? []) {
      const cf = s.custom_field ?? s;
      if (!cf?.name) continue;
      // Asana treats enum option names as unique case-insensitively (the API rejects
      // a new option whose lowercased name equals any existing one). Mirror that here
      // so cache lookups don't miss when the package name's casing differs between
      // findings (e.g. "Werkzeug" vs "werkzeug" in different Dependabot advisories).
      const options = new Map();
      for (const o of cf.enum_options ?? []) {
        if (o?.name && o?.gid) options.set(String(o.name).toLowerCase(), o.gid);
      }
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
    ctx.knownTeamAssignmentRepos = new Set();

    logger.info('Loading existing Team Assignment placeholders…');
    const it = client.paginate(`/sections/${teamSectionGid}/tasks`, {
      opt_fields: 'name,custom_fields.gid,custom_fields.enum_value.gid,custom_fields.enum_value.name',
    }, {
      onPage: ({ page, count, hasNext }) => {
        const more = hasNext ? ', more pages to follow' : ', last page';
        logger.info(`Team Assignment page ${page}: ${count} placeholders${more}.`);
      },
    });
    for await (const task of it) {
      const fields = task.custom_fields ?? [];
      const repoOpt = fields.find(f => f.gid === repoField.gid)?.enum_value;
      const teamOpt = fields.find(f => f.gid === teamField.gid)?.enum_value;
      if (repoOpt?.name) {
        ctx.knownTeamAssignmentRepos.add(repoOpt.name);
        if (teamOpt?.gid) ctx.teamMapping.set(repoOpt.name, teamOpt.gid);
      }
    }
    logger.info(`Loaded ${ctx.knownTeamAssignmentRepos.size} Team Assignment placeholders (${ctx.teamMapping.size} with a Tech Team set).`);
  }

  async function listExistingTickets() {
    const dedupGid = ctx.fields[FIELD.DEDUP].gid;
    const map = new Map();
    logger.info('Loading existing vulnerability tasks from Asana…');
    const it = client.paginate(`/projects/${projectGid}/tasks`, {
      opt_fields: 'name,notes,completed,custom_fields.gid,custom_fields.text_value,custom_fields.enum_value.gid,custom_fields.enum_value.name,memberships.section.gid',
    }, {
      onPage: ({ page, count, hasNext }) => {
        const more = hasNext ? ', more pages to follow' : ', last page';
        logger.info(`Existing tasks page ${page}: ${count} tasks${more}.`);
      },
    });
    for await (const task of it) {
      const dedup = (task.custom_fields ?? []).find(f => f.gid === dedupGid)?.text_value;
      if (!dedup) continue;
      map.set(dedup, {
        gid: task.gid,
        dedupId: dedup,
        completed: !!task.completed,
        name: task.name,
        notes: task.notes ?? '',
        customFields: task.custom_fields ?? [],
        sectionGids: (task.memberships ?? []).map(m => m.section?.gid).filter(Boolean),
      });
    }
    logger.info(`Loaded ${map.size} existing vulnerability tasks (by Deduplication ID).`);
    return map;
  }

  function requireField(name) {
    if (!ctx.fields[name]) throw new Error(`Asana project ${projectGid} is missing custom field "${name}". Run \`sws bootstrap\` first.`);
  }
  function requireSection(name) {
    if (!ctx.sections[name]) throw new Error(`Asana project ${projectGid} is missing section "${name}". Run \`sws bootstrap\` first.`);
  }

  async function refreshFieldOptions(field) {
    const fresh = await client.request('GET', `/custom_fields/${field.gid}`, undefined, {
      query: { opt_fields: 'enum_options.gid,enum_options.name,enum_options.enabled' },
    });
    field.options.clear();
    for (const o of fresh?.enum_options ?? []) {
      if (o?.name && o?.gid) field.options.set(String(o.name).toLowerCase(), o.gid);
    }
  }

  async function ensureEnumOption(fieldName, optionName) {
    const field = ctx.fields[fieldName];
    if (!field) throw new Error(`Unknown field ${fieldName}`);
    const key = String(optionName).toLowerCase();
    let gid = field.options.get(key);
    if (gid) return gid;

    try {
      const created = await client.request('POST', `/custom_fields/${field.gid}/enum_options`, {
        name: optionName,
        color: pickEnumColor(optionName),
      });
      gid = created.gid;
      field.options.set(key, gid);
      return gid;
    } catch (err) {
      // Asana rejects POST if an enum option already exists with the same name (case-insensitive)
      // but our cache somehow missed it (e.g. >500-option fields, manual edits, race conditions).
      // Refresh from the server and use whatever Asana has.
      if (!/duplicate.?name/i.test(err.message)) throw err;
      await refreshFieldOptions(field);
      gid = field.options.get(key);
      if (!gid) {
        throw new Error(
          `Asana rejected enum option "${optionName}" on field ${field.gid} as a duplicate, ` +
          `but no matching option was found after refreshing the field. Original error: ${err.message}`
        );
      }
      return gid;
    }
  }

  function severityToSectionGid(severity) {
    const sectionName = SECTION_BY_SEVERITY[severity];
    return ctx.sections[sectionName];
  }

  function severityToOptionGid(severity) {
    const optName = SEVERITY_TO_OPTION_NAME[severity];
    return ctx.fields[FIELD.SEVERITY].options.get(String(optName).toLowerCase());
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

  async function updateTicket(finding, existing) {
    const newSevGid = severityToOptionGid(finding.severity);
    const newSectionGid = severityToSectionGid(finding.severity);

    const cfMap = new Map();
    for (const cf of existing.customFields ?? []) cfMap.set(cf.gid, cf);

    const currentSevGid = cfMap.get(ctx.fields[FIELD.SEVERITY].gid)?.enum_value?.gid ?? null;
    const currentTeamGid = cfMap.get(ctx.fields[FIELD.TECH_TEAM].gid)?.enum_value?.gid ?? null;
    const currentSectionGid = existing.sectionGids?.[0] ?? null;

    const updates = {};
    const needsReopen = !!existing.completed;
    const needsSeverity = currentSevGid !== newSevGid;
    const mappedTeam = ctx.teamMapping.get(finding.repository) ?? null;
    const needsTeamAssign = !currentTeamGid && !!mappedTeam;
    const needsSectionMove = currentSectionGid !== newSectionGid;

    // Name/notes are cheap and idempotent — refresh them when anything else changes.
    let touchedFields = false;
    const customFields = {};

    if (needsSeverity) { customFields[ctx.fields[FIELD.SEVERITY].gid] = newSevGid; touchedFields = true; }
    if (needsTeamAssign) { customFields[ctx.fields[FIELD.TECH_TEAM].gid] = mappedTeam; touchedFields = true; }

    // Detect notes drift — happens whenever buildTaskNotes() schema changes (new lines,
    // reordering) or after a human-or-bot edited the notes manually. Force a PUT so
    // the task always reflects the canonical content we generate.
    const newName = buildTaskName(finding);
    const newNotes = buildTaskNotes(finding);
    const needsNameRefresh = existing.name !== newName;
    const needsNotesRefresh = (existing.notes ?? '') !== newNotes;

    const willPut = needsReopen || touchedFields || needsNameRefresh || needsNotesRefresh;

    if (willPut) {
      updates.name = newName;
      updates.notes = newNotes;
      if (touchedFields) updates.custom_fields = customFields;
      if (needsReopen) updates.completed = false;
      await client.request('PUT', `/tasks/${existing.gid}`, updates);
    }

    if (needsReopen) {
      await client.request('POST', `/tasks/${existing.gid}/stories`, {
        text: 'Reopened automatically: this Dependabot alert is open again.',
      });
    }

    if (needsSectionMove && newSectionGid) {
      await client.request('POST', `/sections/${newSectionGid}/addTask`, { task: existing.gid });
    }

    if (needsReopen) return { action: 'reopened', dedupId: finding.dedupId };
    if (willPut || needsSectionMove) return { action: 'updated', dedupId: finding.dedupId };
    return { action: 'noop', dedupId: finding.dedupId };
  }

  async function closeTicket(existing) {
    await client.request('PUT', `/tasks/${existing.gid}`, { completed: true });
    await client.request('POST', `/tasks/${existing.gid}/stories`, {
      text: 'Closed automatically: the underlying Dependabot alert is no longer open (fixed or dismissed).',
    });
    return { action: 'closed', dedupId: existing.dedupId };
  }

  async function ensureTeamAssignmentTasks(repositories) {
    const teamSectionGid = ctx.sections[SECTION_TEAM_ASSIGNMENT];
    const repoField = ctx.fields[FIELD.REPOSITORY];
    const missing = repositories.filter(r => !ctx.knownTeamAssignmentRepos?.has(r));
    if (missing.length === 0) {
      logger.info('All repositories already have a Team Assignment placeholder.');
      return;
    }
    logger.info(`Creating ${missing.length} new Team Assignment placeholder(s)…`);
    let created = 0;
    for (const repo of missing) {
      const repoOptGid = await ensureEnumOption(FIELD.REPOSITORY, repo);
      await client.request('POST', '/tasks', {
        name: repo,
        notes: 'Set the Tech Team for this repository. New Dependabot alerts will be auto-assigned to it.',
        projects: [projectGid],
        custom_fields: { [repoField.gid]: repoOptGid },
        memberships: [{ project: projectGid, section: teamSectionGid }],
      });
      ctx.knownTeamAssignmentRepos.add(repo);
      created++;
      logger.info(`Team Assignment placeholder ${created}/${missing.length}: "${repo}".`);
    }
    logger.info(`Created ${created} Team Assignment placeholder task(s).`);
  }

  return {
    loadContext,
    listExistingTickets,
    createTicket,
    updateTicket,
    closeTicket,
    ensureTeamAssignmentTasks,
    _ctx: ctx, // exposed for testing only
  };
}
