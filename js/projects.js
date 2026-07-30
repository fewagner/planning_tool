// projects.js — everything around "which project am I working on":
// the project button + switcher menu in the top bar, the add-project modal
// (with step-by-step onboarding instructions and a live connection check),
// and the first-run welcome screen shown when no project is configured yet.

import { store } from './store.js';
import { GitHubClient } from './github.js';
import { toast } from './ui.js';
import { esc } from './util.js';

let btn, menu, modalScrim, modal, welcome;
const $m = sel => modal.querySelector(sel);

const STEPS_HTML = `
  <ol class="setup-steps">
    <li><b>Create a data repository</b> on GitHub
      (<a href="https://github.com/new" target="_blank" rel="noopener">github.com/new</a>) —
      for example <code>my-plan-data</code>, ideally <b>Private</b>, completely empty is fine.</li>
    <li><b>Create a fine-grained access token</b>
      (<a href="https://github.com/settings/personal-access-tokens/new" target="_blank" rel="noopener">github.com
      → Settings → Developer settings → Fine-grained tokens</a>):<br>
      <em>Repository access</em> = only that repository ·
      <em>Permissions → Contents</em> = <b>Read and write</b>. Copy the token.</li>
    <li><b>Connect below.</b> The token is stored only in this browser. Invite others later
      with “Copy link with token” in ⚙ settings — opening that link sets everything up for them.</li>
  </ol>`;

export function initProjects() {
  btn = document.getElementById('project-btn');
  buildMenu();
  buildModal();
  buildWelcome();

  btn.addEventListener('click', e => {
    e.stopPropagation();
    if (menu.hidden) openMenu(); else closeMenu();
  });
  window.addEventListener('pointerdown', e => {
    if (!menu.hidden && !menu.contains(e.target) && e.target !== btn) closeMenu();
  }, true);
  window.addEventListener('keydown', e => {
    if (e.key === 'Escape') { closeMenu(); closeProjectModal(); }
  });

  store.on('change', render);
  render();
}

function render() {
  const name = store.projectName();
  btn.textContent = (name || 'Choose project') + (store.syncing ? ' ⟳' : ' ▾');
  btn.title = store.configured()
    ? `${store.settings.owner}/${store.settings.repo} @ ${store.settings.branch} — click to switch projects`
    : 'Choose or add a project';
  document.title = name ? `${name} · Planner` : 'Planning Tool';
  welcome.hidden = store.demo || store.projects.length > 0;
}

// ----- switcher menu -----

function buildMenu() {
  menu = document.createElement('div');
  menu.className = 'proj-menu';
  menu.hidden = true;
  document.body.appendChild(menu);
}

function openMenu() {
  const items = [];
  for (const p of store.projects) {
    const activeCls = store.active && p.id === store.active.id ? ' active' : '';
    items.push(`
      <button class="proj-menu-item${activeCls}" data-id="${esc(p.id)}">
        <span class="proj-menu-name">${esc(p.name || `${p.owner}/${p.repo}`)}</span>
        <span class="proj-menu-repo">${esc(`${p.owner}/${p.repo}`)}</span>
        ${activeCls ? '<span class="proj-menu-check">✓</span>' : ''}
      </button>`);
  }
  if (items.length) items.push('<div class="proj-menu-sep"></div>');
  items.push('<button class="proj-menu-item proj-menu-add" data-add="1">＋ Add project…</button>');
  menu.innerHTML = items.join('');

  menu.querySelectorAll('.proj-menu-item').forEach(el => {
    el.addEventListener('click', () => {
      closeMenu();
      if (el.dataset.add) { openProjectModal(); return; }
      const id = el.dataset.id;
      if (store.demo || !store.active || store.active.id !== id) store.switchProject(id);
    });
  });

  const r = btn.getBoundingClientRect();
  menu.hidden = false;
  menu.style.left = Math.min(r.left, window.innerWidth - 280) + 'px';
  menu.style.top = (r.bottom + 6) + 'px';
}

function closeMenu() { menu.hidden = true; }

// ----- add-project modal -----

