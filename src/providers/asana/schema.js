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
