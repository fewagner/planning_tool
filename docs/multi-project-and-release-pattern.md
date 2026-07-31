# Pattern: multi-project storage & release channels for a static GitHub-backed app

Companion to `private-data-public-app-pattern.md` (which covers the core:
public app repo + private data repos + token-as-login + three-way merge).
This document covers two additional mechanisms, written as a handoff for an
agent building another app on the same ideology (the domain — project
planning, cabling documentation, anything — is irrelevant to both patterns).
Working reference: <https://github.com/fewagner/planning_tool> — read
`js/store.js` (projects + storage keys), `js/projects.js` (all the UI),
`js/app.js` (share-link import, what's-new), `js/version.js`,
`.github/workflows/pages.yml`, `docs/RELEASING.md`.

---

## Part A — Several projects in one browser

### A1. Storage model (the heart of it)

Two small global keys plus a naming convention:

```
<prefix>:projects   [ {id, name, owner, repo, branch, token}, … ]
<prefix>:active     id of the active project
```

- `id` is a short random slug minted once (`'p-' + random`), never derived
  from the repo (repos can be renamed).
- **The convention that makes everything work:** every piece of per-project
  state — the cache of remote data, the unsaved draft, per-view state — is
  stored under keys namespaced by the *repo coordinates*, e.g.
  `<prefix>:{owner}/{repo}#{branch}:draft`. Do this from day one even with
  single-project support. Multi-project then costs almost nothing: switching
  projects cannot lose unsaved work, because each project's draft already
  lives under its own key.
- In the store, `settings` is an **alias to the active project's entry**
  (same object reference from the array). All single-project code (API
  client construction, key computation) keeps working untouched; "persist
  settings" just means writing the projects array back to localStorage.

⚠️ **Critical for a second app on the same domain:** localStorage is
per-*origin*, and all paths on one Pages domain share one origin. If the
planner uses prefix `pt:` at `example.com/planning_tool/`, a cabling app at
`example.com/cabling/` sees the *same* storage — it MUST use its own prefix
(e.g. `cab:`) or the two apps will corrupt each other's state.

### A2. Switching

`switchProject(id)` = write `<prefix>:active`, then **full page reload**.
Do not try to swap state in place: a static app reboots in milliseconds, and
a reload guarantees no stale module-level state (pan/zoom, open editors,
subscriptions). One subtlety: strip query parameters when switching
(`location.href = location.pathname + location.hash`) so modes like
`?demo=1` don't stick.

### A3. Migration from single-project storage

On boot, if `<prefix>:projects` is missing, wrap the legacy single-settings
object as project #1 (token included) and set it active. Two rules learned
the hard way:

- Run the migration in **every** code path that touches the projects list
  before the store boots — in our case the share-link importer runs first;
  if it had created the projects key naively, the migration would have been
  skipped and the user's legacy project silently dropped.
- Keep the legacy key around (harmless) rather than deleting it eagerly.

### A4. Share links add projects

The invite link is `#setup=<base64url(JSON)>` with
`{owner, repo, branch, token, name}` (fragment ⇒ never sent to any server).
Importing **upserts**: match an existing entry on owner+repo+branch — update
its token/name — else append; then set active and clean the URL with
`history.replaceState`. Never *replace* the list: early versions overwrote
the single connection, which would delete the recipient's other projects.
Payload evolution is additive-only (old links live forever in chat logs).

### A5. UI inventory

- **Project button** in the top bar (replaces a static repo label): shows
  the display name + `▾`, mirrors the name into `document.title`.
- **Dropdown menu**: one row per project (name, repo in small print, ✓ on
  the active one), separator, `＋ Add project…`.
- **Add-project modal**: the onboarding steps (create data repo → create
  fine-grained token → connect) with direct GitHub links, then a form
  (name / owner / repo / branch / token) and a **live verification** before
  adding — call the repo endpoint; on 404 without a token, say "if it is
  private, the token is needed to see it". Only add + reload on success.
- **Welcome screen** when zero projects are configured (and not in demo
  mode): pitch, "connect your project", "try the demo", the same steps, and
  a note that opening a share link sets everything up automatically. This IS
  the onboarding — no README required.
- **Settings**: list of projects with *switch to* / *remove* (remove =
  forget the connection and token in this browser; say explicitly that the
  repository and data stay untouched), plus a rename field.
- **Display name resolution**: name stored in the data repo's config (all
  members see it; merge it three-way like any shared field) → local
  project name → `owner/repo`. The shared name is a small thing that makes
  it feel like a product.
- Do **not** auto-detect owner/repo from the page URL — it "detects" the
  app's own repo and points new users at the wrong place.

---

