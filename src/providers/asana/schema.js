import { createHash } from 'node:crypto';

export const SECTION_TEAM_ASSIGNMENT = 'Team Assignment';

export const SECTION_BY_SEVERITY = {
  CRITICAL: 'Critical',
  HIGH: 'High',
  MEDIUM: 'Medium',
  LOW: 'Low',
};

// Field names are prefixed with "SWS:" so they don't collide with generically-named
// fields that may already exist in the user's Asana workspace ("Package", "Repository",
// etc.). Custom fields are workspace-scoped in Asana and names must be unique.
export const FIELD = {
  DEDUP: 'SWS: Deduplication ID',
  SEVERITY: 'SWS: Severity',
  REPOSITORY: 'SWS: Repository',
  PACKAGE: 'SWS: Package',
  ADVISORY: 'SWS: Advisory',
  ADVISORY_URL: 'SWS: Advisory URL',
  TECH_TEAM: 'SWS: Tech Team',
};

export const SEVERITY_ENUM_OPTIONS = [
  { name: 'Critical', color: 'red' },
  { name: 'High', color: 'orange' },
  { name: 'Medium', color: 'yellow' },
  { name: 'Low', color: 'cool-gray' },
];

export const SEVERITY_TO_OPTION_NAME = {
  CRITICAL: 'Critical',
  HIGH: 'High',
  MEDIUM: 'Medium',
  LOW: 'Low',
};

// Palette used by ensureEnumOption() to assign a deterministic color to every dynamic
// enum option (Repository / Package / Tech Team). Excludes grays — those are reserved
// for placeholder/unknown values. Order matters: changing it would shuffle colors for
// every existing option on the next sync.
export const ENUM_OPTION_COLORS = [
  'red', 'orange', 'yellow-orange', 'yellow', 'yellow-green',
  'green', 'blue-green', 'aqua', 'blue', 'indigo',
  'purple', 'magenta', 'hot-pink', 'pink',
];

// Display order of custom fields on the project. The first entry shows leftmost in
// board cards and topmost in task detail. Actionable / triage info first, IDs last.
export const FIELD_DISPLAY_ORDER = [
  FIELD.SEVERITY,
  FIELD.REPOSITORY,
  FIELD.PACKAGE,
  FIELD.TECH_TEAM,
  FIELD.ADVISORY,
  FIELD.ADVISORY_URL,
  FIELD.DEDUP,
];

// Display order of sections in the project. Most urgent first; the admin-only
// "Team Assignment" lives at the bottom.
export const SECTION_DISPLAY_ORDER = [
  SECTION_BY_SEVERITY.CRITICAL,
  SECTION_BY_SEVERITY.HIGH,
  SECTION_BY_SEVERITY.MEDIUM,
  SECTION_BY_SEVERITY.LOW,
  SECTION_TEAM_ASSIGNMENT,
];

// Pick a deterministic color from ENUM_OPTION_COLORS based on a name.
// The same name always maps to the same color across runs and workspaces.
export function pickEnumColor(name) {
  // Use the first 4 bytes of the SHA1 as an unsigned 32-bit integer index.
  const hash = createHash('sha1').update(String(name).toLowerCase()).digest();
  const idx = hash.readUInt32BE(0) % ENUM_OPTION_COLORS.length;
  return ENUM_OPTION_COLORS[idx];
}
