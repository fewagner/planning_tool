// settings.js — modal with the GitHub connection (repo + token), the share
// link, and management of people and tags. Repo settings and the token live in
// the browser (localStorage); people and tags live in data/config.yml and are
// committed on save like everything else.

import { store } from './store.js';
import { openProjectModal } from './projects.js';
import { toast } from './ui.js';
import { esc, b64EncodeUtf8, debounce } from './util.js';
import { APP_VERSION, CHANGELOG_URL } from './version.js';

let scrim, modal;
const $ = sel => modal.querySelector(sel);

export function initSettings() {
  scrim = document.createElement('div');
  scrim.className = 'modal-scrim';
  scrim.hidden = true;

  modal = document.createElement('div');
  modal.className = 'modal settings';
  modal.hidden = true;
  modal.innerHTML = `
    <header class="modal-head">
      <h2>Settings</h2>
      <button class="icon-btn s-close" title="Close">✕</button>
    </header>
    <div class="modal-body">

      <section>
        <h3>Project</h3>
        <label class="field">
          <span class="field-name">Project name (stored in data/config.yml — everyone in the project sees it)</span>
          <input class="s-projname" maxlength="60" placeholder="e.g. Party planning">
        </label>
        <div class="s-projects rows"></div>
        <div class="btn-row">
          <button class="btn s-addproject">＋ Add another project</button>
        </div>
      </section>

      <section>
        <h3>GitHub connection (this project)</h3>
        <div class="field-grid">
          <label class="field"><span class="field-name">Owner</span><input class="s-owner" placeholder="user or org" autocapitalize="off"></label>
          <label class="field"><span class="field-name">Repository</span><input class="s-repo" placeholder="repo name" autocapitalize="off"></label>
          <label class="field"><span class="field-name">Branch</span><input class="s-branch" placeholder="main" autocapitalize="off"></label>
        </div>
        <label class="field">
          <span class="field-name">Token (fine-grained PAT with read/write access to this repository's contents)</span>
          <span class="token-row">
            <input class="s-token" type="password" placeholder="github_pat_…" autocomplete="off">
            <button class="mini-btn s-showtoken" title="Show/hide">👁</button>
          </span>
        </label>
        <p class="hint">Create one at github.com → Settings → Developer settings → Fine-grained tokens.
        The token stays in this browser; it is needed to save (and to read private repositories).</p>
        <div class="btn-row">
          <button class="btn s-test">Test connection</button>
          <button class="btn s-reload">Reload data from GitHub</button>
        </div>
        <p class="s-testresult hint"></p>
      </section>

      <section>
        <h3>Share link</h3>
        <p class="hint">Copies a link to this page with the repository settings <b>and your token</b> embedded.
        Opening it stores the token in that browser. Anyone with the link can write to your repo — share it only
        with people you'd hand your token to, and never post it publicly.</p>
        <button class="btn s-copylink">Copy link with token</button>
        <p class="hint"><b>Tip — one token per person:</b> instead of sharing one token with everyone, create a
        separate <a href="https://github.com/settings/personal-access-tokens" target="_blank" rel="noopener">fine-grained
        token</a> for each person (all on the same data repository, Contents: Read and write), paste it here, copy the
        link, send it, then paste your own token back. To <b>revoke one person</b>, delete their token on that GitHub
        page — their link stops working within moments, everyone else is unaffected, and the data is untouched.
        <b>Rotating</b> works the same way: delete a token, create a fresh one, send a new link.</p>
      </section>

      <section>
        <h3>People</h3>
        <div class="s-people rows"></div>
        <form class="add-row s-addperson">
          <input placeholder="Name" maxlength="80">
          <button class="btn" type="submit">Add</button>
        </form>
      </section>

      <section>
        <h3>Tags</h3>
        <div class="s-tags rows"></div>
        <form class="add-row s-addtag">
          <input type="color" value="#4f8cff" title="Tag color">
          <input placeholder="Tag name" maxlength="60" class="s-addtag-name">
          <button class="btn" type="submit">Add</button>
        </form>
        <p class="hint">People and tags are stored in <code>data/config.yml</code> and committed when you save.</p>
      </section>

      <section>
        <h3>Local data</h3>
        <p class="hint s-draftinfo"></p>
        <div class="btn-row">
          <button class="btn danger s-discard">Discard unsaved changes</button>
        </div>
      </section>

      <p class="hint settings-footer">Planner v${APP_VERSION} ·
        <a href="${CHANGELOG_URL}" target="_blank" rel="noopener">changelog</a></p>

    </div>`;

  document.body.appendChild(scrim);
  document.body.appendChild(modal);

  scrim.addEventListener('pointerdown', closeSettings);
  $('.s-close').addEventListener('click', closeSettings);
  window.addEventListener('keydown', e => {
    if (e.key === 'Escape' && !modal.hidden) closeSettings();
  });

  const saveConn = debounce(() => {
    store.saveSettings({
      owner: $('.s-owner').value.trim(),
      repo: $('.s-repo').value.trim(),
      branch: $('.s-branch').value.trim() || 'main',
      token: $('.s-token').value.trim(),
    });
  }, 300);
  for (const sel of ['.s-owner', '.s-repo', '.s-branch', '.s-token']) {
    $(sel).addEventListener('input', saveConn);
  }

  $('.s-projname').addEventListener('change', e => {
    store.setConfig({ name: e.target.value.trim() }, 'settings');
  });

  $('.s-addproject').addEventListener('click', () => {
    closeSettings();
    openProjectModal();
  });

  $('.s-showtoken').addEventListener('click', () => {
    const t = $('.s-token');
    t.type = t.type === 'password' ? 'text' : 'password';
  });

  $('.s-test').addEventListener('click', async () => {
    const out = $('.s-testresult');
    out.textContent = 'Testing…';
    try {
      const gh = store.client();
      const repo = await gh.getRepo();
      let msg = `✓ Found ${repo.full_name} (${repo.private ? 'private' : 'public'}, default branch ${repo.default_branch})`;
      if (store.settings.token) {
        // probe the real permissions: fine-grained tokens can pass the repo
        // lookup (public repos, or user-level permissions) yet still be unable
        // to read or write the contents.
        let read = false;
        try { await gh.getHead(); read = true; } catch { }
        let write;
        try {
          // an unreferenced blob is invisible and gets garbage-collected
          await gh.req(`${gh.base()}/git/blobs`, { method: 'POST', body: { content: 'planning-tool permission check', encoding: 'utf-8' } });
          write = true;
        } catch (e) {
          write = !(e.status === 403 || e.code === 'auth');
        }
        msg += ` — token: read ${read ? '✓' : '✗'}, write ${write ? '✓' : '✗'}.`;
        if (!read || !write) msg += ' The token must be scoped to exactly this repository with Contents: Read and write.';
      } else {
        msg += repo.private ? ' — ⚠ private repository: a token is required.' : ' — no token: read-only, saving is disabled.';
      }
      out.textContent = msg;
    } catch (e) {
      out.textContent = '✗ ' + (e.message || e);
    }
  });

  $('.s-reload').addEventListener('click', async () => {
    await store.refresh();
    toast(store.lastError ? 'Reload failed: ' + store.lastError.message : 'Data reloaded from GitHub.', store.lastError ? 'err' : 'ok');
  });

  $('.s-copylink').addEventListener('click', async () => {
    const { owner, repo, branch, token } = store.settings;
    if (!token) { toast('Add a token first.', 'err'); return; }
    const payload = b64EncodeUtf8(JSON.stringify({ owner, repo, branch, token, name: store.projectName() }))
      .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    const url = `${location.origin}${location.pathname}#setup=${payload}`;
    try {
      await navigator.clipboard.writeText(url);
      toast('Link copied. Treat it like the token itself!', 'ok');
    } catch {
      prompt('Copy this link:', url);
    }
  });

  $('.s-addperson').addEventListener('submit', e => {
    e.preventDefault();
    const input = e.target.querySelector('input');
    const name = input.value.trim();
    if (!name) return;
    if (store.config.people.includes(name)) { toast('That person already exists.', 'err'); return; }
    store.setConfig({ people: [...store.config.people, name] }, 'settings');
    input.value = '';
    renderPeople();
  });

  $('.s-addtag').addEventListener('submit', e => {
    e.preventDefault();
    const name = $('.s-addtag-name').value.trim();
    const color = e.target.querySelector('input[type=color]').value;
    if (!name) return;
    if (store.config.tags.some(t => t.name === name)) { toast('That tag already exists.', 'err'); return; }
    store.setConfig({ tags: [...store.config.tags, { name, color }] }, 'settings');
    $('.s-addtag-name').value = '';
    renderTags();
  });

  $('.s-discard').addEventListener('click', () => {
    const n = store.changes().length;
    if (!n) { toast('No unsaved changes.', 'info'); return; }
    if (confirm(`Throw away ${n} unsaved change(s) and go back to the last saved state?`)) {
      store.discardDraft();
      renderAll();
      toast('Local changes discarded.', 'ok');
    }
  });
}