function buildModal() {
  modalScrim = document.createElement('div');
  modalScrim.className = 'modal-scrim';
  modalScrim.hidden = true;

  modal = document.createElement('div');
  modal.className = 'modal project-modal';
  modal.hidden = true;
  modal.innerHTML = `
    <header class="modal-head">
      <h2>Add a project</h2>
      <button class="icon-btn pm-close" title="Close">✕</button>
    </header>
    <div class="modal-body">
      ${STEPS_HTML}
      <label class="field">
        <span class="field-name">Project name (optional, shown in the top bar)</span>
        <input class="pm-name" maxlength="60" placeholder="e.g. Party planning">
      </label>
      <div class="field-grid">
        <label class="field"><span class="field-name">Owner</span><input class="pm-owner" placeholder="user or org" autocapitalize="off"></label>
        <label class="field"><span class="field-name">Repository</span><input class="pm-repo" placeholder="my-plan-data" autocapitalize="off"></label>
        <label class="field"><span class="field-name">Branch</span><input class="pm-branch" value="main" autocapitalize="off"></label>
      </div>
      <label class="field">
        <span class="field-name">Token</span>
        <input class="pm-token" type="password" placeholder="github_pat_…" autocomplete="off">
      </label>
      <p class="pm-error hint"></p>
      <div class="btn-row">
        <button class="btn primary pm-connect">Connect project</button>
      </div>
    </div>`;

  document.body.appendChild(modalScrim);
  document.body.appendChild(modal);

  modalScrim.addEventListener('pointerdown', closeProjectModal);
  $m('.pm-close').addEventListener('click', closeProjectModal);
  $m('.pm-connect').addEventListener('click', connect);
  modal.addEventListener('keydown', e => { if (e.key === 'Enter' && e.target.tagName === 'INPUT') connect(); });
}

async function connect() {
  const fields = {
    name: $m('.pm-name').value.trim(),
    owner: $m('.pm-owner').value.trim(),
    repo: $m('.pm-repo').value.trim(),
    branch: $m('.pm-branch').value.trim() || 'main',
    token: $m('.pm-token').value.trim(),
  };
  const err = $m('.pm-error');
  err.textContent = '';
  if (!fields.owner || !fields.repo) {
    err.textContent = 'Owner and repository are required.';
    return;
  }
  const connectBtn = $m('.pm-connect');
  connectBtn.disabled = true;
  connectBtn.textContent = 'Checking…';
  try {
    await new GitHubClient(fields).getRepo();
  } catch (e) {
    connectBtn.disabled = false;
    connectBtn.textContent = 'Connect project';
    err.textContent = e.code === 'not-found' && !fields.token
      ? 'Repository not found. If it is private, the token is needed to see it — paste it above.'
      : (e.message || 'Could not reach the repository.');
    return;
  }
  const p = store.addProject(fields);
  toast(`Connected ${fields.owner}/${fields.repo} ✓`, 'ok');
  store.switchProject(p.id);
}

export function openProjectModal() {
  for (const sel of ['.pm-name', '.pm-owner', '.pm-repo', '.pm-token']) $m(sel).value = '';
  $m('.pm-branch').value = 'main';
  $m('.pm-error').textContent = '';
  $m('.pm-connect').disabled = false;
  $m('.pm-connect').textContent = 'Connect project';
  modalScrim.hidden = false;
  modal.hidden = false;
  $m('.pm-owner').focus();
}

export function closeProjectModal() {
  modalScrim.hidden = true;
  modal.hidden = true;
}

// ----- first-run welcome -----

function buildWelcome() {
  welcome = document.createElement('div');
  welcome.className = 'welcome';
  welcome.hidden = true;
  welcome.innerHTML = `
    <div class="welcome-card">
      <div class="welcome-logo">🧭</div>
      <h2>Plan together — on top of GitHub</h2>
      <p class="welcome-pitch">A shared whiteboard, list and timeline for your project.
      All data lives in a GitHub repository <em>you</em> own: private, versioned,
      no accounts, no backend, free.</p>
      <div class="welcome-actions">
        <button class="btn primary w-connect">Connect your project</button>
        <a class="btn" href="?demo=1#board">Try the demo first</a>
      </div>
      ${STEPS_HTML}
      <p class="hint">Got a project link from someone? Just open it — the project
      appears here automatically, including access.</p>
    </div>`;
  document.querySelector('main').appendChild(welcome);
  welcome.querySelector('.w-connect').addEventListener('click', openProjectModal);
}