## Part B — Production/beta channels, versioning, changelog

### B1. Two channels from one workflow

```
main branch  →  https://<host>/<app>/          (production)
beta branch  →  https://<host>/<app>/beta/     (test channel)
```

One GitHub Actions workflow (`.github/workflows/pages.yml`, ~60 lines —
copy it from the reference repo) does, on push to either branch:

- `concurrency: { group: pages, cancel-in-progress: true }` — superseded
  deploys are cancelled instead of racing (branch-based Pages deploys race
  and produce spurious "Deployment failed, try again later" failures).
- A build job checks out **both** branches (`continue-on-error: true` on
  the beta checkout so the workflow works before the branch exists),
  assembles one artifact — main at the root, beta under `/beta/` — strips
  `.github/`, adds `.nojekyll`.
- A deploy job publishes the artifact with `actions/deploy-pages`.

Both channels therefore redeploy on every push to either branch, always
from the current branch heads.

**Setup gotchas (all hit in practice):**

1. Repo *Settings → Pages → Source* must be switched to **GitHub Actions**,
   or the deploy step fails while the legacy branch-deploy keeps running.
2. The auto-created `github-pages` **environment** only permits the default
   branch. Beta-triggered runs then fail with a deploy job that has *no
   steps at all* (rejected before starting). Fix once: *Settings →
   Environments → github-pages → Deployment branches and tags → add `beta`*.
3. Ordering trap until (2) is done: pushing `beta` right after `main`
   cancels the main-triggered run (concurrency) and then fails itself —
   nothing deploys. Recover with an empty commit on `main`.

### B2. The shared-origin caveat, again

`/` and `/beta/` share localStorage. That's a feature — testers run beta
against their real projects — but it means every storage-shape change ships
with a migration, and production must tolerate whatever beta wrote.
Additive-only, validate on read.

### B3. Versioning machinery

A single `js/version.js`:

```js
export const APP_VERSION   = '1.2.0';  // bump every release
export const FORMAT_VERSION = 1;       // bump only on breaking data-format changes
export const CHANGELOG_URL  = 'https://github.com/<owner>/<app>/blob/main/CHANGELOG.md';
```

- **What's-new notice**: at boot compare `<prefix>:version` in localStorage
  with `APP_VERSION`. If a *different* version was stored, show a one-time
  clickable toast ("Updated to vX — tap to see what's new") linking to the
  changelog; always store the current version. No toast on a first-ever
  visit. This is the honest notification channel for an app that updates
  under users' feet; for changes users should hear about *beforehand*,
  point them at `/beta/` first.
- **Format marker**: the data config carries `format: N`. An app that
  encounters a project with a newer format shows a "reload to update the
  app" banner and **refuses to save** — a stale cached client can never
  downgrade or corrupt newer data. Keep `FORMAT_VERSION` at 1 as long as
  humanly possible (additive format changes don't need a bump).
- `CHANGELOG.md`: user-facing language, newest first; the version footer in
  settings links to it.

### B4. Release flow

1. Develop on a feature branch (or `beta` directly for small things).
2. Push to `beta` → test at `/beta/` against a real project; run the smoke
   checklist (keep one in `docs/RELEASING.md`; ours covers every view,
   editing, drafts surviving reload, save/merge, demo mode, console clean).
3. Bump `APP_VERSION`, add the changelog section.
4. Merge/push to `main`, tag `vX.Y.Z`.
5. Hotfixes: fix on `main` first, then sync `beta` (`git push origin
   main:beta`) — remember gotcha B1.3 about push order.

### B5. Compatibility contract (short form)

Data files in user repos are the public API: only add optional keys, ignore
unknown keys when parsing, keep `serialize(parse(file))` byte-identical for
files older versions wrote (otherwise every file looks "modified" and
commits get noisy), and teach the three-way merge every new field the
moment it is introduced. Full version in `docs/RELEASING.md`.

---

## Bootstrap checklist for the new app

- [ ] Pick a unique localStorage prefix (NOT `pt:`) — same-origin apps
      share storage.
- [ ] Namespace all per-project state by `owner/repo#branch` from day one.
- [ ] Projects list + active pointer + settings-as-alias; switch = reload.
- [ ] Welcome screen, add-project modal with live verification, project
      switcher menu, settings project list.
- [ ] Share-link import with upsert semantics.
- [ ] Copy `pages.yml`; switch Pages source to GitHub Actions; add `beta`
      to the github-pages environment's allowed branches; create the beta
      branch.
- [ ] `version.js` + `CHANGELOG.md` + what's-new toast + `format:` marker.
- [ ] Write the app's own `RELEASING.md` with a smoke checklist.