export function openSettings() {
  renderAll();
  scrim.hidden = false;
  modal.hidden = false;
}

export function closeSettings() {
  scrim.hidden = true;
  modal.hidden = true;
}

function renderAll() {
  $('.s-projname').value = store.config.name || '';
  $('.s-owner').value = store.settings.owner;
  $('.s-repo').value = store.settings.repo;
  $('.s-branch').value = store.settings.branch;
  $('.s-token').value = store.settings.token;
  $('.s-testresult').textContent = '';
  const n = store.changes().length;
  $('.s-draftinfo').textContent = store.demo
    ? 'Demo mode: data lives only in this browser until you configure a repository.'
    : n
      ? `${n} unsaved change(s) are stored in this browser and survive reloads. "Save" commits them to GitHub.`
      : 'Everything is saved. Local edits are kept in this browser until you press Save.';
  renderProjects();
  renderPeople();
  renderTags();
}

function renderProjects() {
  const host = $('.s-projects');
  host.replaceChildren();
  for (const p of store.projects) {
    const isActive = !store.demo && store.active && p.id === store.active.id;
    const row = document.createElement('div');
    row.className = 'row';
    row.innerHTML = `
      <span class="row-title">${esc(p.name || `${p.owner}/${p.repo}`)}
        <span class="hint" style="display:inline">· ${esc(`${p.owner}/${p.repo}`)}</span></span>
      ${isActive ? '<span class="chip">active</span>' : '<button class="mini-btn p-switch">switch to</button>'}
      <button class="mini-btn p-remove" title="Remove from this browser">✕</button>`;
    row.querySelector('.p-switch')?.addEventListener('click', () => store.switchProject(p.id));
    row.querySelector('.p-remove').addEventListener('click', () => {
      if (!confirm(`Remove "${p.name || `${p.owner}/${p.repo}`}" from this browser?\n\nThe repository and all its data stay untouched on GitHub — this only forgets the connection and token here.`)) return;
      store.removeProject(p.id);
      if (!store.demo && (!store.active || store.active.id === p.id)) location.reload();
      else renderProjects();
    });
    host.appendChild(row);
  }
}

