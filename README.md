# Planning Tool (app)

A tiny project-planning app served by GitHub Pages:

- **Whiteboard** — infinite pan/zoom canvas: click to add items, drag them around.
- **List** — items grouped under a headline per tag (done items sort last).
- **Timeline** — items at their deadline on a zoomable axis; drag to reschedule.

Each item has a title, Markdown description with images, one tag (colored),
one or more responsible people, a deadline, a status (not started / ⏳ in
progress / ✅ done — done items are shown crossed out) and a 💬 "to discuss"
flag for marking things to bring up in the next meeting. The 💬/⏳/✅ markers
are shown in front of the title on all three pages.

No backend, no build step: plain HTML/CSS/JS. This repository contains **only
the app code** and is public so GitHub Pages (free plan) can serve it.

The planning **data lives in separate (ideally private) repositories** — one
per project, one Markdown file per item plus a small config. The app reads
and writes them through the GitHub API using fine-grained personal access
tokens, so:

- without a token, visitors to this site see the welcome screen / an empty
  planner;
- with a token, you get full read/write access — every Save is one git
  commit in that project's data repository.

## Using it

Open the app. With no project configured, a **welcome screen** walks through
the whole setup: create a data repo (private, can be empty), create a
fine-grained token (*Repository access* = only that repo, *Contents: Read
and write*), connect. That's it — the connection is verified before it is
added.

- **Multiple projects**: one browser can hold any number of projects (each a
  repo + token). The project button in the top bar switches between them;
  "＋ Add project…" adds more. Unsaved drafts are kept per project.
- **Project name**: set in ⚙ Settings; it is stored in the project's
  `data/config.yml`, so everyone in the project sees the same name.
- **Inviting people**: ⚙ Settings → *Copy link with token*. Opening that
  link adds the project (name, repo and token included) to the recipient's
  browser. Treat the link like the token itself.
- An empty data repo is bootstrapped automatically on the first save.

Unsaved edits are kept in the browser (they survive reloads and tab
switches). Saving pulls the latest data first and merges it three-way, so
concurrent edits from several people/devices don't overwrite each other.

## Hosting your own copy

Fork/copy this repo and serve it with GitHub Pages (*Settings → Pages →
Deploy from a branch → `main` / root*). The app is fully static and
repo-agnostic — nothing in it is specific to one user.

## Local development

```bash
python3 -m http.server 4173
# http://localhost:4173/?demo=1   → bundled sample data, no GitHub connection
```
