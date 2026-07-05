// store.js — single source of truth for the app.
//
// `base`  = the data as it exists in the GitHub repo (or the local cache of it).
// `items`/`config` = the working copy shown in the UI. Every mutation is written
// to localStorage immediately (the "draft"), so nothing is lost when switching
// pages or reloading. "Save" turns the diff between working copy and base into
// one git commit.

import { GitHubClient, GHError } from './github.js';
import { DEMO_FILES } from './demo.js';
import {
  ITEM_DIR, IMAGE_DIR, CONFIG_PATH,
  parseItemFile, serializeItem, parseYamlConfig, serializeConfig,
  slugify, uid, lsGet, lsSet, lsDel, debounce,
} from './util.js';

const SETTINGS_KEY = 'pt:settings';
export const UNTAGGED_COLOR = '#8a93a6';
const FALLBACK_TAG_COLORS = ['#4f8cff', '#8b5cf6', '#f59e0b', '#10b981', '#ef4444', '#06b6d4', '#e879a0', '#84cc16'];

const clone = o => JSON.parse(JSON.stringify(o));

function commitMessage(base, changes) {
  const n = { add: 0, update: 0, remove: 0 };
  for (const c of changes) {
    if (c.delete) n.remove++;
    else if (base.files[c.path]) n.update++;
    else n.add++;
  }
  const parts = Object.entries(n).filter(([, v]) => v).map(([k, v]) => `${k} ${v}`);
  return `planning: ${parts.join(', ') || 'update'}`;
}

function parseFiles(sha, files) {
  const items = {};
  let config = { people: [], tags: [] };
  let configText = null;
  for (const [path, f] of Object.entries(files)) {
    if (path === CONFIG_PATH) {
      config = parseYamlConfig(f.text);
      configText = f.text;
    } else if (path.startsWith(ITEM_DIR) && path.endsWith('.md')) {
      const it = parseItemFile(path, f.text);
      items[it.id] = it;
    }
  }
  return { sha, files, items, config, configText };
}

