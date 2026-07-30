# Changelog

All notable, user-visible changes. The app shows a one-time notice when the
version changes; details live here.

## 1.1.1 — 2026-07-30

- Fixed: the **first save into a completely empty repository** failed with a
  misleading "busy branch" error (GitHub's git API refuses empty repos). The
  first save now initializes the repository correctly.

## 1.1.0 — 2026-07-06

- **Multiple projects**: one browser can hold several projects (each its own
  data repository and token). Switch via the project button in the top bar;
  add more with "＋ Add project…". Unsaved drafts are kept per project.
- **First-run welcome screen** with step-by-step setup instructions and a
  connection check.
- **Shared project names**: the name set in ⚙ Settings is stored in
  `data/config.yml` and shown to everyone in the project (and in the tab
  title).
- Share links now *add* a project instead of replacing the existing
  connection, and carry the project name.
- Release infrastructure: beta channel at `/beta/`, app versioning with this
  changelog, and a data-format compatibility marker.

## 1.0.2 — 2026-07-06

- Items can be flagged **💬 to discuss** (shown on all pages) — collect the
  talking points for your next meeting.
- Items can have **several responsible people** (toggle chips in the editor).
- Items have a **status**: not started / ⏳ in progress / ✅ done. Done items
  are crossed out, muted, and sort last in the list.

## 1.0.1 — 2026-07-05

- Saving now **pulls and merges** remote changes first (three-way, per
  field), so concurrent edits from several people or devices no longer
  overwrite each other. Tabs also pull when refocused, and two tabs of the
  same browser share their draft.
- "Test connection" performs real read/write permission probes; clearer
  error message when a token can't access the configured repository.

## 1.0.0 — 2026-07-05

- First release: whiteboard, list and timeline over Markdown files in a
  GitHub repository; local drafts; save-as-commit; images in descriptions;
  people and colored tags; share links.