function renderPeople() {
  const host = $('.s-people');
  host.replaceChildren();
  if (!store.config.people.length) {
    host.innerHTML = '<p class="hint">No people yet — add the names you want to assign items to.</p>';
    return;
  }
  for (const name of store.config.people) {
    const row = document.createElement('div');
    row.className = 'row';
    row.innerHTML = `<span class="row-title">${esc(name)}</span>
      <button class="mini-btn" title="Remove">✕</button>`;
    row.querySelector('button').addEventListener('click', () => {
      const used = Object.values(store.items).filter(i => (i.people || []).includes(name)).length;
      if (used && !confirm(`${name} is responsible for ${used} item(s). Remove anyway? The items keep the name until you change it.`)) return;
      store.setConfig({ people: store.config.people.filter(p => p !== name) }, 'settings');
      renderPeople();
    });
    host.appendChild(row);
  }
}

function renderTags() {
  const host = $('.s-tags');
  host.replaceChildren();
  if (!store.config.tags.length) {
    host.innerHTML = '<p class="hint">No tags yet — tags give items their color on all pages.</p>';
    return;
  }
  store.config.tags.forEach((tag, i) => {
    const row = document.createElement('div');
    row.className = 'row';
    row.innerHTML = `
      <input type="color" value="${esc(store.tagColor(tag.name))}" title="Color">
      <input class="tag-name" value="${esc(tag.name)}" maxlength="60">
      <button class="mini-btn" title="Remove">✕</button>`;
    row.querySelector('input[type=color]').addEventListener('input', e => {
      const tags = store.config.tags.map((t, j) => j === i ? { ...t, color: e.target.value } : t);
      store.setConfig({ tags }, 'settings');
    });
    row.querySelector('.tag-name').addEventListener('change', e => {
      const newName = e.target.value.trim();
      if (!newName) { e.target.value = tag.name; return; }
      if (newName !== tag.name && store.config.tags.some(t => t.name === newName)) {
        toast('That tag name already exists.', 'err');
        e.target.value = tag.name;
        return;
      }
      store.renameTag(tag.name, newName);
      renderTags();
    });
    row.querySelector('button').addEventListener('click', () => {
      const used = Object.values(store.items).filter(it => it.tag === tag.name).length;
      if (used && !confirm(`${used} item(s) use the tag "${tag.name}". Remove it anyway? Those items keep the tag name but turn grey.`)) return;
      store.setConfig({ tags: store.config.tags.filter(t => t.name !== tag.name) }, 'settings');
      renderTags();
    });
    host.appendChild(row);
  });
}
