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

The planning **data lives in a separate, private repository** (one Markdown
file per item plus a small config — see that repo's README for the format).
The app reads and writes it through the GitHub API using a fine-grained
personal access token, so:

- without a token, visitors to this site see an empty planner;
- with a token (entered once in ⚙ Settings, or imported via a share link),
  you get full read/write access — every Save is one git commit in the data
  repository.

## Setup

1. Serve this repo with GitHub Pages: *Settings → Pages → Deploy from a
   branch → `main` / root*.
2. Keep your data in a **private** repo (e.g. `planning_data`).
3. Create a fine-grained PAT scoped to *only the data repo* with
   **Contents: Read and write**.
4. Open the app → ⚙ Settings → set owner / repository / branch of the *data*
   repo and paste the token. *Test connection* should report write access.
5. Use *Copy link with token* to log in other devices/people — treat that
   link like the token itself.

Unsaved edits are kept in the browser (they survive reloads and tab
switches). Saving pulls the latest data first and merges it three-way, so
concurrent edits from several people/devices don't overwrite each other.

## Local development

```bash
python3 -m http.server 4173
# http://localhost:4173/?demo=1   → bundled sample data, no GitHub connection
```