export const store = {
  settings: { owner: '', repo: '', branch: 'main', token: '' },
  base: parseFiles(null, {}),
  items: {},
  config: { people: [], tags: [] },
  pendingImages: {},   // repo path -> data URL, committed on save
  demo: false,
  syncing: false,
  saving: false,
  lastError: null,
  _hasDraft: false,
  _draftBaseSha: null, // commit the draft forked from
  _fork: null,         // { items, config } snapshot at that commit (merge ancestor)
  _subs: {},

  on(evt, fn) { (this._subs[evt] ||= []).push(fn); },
  emit(evt, data) {
    for (const fn of this._subs[evt] || []) {
      try { fn(data); } catch (e) { console.error(e); }
    }
  },

  configured() { return !!(this.settings.owner && this.settings.repo); },
  client() { return new GitHubClient(this.settings); },
  repoKey() { return this.demo ? 'demo' : `${this.settings.owner}/${this.settings.repo}#${this.settings.branch}`; },
  key(name) { return `pt:${this.repoKey()}:${name}`; },

  // ----- settings -----

  loadSettings() {
    const s = lsGet(SETTINGS_KEY) || {};
    this.settings = { owner: '', repo: '', branch: 'main', token: '', ...s };
    if (!this.settings.owner && location.hostname.endsWith('.github.io')) {
      this.settings.owner = location.hostname.split('.')[0];
      if (!this.settings.repo) {
        const seg = location.pathname.split('/').filter(Boolean)[0];
        this.settings.repo = seg || `${this.settings.owner}.github.io`;
      }
    }
  },

  saveSettings(patch) {
    Object.assign(this.settings, patch);
    lsSet(SETTINGS_KEY, this.settings);
    this.emit('change', { source: 'settings' });
  },

  // ----- boot -----

  async init() {
    this.demo = new URLSearchParams(location.search).has('demo');
    this.loadSettings();

    if (this.demo) {
      const files = Object.fromEntries(Object.entries(DEMO_FILES).map(([p, text]) => [p, { sha: 'demo:' + p, text }]));
      this.base = parseFiles('demo', files);
    } else {
      const cache = lsGet(this.key('cache'));
      if (cache && cache.files) this.base = parseFiles(cache.sha, cache.files);
    }

    const draft = lsGet(this.key('draft'));
    if (draft && draft.items) {
      this.items = draft.items;
      this.config = draft.config || { people: [], tags: [] };
      this.pendingImages = draft.pendingImages || {};
      this._draftBaseSha = draft.baseSha ?? null;
      this._fork = draft.fork || { items: clone(this.base.items), config: clone(this.base.config) };
      this._hasDraft = true;
      // cache moved ahead of this draft (e.g. another tab synced) — merge now
      if (this._draftBaseSha !== this.base.sha) {
        const report = this._mergeIntoDraft(this.base);
        if (report.pulled || report.conflicts.length) this.emit('merged', report);
      }
    } else {
      this.resetToBase();
    }
    this.emit('change');
    if (!this.demo && this.configured()) this.refresh();
  },

  resetToBase() {
    this.items = clone(this.base.items);
    this.config = clone(this.base.config);
    this.pendingImages = {};
    this._hasDraft = false;
    this._draftBaseSha = this.base.sha;
    this._fork = null;
  },

  // ----- draft persistence -----

  _persistDraft: null, // debounced, set up below

  _persistDraftNow() {
    const ok = lsSet(this.key('draft'), {
      baseSha: this._draftBaseSha,
      items: this.items,
      config: this.config,
      pendingImages: this.pendingImages,
      fork: this._fork,
      ts: Date.now(),
    });
    if (!ok) this.emit('error', new GHError('Could not store the draft in the browser (storage full?). Changes only live in this tab until you save.', 'storage'));
  },

  touch(source) {
    if (!this._hasDraft) {
      this._hasDraft = true;
      this._draftBaseSha = this.base.sha;
      this._fork = { items: clone(this.base.items), config: clone(this.base.config) };
    }
    this._persistDraft();
    this.emit('change', { source });
  },

  // ----- mutations -----

  newItem(props = {}) {
    const title = (props.title || '').trim() || 'Untitled';
    let id = `${slugify(title) || 'item'}-${uid().slice(0, 4)}`;
    while (this.items[id] || this.base.items[id]) id = `${slugify(title) || 'item'}-${uid().slice(0, 4)}`;
    const item = { description: '', person: null, deadline: null, tag: null, x: null, y: null, ...props, id, title };
    this.items[id] = item;
    this.touch();
    return item;
  },

  updateItem(id, patch, source) {
    const it = this.items[id];
    if (!it) return;
    Object.assign(it, patch);
    this.touch(source);
  },

  deleteItem(id) {
    delete this.items[id];
    this.touch();
  },

  setConfig(patch, source) {
    Object.assign(this.config, patch);
    this.touch(source);
  },

  renameTag(oldName, newName) {
    newName = newName.trim();
    if (!newName || oldName === newName) return;
    const t = this.config.tags.find(t => t.name === oldName);
    if (t) t.name = newName;
    for (const it of Object.values(this.items)) if (it.tag === oldName) it.tag = newName;
    this.touch();
  },

  addImage(name, dataUrl) {
    const path = IMAGE_DIR + name;
    this.pendingImages[path] = dataUrl;
    this.touch();
    return path;
  },

  // ----- derived -----

  tagColor(tag) {
    if (!tag) return UNTAGGED_COLOR;
    const i = this.config.tags.findIndex(t => t.name === tag);
    if (i === -1) return UNTAGGED_COLOR;
    return this.config.tags[i].color || FALLBACK_TAG_COLORS[i % FALLBACK_TAG_COLORS.length];
  },

  // List of file-level changes between working copy and base.
  changes() {
    const list = [];
    for (const it of Object.values(this.items)) {
      const path = ITEM_DIR + it.id + '.md';
      const text = serializeItem(it);
      const baseIt = this.base.items[it.id];
      if (!baseIt || serializeItem(baseIt) !== text) list.push({ path, text });
    }
    for (const id of Object.keys(this.base.items)) {
      if (!this.items[id]) list.push({ path: ITEM_DIR + id + '.md', delete: true });
    }
    const cfgText = serializeConfig(this.config);
    const baseCfgText = this.base.configText != null
      ? serializeConfig(this.base.config)
      : serializeConfig({ people: [], tags: [] });
    if (cfgText !== baseCfgText) list.push({ path: CONFIG_PATH, text: cfgText });
    for (const [path, dataUrl] of Object.entries(this.pendingImages)) {
      list.push({ path, base64: String(dataUrl).split(',')[1] || '' });
    }
    return list;
  },

  isDirty() { return this.changes().length > 0; },

  // ----- image URL resolution for Markdown rendering -----

  resolveImagePath(src) {
    if (/^(https?:|data:|blob:)/i.test(src)) return null;
    let p = src.replace(/^\.\//, '');
    while (p.startsWith('../')) p = p.slice(3);
    if (p.startsWith('images/')) return 'data/' + p;
    if (!p.startsWith('data/')) return ITEM_DIR + p;
    return p;
  },

  imgUrl(src) {
    const path = this.resolveImagePath(src);
    if (!path) return src;
    if (this.pendingImages[path]) return this.pendingImages[path];
    if (!this.demo && this.configured() && this.base.sha) return this.client().rawUrl(this.base.sha, path);
    return path; // relative fetch (demo / local dev)
  },

  // ----- remote sync -----

  async _fetchBase(gh, head) {
    const tree = await gh.getTree(head.treeSha);
    const wanted = tree.filter(f => f.type === 'blob'
      && (f.path === CONFIG_PATH || (f.path.startsWith(ITEM_DIR) && f.path.endsWith('.md'))));
    const files = {};
    for (const f of wanted) {
      const prev = this.base.files[f.path];
      files[f.path] = prev && prev.sha === f.sha
        ? prev
        : { sha: f.sha, text: this.settings.token ? await gh.getBlobText(f.sha) : await gh.getRawText(head.sha, f.path) };
    }
    return parseFiles(head.sha, files);
  },

  _setBase(newBase) {
    this.base = newBase;
    lsSet(this.key('cache'), { sha: newBase.sha, files: newBase.files });
  },

  // Three-way merge of remote changes (newBase) into the local draft, with the
  // draft's fork point as common ancestor. Item fields merge independently;
  // when both sides changed the same field, the local value wins and the
  // conflict is reported. Returns { pulled, conflicts }.
  _mergeIntoDraft(newBase) {
    const fork = this._fork || { items: this.base.items, config: this.base.config };
    const report = { pulled: 0, conflicts: [] };
    const eq = (a, b) => (a ?? null) === (b ?? null);
    const sameItem = (a, b) => serializeItem(a) === serializeItem(b);
    const posEq = (a, b) => eq(a && a.x, b && b.x) && eq(a && a.y, b && b.y);

    const merged = {};
    const ids = new Set([
      ...Object.keys(fork.items), ...Object.keys(this.items), ...Object.keys(newBase.items),
    ]);
    for (const id of ids) {
      const f = fork.items[id] || null;
      const l = this.items[id] || null;
      const r = newBase.items[id] || null;
      if (l && r) {
        const out = { ...l };
        let pulled = false;
        for (const k of ['title', 'description', 'person', 'deadline', 'tag']) {
          if (eq(l[k], r[k])) continue;
          if (f && eq(l[k], f[k])) { out[k] = r[k]; pulled = true; }        // only remote changed
          else if (f && eq(r[k], f[k])) { /* only local changed — keep */ }
          else report.conflicts.push(`"${l.title || id}": ${k}`);           // both changed — local wins
        }
        if (!posEq(l, r)) {
          if (f && posEq(l, f)) { out.x = r.x; out.y = r.y; pulled = true; }
          else if (f && posEq(r, f)) { /* keep local */ }
          else report.conflicts.push(`"${l.title || id}": board position`);
        }
        if (pulled) report.pulled++;
        merged[id] = out;
      } else if (l && !r) {
        if (!f) merged[id] = l;                       // created here — keep
        else if (sameItem(l, f)) report.pulled++;     // deleted remotely, untouched here — accept
        else {
          merged[id] = l;
          report.conflicts.push(`"${l.title || id}": deleted remotely but edited here — kept`);
        }
      } else if (!l && r) {
        if (!f) { merged[id] = clone(r); report.pulled++; }   // created remotely — adopt
        else if (sameItem(r, f)) { /* deleted here, unchanged remotely — stays deleted */ }
        else {
          merged[id] = clone(r);
          report.conflicts.push(`"${r.title || id}": deleted here but edited remotely — restored`);
        }
      }
    }

    // people: ordered set, three-way (remote order, local removals + additions applied)
    const fp = fork.config.people || [], lp = this.config.people || [], rp = newBase.config.people || [];
    const removedHere = fp.filter(p => !lp.includes(p));
    const addedHere = lp.filter(p => !fp.includes(p));
    const people = [
      ...rp.filter(p => !removedHere.includes(p)),
      ...addedHere.filter(p => !rp.includes(p)),
    ];

    // tags: keyed by name, color merged field-wise (local change wins on conflict)
    const byName = list => Object.fromEntries((list || []).map(t => [t.name, t]));
    const fT = byName(fork.config.tags), lT = byName(this.config.tags), rT = byName(newBase.config.tags);
    const tags = [];
    for (const rt of newBase.config.tags || []) {
      const ft = fT[rt.name], lt = lT[rt.name];
      if (!lt && ft && eq(ft.color, rt.color)) continue;   // removed here, unchanged remotely
      if (lt && !eq(lt.color, rt.color) && (!ft || !eq(lt.color, ft.color))) tags.push({ ...lt });
      else tags.push({ ...rt });
    }
    for (const lt of this.config.tags || []) {
      if (!rT[lt.name] && !fT[lt.name] && !tags.some(t => t.name === lt.name)) tags.push({ ...lt }); // added here
    }
    if (serializeConfig({ people, tags }) !== serializeConfig(this.config)) report.pulled++;

    this.items = merged;
    this.config = { people, tags };
    this._setBase(newBase);
    this._draftBaseSha = newBase.sha;
    this._fork = { items: clone(newBase.items), config: clone(newBase.config) };
    if (!this.changes().length) {
      lsDel(this.key('draft'));
      this.resetToBase();
    } else {
      this._persistDraftNow();
    }
    this.emit('change', { source: 'merge' });
    return report;
  },

  async refresh() {
    if (this.demo || !this.configured() || this.syncing) return;
    this.syncing = true;
    this.lastError = null;
    this.emit('change', { source: 'sync' });
    try {
      const gh = this.client();
      const head = await gh.getHead();
      if (!head) {
        // repo exists but the branch has no commits yet
        this.base = parseFiles(null, {});
        lsDel(this.key('cache'));
        if (!this._hasDraft) this.resetToBase();
      } else if (head.sha !== this.base.sha) {
        const newBase = await this._fetchBase(gh, head);
        if (this._hasDraft) {
          const report = this._mergeIntoDraft(newBase);
          if (report.pulled || report.conflicts.length) this.emit('merged', report);
        } else {
          this._setBase(newBase);
          this.resetToBase();
        }
      }
      this.lastSync = Date.now();
    } catch (e) {
      this.lastError = e;
      this.emit('error', e);
    } finally {
      this.syncing = false;
      this.emit('change', { source: 'sync' });
    }
  },

  // Another tab of this browser wrote a newer draft/cache to localStorage —
  // adopt it (callers only do this while the tab is hidden, so we never
  // clobber typing in progress).
  adoptExternal() {
    if (this.saving || this.syncing) return;
    const cache = this.demo ? null : lsGet(this.key('cache'));
    if (cache && cache.files && cache.sha !== this.base.sha) {
      this.base = parseFiles(cache.sha, cache.files);
    }
    const draft = lsGet(this.key('draft'));
    if (draft && draft.items) {
      this.items = draft.items;
      this.config = draft.config || { people: [], tags: [] };
      this.pendingImages = draft.pendingImages || {};
      this._draftBaseSha = draft.baseSha ?? null;
      this._fork = draft.fork || { items: clone(this.base.items), config: clone(this.base.config) };
      this._hasDraft = true;
    } else {
      this.resetToBase();
    }
    this.emit('change', { source: 'external' });
  },

  // ----- save -----

  // Save = pull + merge + commit. Remote commits made since the draft forked
  // are merged in first, so a save never reverts other people's work; if
  // someone pushes in the tiny window between our pull and our ref update,
  // GitHub rejects the fast-forward and we pull/merge/retry once.
  async save() {
    if (this.demo) throw new GHError('Demo mode: open Settings and configure your own repository to save.', 'demo');
    if (!this.configured()) throw new GHError('Configure the GitHub repository in Settings first.', 'config');
    if (!this.settings.token) throw new GHError('Add a GitHub token in Settings to be able to save.', 'no-token');
    if (!this.changes().length) return { nothing: true };

    this.saving = true;
    this.emit('change', { source: 'save' });
    try {
      const gh = this.client();
      const pullMerge = async () => {
        const head = await gh.getHead();
        if (head && head.sha !== this._draftBaseSha) {
          const report = this._mergeIntoDraft(await this._fetchBase(gh, head));
          if (report.pulled || report.conflicts.length) this.emit('merged', report);
        }
        return head;
      };

      let head = await pullMerge();
      let changes = this.changes();
      if (!changes.length) return { nothing: true }; // remote already contained our edits

      let res;
      try {
        res = await gh.commitFiles({ message: commitMessage(this.base, changes), parent: head, changes });
      } catch (e) {
        if (e.code !== 'conflict') throw e;
        head = await pullMerge();
        changes = this.changes();
        if (!changes.length) return { nothing: true };
        res = await gh.commitFiles({ message: commitMessage(this.base, changes), parent: head, changes });
      }

      const files = { ...this.base.files };
      for (const c of changes) {
        if (c.delete) delete files[c.path];
        else if (c.text != null) files[c.path] = { sha: 'local:' + res.sha, text: c.text };
      }
      this.base = parseFiles(res.sha, files);
      this.pendingImages = {};
      this._hasDraft = false;
      this._draftBaseSha = res.sha;
      this._fork = null;
      lsSet(this.key('cache'), { sha: res.sha, files });
      lsDel(this.key('draft'));
      return { sha: res.sha, count: changes.length };
    } finally {
      this.saving = false;
      this.emit('change', { source: 'save' });
    }
  },

  discardDraft() {
    lsDel(this.key('draft'));
    this.resetToBase();
    this.emit('change');
  },
};

store._persistDraft = debounce(() => store._persistDraftNow(), 250);
