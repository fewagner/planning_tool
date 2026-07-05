# Pattern: public static app on GitHub Pages + private data repo + token as login

This document describes an architecture for building a collaborative browser
tool with **no backend at all**, where the data is nevertheless **private**.
It is written as a handoff for an agent implementing the same pattern in a new
project. A complete working reference implementation is
<https://github.com/fewagner/planning_tool> (app) — read `js/github.js`,
`js/store.js`, `js/settings.js` and `js/app.js` alongside this document.

## 1. The concept

- **Two repositories.**
  - The **app repo** is *public* and contains only generic static code
    (HTML/CSS/JS, no build step). GitHub Pages serves it — public repos get
    Pages on the free plan.
  - The **data repo** is *private* and contains only data files (human-readable
    Markdown/YAML works well: nice diffs, renders on github.com, hand-editable).
- **The browser app talks directly to `api.github.com`** (CORS is open) to
  read and write the data repo. There is no server of your own.
- **A fine-grained personal access token (PAT) is the login.** It is scoped to
  *only* the data repo with *Contents: Read and write*, entered once in the
  app's settings, and stored in `localStorage`. Without a token the app shows
  an empty shell; GitHub itself enforces access — this is real security, not a
  client-side mask.
- **Every "Save" is one git commit** in the data repo → full history, diffs,
  and blame for free.
- **Sharing**: a "copy link" button encodes `{owner, repo, branch, token}` as
  base64url in the URL *fragment* (`#setup=…`). Fragments never reach any
  server. On load, the app imports it into `localStorage` and strips it via
  `history.replaceState`. A share link must be treated exactly like the token.

Trade-offs to state up front: everyone with the token has full read/write (no
per-user permissions); there is no anonymous read-only mode; secrets pasted
into chats/issues are burned and must be revoked.

## 2. Client-side state model

Keep three layers, all in the browser:

1. **`base`** — the data as it exists at a known commit: `{ sha, files }`
   parsed into records. Cache it in `localStorage` keyed by
   `owner/repo#branch`, storing each file's **blob sha + content** so future
   syncs only fetch blobs whose sha changed.
2. **Working copy** — what the UI edits. Persist it to `localStorage` as a
   "draft" on *every* mutation (debounce ~250 ms, plus a `pagehide` flush).
   This is what makes edits survive page switches, reloads, and tab closes.
3. **Fork point** — stored *inside the draft*: the commit sha the draft
   started from **plus a snapshot of the parsed content at that commit**. This
   is the merge ancestor. Without it you cannot merge correctly (see §5).

Dirty state = serialize(working copy) ≠ serialize(base record), computed
per file with a canonical serializer (parse → re-serialize both sides so
hand-edited formatting doesn't count as a change).

## 3. Reading (works for private repos)

```
GET /repos/{o}/{r}/branches/{branch}          → head commit sha + tree sha
GET /repos/{o}/{r}/git/trees/{tree}?recursive=1 → file list with blob shas
GET /repos/{o}/{r}/git/blobs/{sha}            → base64 content (use with token)
```

- Only fetch blobs whose sha differs from the cache. Steady-state sync is
  2 requests.
- Without a token (public data repo), fetch file contents from
  `https://raw.githubusercontent.com/{o}/{r}/{commit-sha}/{path}` instead —
  it is CORS-enabled and doesn't consume API rate limit (anonymous API limit
  is 60/h; with token 5000/h).
- Branch missing / empty repo: `GET branches` 404s while `GET /repos/{o}/{r}`
  succeeds → treat as empty state, not an error.
- Binary files (images) in a private repo: `<img>` can't send an Authorization
  header. Render with a normal URL first and add a capture-phase `error`
  listener that refetches via
  `GET /repos/{o}/{r}/contents/{path}` (base64 → Blob → `URL.createObjectURL`).

## 4. Writing — one atomic commit via the git data API

```
POST  /git/blobs    {content, encoding:'base64'}   (binaries only; text can go inline)
POST  /git/trees    {base_tree: parentTreeSha, tree:[
                      {path, mode:'100644', type:'blob', content:'…'}   // text
                      {path, mode:'100644', type:'blob', sha:'…'}       // created blob
                      {path, mode:'100644', type:'blob', sha:null}      // deletion
                    ]}
POST  /git/commits  {message, tree, parents:[parentSha]}
PATCH /git/refs/heads/{branch}  {sha}              (non-force!)
```

- All changed files in **one** tree/commit — never N commits per save.
- **Empty-repo bootstrap**: if there is no head yet, create the commit with
  `parents: []` and `POST /git/refs` with `refs/heads/{branch}` instead of
  PATCH. Skip deletion entries in that case.
- The non-force PATCH is your race protection: if someone pushed between your
  pull and your ref update, GitHub answers 422 "not a fast forward" → re-pull,
  re-merge, retry once.

## 5. Concurrency: pull-before-save + three-way merge (the critical part)

**Never compute the diff against the *latest* remote state.** We shipped that
bug: once the base advances underneath a draft, every remote change appears as
a local change *in reverse*, and saving reverts other people's commits. The
diff and the merge must both use the draft's **fork point** as ancestor.

Save = always: fetch head → if it moved past the fork point, fetch the new
base and **merge into the draft** → commit the merged result with the fresh
head as parent → on 422, pull/merge/retry once.

