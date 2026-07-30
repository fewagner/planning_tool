// version.js — single source of truth for the app version and the data-format
// version. See docs/RELEASING.md for when and how to bump these.

// Shown in settings; drives the one-time "what's new" notice after an update.
export const APP_VERSION = '1.1.1';

// Version of the on-disk data format (config.yml `format:` key). Bump ONLY on
// a breaking change to how data files are read/written — see RELEASING.md.
// An app seeing a project with a newer format shows a "please update" banner
// and refuses to save, so it can never downgrade or corrupt newer data.
export const FORMAT_VERSION = 1;

export const CHANGELOG_URL = 'https://github.com/fewagner/planning_tool/blob/main/CHANGELOG.md';
