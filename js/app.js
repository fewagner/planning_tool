// app.js — boot, tab routing, save button, sync banner, share-link import.

import { store, migrateProjects } from './store.js';
import { board } from './board.js';
import { list } from './list.js';
import { timeline } from './timeline.js';
import { initEditor } from './editor.js';
import { initSettings, openSettings } from './settings.js';
import { initProjects } from './projects.js';
import { toast } from './ui.js';
import { b64DecodeUtf8, lsGet, lsSet, uid } from './util.js';

const views = { board, list, timeline };
let active = 'board';

// ----- share-link import (#setup=…) — adds a project, before the store boots -----

function importSetupHash() {
  const m = location.hash.match(/[#&]setup=([A-Za-z0-9\-_]+)/);
  if (!m) return;
  try {
    const json = JSON.parse(b64DecodeUtf8(m[1].replace(/-/g, '+').replace(/_/g, '/')));
    if (typeof json.owner !== 'string' || typeof json.repo !== 'string' || !json.owner || !json.repo) {
      throw new Error('missing owner/repo');
    }
    const projects = migrateProjects();
    const branch = (typeof json.branch === 'string' && json.branch) || 'main';
    let p = projects.find(q => q.owner === json.owner && q.repo === json.repo && (q.branch || 'main') === branch);
    if (p) {
      if (typeof json.token === 'string' && json.token) p.token = json.token;
      if (typeof json.name === 'string' && json.name) p.name = json.name;
    } else {
      p = {
        id: 'p-' + uid(),
        name: typeof json.name === 'string' ? json.name : '',
        owner: json.owner, repo: json.repo, branch,
        token: typeof json.token === 'string' ? json.token : '',
      };
      projects.push(p);
    }
    lsSet('pt:projects', projects);
    lsSet('pt:active', p.id);
    setTimeout(() => toast(`Project ${p.name || `${p.owner}/${p.repo}`} added from the link.`, 'ok'), 300);
  } catch {
    setTimeout(() => toast('The setup link could not be read.', 'err'), 300);
  }
  history.replaceState(null, '', location.pathname + location.search + '#board');
}

// ----- tabs -----

function switchView(name, updateHash = true) {
  if (!views[name]) name = 'board';
  active = name;
  for (const [n, v] of Object.entries(views)) {
    document.getElementById('view-' + n).hidden = n !== name;
  }
  for (const b of document.querySelectorAll('.tab')) {
    b.classList.toggle('active', b.dataset.view === name);
  }
  if (updateHash && location.hash !== '#' + name) {
    history.replaceState(null, '', '#' + name);
  }
  views[name].activate();
}

// ----- top bar state -----

function updateChrome() {
  const saveBtn = document.getElementById('save-btn');
  const n = store.changes().length;
  if (store.saving) {
    saveBtn.textContent = 'Saving…';
    saveBtn.disabled = true;
  } else {
    saveBtn.textContent = n ? `Save (${n})` : 'Save';
    saveBtn.disabled = n === 0;
  }
  saveBtn.classList.toggle('attention', n > 0 && !store.saving);

  updateBanner();
}

function updateBanner() {
  const banner = document.getElementById('banner');
  const needsToken = !store.demo && store.configured() && !store.settings.token
    && store.lastError && ['not-found', 'auth', 'raw', 'forbidden'].includes(store.lastError.code);
  if (!store.demo && !store.configured() && store.projects.length > 0) {
    // projects exist but the active one is broken — the welcome screen
    // covers the zero-projects case
    banner.hidden = false;
    banner.innerHTML = `
      <span>This project is missing its repository settings.</span>
      <button class="btn b-settings">Open settings</button>`;
    banner.querySelector('.b-settings').addEventListener('click', openSettings);
  } else if (needsToken) {
    banner.hidden = false;
    banner.innerHTML = `
      <span>This planner's data lives in a private repository — a GitHub token is needed to read it.</span>
      <button class="btn b-settings">Open settings</button>`;
    banner.querySelector('.b-settings').addEventListener('click', openSettings);
  } else {
    banner.hidden = true;
    banner.innerHTML = '';
  }
}

// ----- save -----

async function doSave() {
  try {
    const r = await store.save();
    toast(r.nothing ? 'Nothing to save — the repository is already up to date.' : `Saved to GitHub ✓ (commit ${r.sha.slice(0, 7)})`, 'ok');
  } catch (e) {
    if (e.code === 'no-token' || e.code === 'config' || e.code === 'demo') {
      toast(e.message, 'err');
      openSettings();
    } else if (e.code === 'conflict') {
      toast('GitHub kept rejecting the commit (very busy branch?). Try saving again.', 'err');
    } else {
      toast(e.message || 'Save failed.', 'err');
    }
  }
}

// ----- boot -----

function boot() {
  importSetupHash();

  initEditor();
  initSettings();
  board.init(document.getElementById('view-board'));
  list.init(document.getElementById('view-list'));
  timeline.init(document.getElementById('view-timeline'));
  initProjects();

  document.getElementById('tabs').addEventListener('click', e => {
    const b = e.target.closest('.tab');
    if (b) switchView(b.dataset.view);
  });
  window.addEventListener('hashchange', () => switchView(location.hash.slice(1), false));

  document.getElementById('save-btn').addEventListener('click', doSave);
  document.getElementById('settings-btn').addEventListener('click', openSettings);

  store.on('change', updateChrome);
  store.on('error', e => toast(e.message || String(e), 'err'));
  store.on('merged', rep => {
    if (rep.conflicts.length) {
      const list = rep.conflicts.slice(0, 3).join(' · ');
      toast(`Merged remote changes. Both sides edited: ${list}${rep.conflicts.length > 3 ? ' …' : ''} — kept your version.`, 'info', 8000);
    } else if (rep.pulled) {
      toast(`Merged ${rep.pulled} remote change(s) into your unsaved work.`, 'info');
    }
  });

  // the draft write is debounced — make sure the last edit survives a quick tab close
  window.addEventListener('pagehide', () => {
    if (store._hasDraft) store._persistDraftNow();
  });

  // keep long-lived tabs fresh: pull whenever the tab regains focus
  const maybeRefresh = () => {
    if (!document.hidden && Date.now() - (store.lastSync || 0) > 15000) store.refresh();
  };
  window.addEventListener('focus', maybeRefresh);
  document.addEventListener('visibilitychange', maybeRefresh);

  // a second tab of this browser wrote to localStorage — adopt while hidden
  window.addEventListener('storage', e => {
    if (!e.key) return;
    if (e.key === 'pt:settings') {
      store.loadSettings();
      store.emit('change', { source: 'settings' });
    } else if ((e.key === store.key('draft') || e.key === store.key('cache')) && document.hidden) {
      store.adoptExternal();
    }
  });

  store.init();
  switchView(location.hash.slice(1) || 'board');
  updateChrome();

  // debugging/console access
  window.PT = { store };
}

boot();
