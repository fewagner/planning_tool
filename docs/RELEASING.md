# Releasing & compatibility — developer guide

This app is a static site that updates under users' feet, while their data
lives in repositories *they* own and that outlive any app version. This doc
describes how to ship changes without disturbing either.

## Channels

| Channel | Branch | URL | Audience |
|---|---|---|---|
| Production | `main` | `https://<host>/planning_tool/` | everyone |
| Beta | `beta` | `https://<host>/planning_tool/beta/` | you + invited testers |

Both are published by `.github/workflows/pages.yml` (Pages source must be set
to **GitHub Actions** in the repo settings). Every push to `main` or `beta`
redeploys both channels; superseded deploys are cancelled instead of racing.

**Shared storage caveat:** `/` and `/beta/` are the same browser origin, so
they share `localStorage` (projects, tokens, drafts). That is intentional —
beta is tested against real projects — but it means **any change to stored
data must come with a migration and must never break the production app**,
because a user can bounce between channels at any time.

## The release flow

1. Develop on a feature branch (or directly on `beta` for small things).
2. Merge into `beta`, push → test at `/beta/` against a real project.
   Run the smoke checklist (below).
3. Bump `APP_VERSION` in `js/version.js` and add a section to `CHANGELOG.md`
   describing user-visible changes (users see a one-time "updated to vX —
   what's new" notice pointing at the changelog).
4. Merge `beta` into `main`, push, and tag: `git tag vX.Y.Z && git push --tags`.
5. If behavior changed in ways users should hear about beforehand, tell them
   *before* step 4 and point them at `/beta/` to try it.

## Compatibility contract

### 1. Data files are the public API (highest bar)

The files in users' data repos (`data/config.yml`, `data/items/*.md`) must
remain readable and writable across app versions, in both directions where
possible.

- **Only add.** New keys must be optional with safe defaults. Never rename,
  remove, or repurpose an existing key.
- **Tolerate the unknown.** Parsers ignore keys they don't know (they already
  do), so files written by a newer app don't crash an older, cached one.
- **Round-trip byte-stability.** `serialize(parse(file))` must equal the file
  for every file an older version wrote. If a serializer change would rewrite
  untouched files, that's a red flag: it makes every item look "changed" in
  the save badge and produces noisy commits. Precedent: when multi-person
  support landed, `person: Felix` kept serializing exactly as before, with
  `person: [A, B]` only for the new case.
- **Breaking changes need a format bump.** If the format must change
  incompatibly, increment `FORMAT_VERSION` in `js/version.js` and write a
  migration. The `format:` key in `config.yml` marks each project's format.
  An app that meets a *newer* format shows an "update the app" banner and
  refuses to save — so an outdated cached client can never corrupt or
  downgrade newer data. Avoid format bumps if at all possible.

### 2. localStorage

Same origin across channels and releases. Additive changes only; when a shape
changes, migrate the old keys on boot (see `migrateProjects()` in `store.js`
for the pattern: read old key, convert once, keep working from the new key).
Never assume a stored structure without validating it.

### 3. Share links

The `#setup=` payload may only gain optional fields. Old links must keep
working forever — they are printed in chats and inboxes you can't update.

### 4. The merge

`store._mergeIntoDraft` must know about every item/config field, otherwise
concurrent edits to a new field won't merge. When adding a field, add it to
the merge's field list and decide its conflict semantics (default: three-way,
local wins on true conflict, conflict reported).

## Smoke checklist (run on /beta/ before releasing)

- [ ] Fresh browser (or cleared storage): welcome screen → connect flow works.
- [ ] Existing project: data loads; project switcher lists projects.
- [ ] Whiteboard: add via click, drag a card, zoom (wheel + buttons), tray
      drag-out.
- [ ] List: groups per tag, add button, done-items sort last.
- [ ] Timeline: card at deadline, drag to reschedule (date bubble), click-to-
      add with date, tray drag-out, zoom levels.
- [ ] Editor: every field edits through (title, tag, status, people chips,
      deadline + clear, discuss, description with an image paste), delete.
- [ ] Reload mid-edit: draft (including images) survives; Save badge correct.
- [ ] Save: commits; second device/tab pulls the change; concurrent edit
      merges without clobbering.
- [ ] Demo mode unaffected (`?demo=1`).
- [ ] No console errors throughout.

## Versioning quick reference

- `APP_VERSION` (js/version.js): bump on every release; drives the
  what's-new notice. Semver-ish: patch = fixes, minor = features,
  major = big behavior changes.
- `FORMAT_VERSION`: bump only on breaking data-format changes (rare, avoid).
- `CHANGELOG.md`: user-facing language, newest first.