Merge rules (per record, per field, with fork `f`, local `l`, remote `r`):

- `l == r` → nothing to do.
- only remote changed (`l == f`) → **adopt remote**.
- only local changed (`r == f`) → **keep local**.
- both changed the same field → **local wins**, and the conflict is reported
  to the user in a notice (the losing value is still in git history — nothing
  is ever silently lost).
- record deleted remotely, untouched locally → accept deletion; deleted
  remotely but *edited* locally → keep local (report). Symmetrically for
  local deletions.
- new records on either side → union (use collision-proof ids:
  `slug(title)-4charRandom`; one file per record makes merges mostly trivial).
- list-of-names config (tags/people/…): treat as keyed sets — apply local
  adds/removals on top of the remote list, merge per-key fields the same way.

After a merge, if the working copy now equals the new base, delete the draft
(clean state). Also run the same merge on: page load when the cache moved
ahead of the draft, periodic/refocus sync, and before every commit.

Additional sync triggers that shrink divergence windows: refresh on
`visibilitychange`/`focus` (throttle ~15 s); a `storage`-event listener so a
hidden tab adopts a sibling tab's draft instead of clobbering it later.

## 6. Token handling & diagnostics (learned the hard way)

- Fine-grained PAT: *Repository access = only the data repo*,
  *Permissions → Contents: Read and write* (Metadata comes automatically).
- **Do not trust `GET /repos/{o}/{r}` as a "test connection".** It succeeds
  for any public repo, and its `permissions` field reflects the *user's*
  permissions, not the token's grants. Probe for real:
  - read: `GET branches/{branch}` succeeds;
  - write: `POST /git/blobs` with a tiny string — an **unreferenced blob** is
    invisible and garbage-collected, so this is a safe, side-effect-free probe.
    A 403 here means no write.
- Map GitHub's cryptic 403 `"Resource not accessible by personal access
  token"` to an actionable message: it means *the token isn't scoped to the
  repo being addressed* (very often: settings point at the wrong repo) or
  lacks Contents write.
- Tokens follow repo **renames** (scoped by repo id). But a rename's URL
  redirect dies the moment a *new* repo takes the old name — update git
  remotes explicitly when splitting repos.
- Auth header: `Authorization: Bearer <token>`, plus
  `Accept: application/vnd.github+json` and
  `X-GitHub-Api-Version: 2022-11-28`.

## 7. Deployment pitfalls (GitHub Pages)

- **Pages serves every file on the branch.** Never let data files into the
  app repo; after deploying, verify that a data path 404s on the public site.
- Enable Pages **only on the app repo** (Deploy from a branch, `main`/root).
  Add `.nojekyll`.
- When a formerly-Pages-enabled repo goes private (free plan), its Pages
  config lingers and the internal "pages build and deployment" workflow keeps
  running and failing on every push → disable that workflow (repo → Actions →
  select it → ⋯ → Disable) or unpublish the site.
- Pages deploys occasionally fail transiently ("Deployment failed, try again
  later"), especially back-to-back deploys; the build job succeeding while
  only the deploy step fails = GitHub-side, retrigger with an empty commit.
- A failed deploy never affects the data path — the app reads via API, not
  from the deployed files. Only app-code updates are delayed.

## 8. Assorted client-side notes

- `localStorage` is **per-origin**: `localhost` ≠ `127.0.0.1`, and the Pages
  site is a third origin. Quota ~5 MB — if you inline pending images as data
  URLs in the draft, downscale them client-side (canvas, ≤1600 px) first.
- No build step keeps the public repo auditable: what's in the repo is what
  runs. Plain ES modules are fine; they need an HTTP server locally
  (`python3 -m http.server`), not `file://`.
- Provide a `?demo=1` mode with embedded sample data so the app can be tried
  and developed with zero configuration.
- Order of operations when splitting an existing public repo (data was
  already public — assume it may have been crawled):
  1. rename the old repo to the data-repo name and flip it private,
  2. create the new public app repo (it can take the old name and URL),
  3. push the app code, enable Pages,
  4. repoint local git remotes,
  5. users update the repo name in the app settings and re-issue share links
     (old links embed the old repo name).

## 9. Minimal implementation checklist

- [ ] GitHub API client: request wrapper (auth header, error mapping incl.
      rate-limit and "not accessible" 403), `getHead`, `getTree`,
      `getBlobText`, `rawUrl`, `commitFiles` (blobs → tree → commit → ref,
      empty-repo bootstrap, deletions).
- [ ] Store: settings (owner/repo/branch/token, per-origin), sha-keyed base
      cache, draft with fork snapshot, canonical (de)serializers, dirty diff
      vs fork-based base, mutations → debounced persist + `pagehide` flush.
- [ ] Three-way merge exactly as §5, wired into: load, refresh, focus,
      storage-event adoption, and save (with one 422 retry).
- [ ] Settings UI: connection fields + real read/write probes, share-link
      export (#setup= fragment, warning text) and import-on-load.
- [ ] Empty/error states: not configured → hint banner; configured but 404
      without token → "private repo, token needed" banner.
- [ ] Verify after deploy: data URL 404s on the public site; anonymous API on
      the data repo 404s.
