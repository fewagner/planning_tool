// editor.js — the item detail panel (slide-over). Every field edits the store
// directly: type into the title, pick from the dropdowns, click the rendered
// description to edit it as Markdown (with image paste/upload).

import { store, UNTAGGED_COLOR } from './store.js';
import { toast } from './ui.js';
import { esc, renderMarkdown, slugify, uid, debounce } from './util.js';

let scrim, panel;
let curId = null;
let descEditing = false;

const $ = sel => panel.querySelector(sel);

export function initEditor() {
  scrim = document.createElement('div');
  scrim.className = 'editor-scrim';
  scrim.hidden = true;

  panel = document.createElement('aside');
  panel.className = 'editor';
  panel.hidden = true;
  panel.innerHTML = `
    <header class="editor-head">
      <span class="tag-dot" title="Tag color"></span>
      <input class="e-title" placeholder="Title" maxlength="200">
      <button class="icon-btn e-close" title="Close (Esc)">✕</button>
    </header>
    <div class="editor-body">
      <div class="field-grid">
        <label class="field">
          <span class="field-name">Tag</span>
          <select class="e-tag"></select>
        </label>
        <label class="field">
          <span class="field-name">Responsible</span>
          <select class="e-person"></select>
        </label>
        <label class="field">
          <span class="field-name">Deadline</span>
          <span class="date-row">
            <input type="date" class="e-deadline">
            <button class="mini-btn e-cleardate" title="Clear deadline">✕</button>
          </span>
        </label>
      </div>
      <div class="field-name desc-head">
        Description
        <span class="desc-actions">
          <button class="mini-btn e-addimg" title="Insert an image">🖼 image</button>
        </span>
        <input type="file" class="e-imgfile" accept="image/*" hidden>
      </div>
      <div class="md-view" tabindex="0" title="Click to edit"></div>
      <textarea class="md-edit" hidden spellcheck="false"
        placeholder="Write a description… Markdown supported: **bold**, lists, links. Paste images directly."></textarea>
      <div class="editor-foot">
        <span class="e-boardpos"></span>
        <button class="btn danger e-delete">Delete item</button>
      </div>
    </div>`;

  document.body.appendChild(scrim);
  document.body.appendChild(panel);

  scrim.addEventListener('pointerdown', closeEditor);
  $('.e-close').addEventListener('click', closeEditor);
  window.addEventListener('keydown', e => {
    if (e.key === 'Escape' && curId && !document.querySelector('.popover')) closeEditor();
  });

  $('.e-title').addEventListener('input', e => {
    if (curId) store.updateItem(curId, { title: e.target.value }, 'editor');
  });
  $('.e-tag').addEventListener('change', e => {
    if (!curId) return;
    store.updateItem(curId, { tag: e.target.value || null }, 'editor');
    paintTagDot();
  });
  $('.e-person').addEventListener('change', e => {
    if (curId) store.updateItem(curId, { person: e.target.value || null }, 'editor');
  });
  $('.e-deadline').addEventListener('change', e => {
    if (curId) store.updateItem(curId, { deadline: e.target.value || null }, 'editor');
  });
  $('.e-cleardate').addEventListener('click', () => {
    if (!curId) return;
    store.updateItem(curId, { deadline: null }, 'editor');
    $('.e-deadline').value = '';
  });
  $('.e-delete').addEventListener('click', () => {
    if (!curId) return;
    const it = store.items[curId];
    if (confirm(`Delete "${it?.title || 'this item'}"? This is applied to GitHub on the next save.`)) {
      store.deleteItem(curId);
      closeEditor();
    }
  });

  // description: rendered view <-> textarea
  const view = $('.md-view');
  const ta = $('.md-edit');

  view.addEventListener('click', e => {
    if (e.target.closest('a')) return; // let links work
    startDescEdit();
  });
  view.addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.target.closest('a')) startDescEdit();
  });
  // fallback for images in private repos: swap to an authenticated blob URL
  view.addEventListener('error', async e => {
    const img = e.target;
    if (!(img instanceof HTMLImageElement) || img.dataset.fbk || !store.settings.token) return;
    const path = store.resolveImagePath(img.dataset.src || '');
    if (!path) return;
    img.dataset.fbk = '1';
    try { img.src = await store.client().getFileBlobUrl(path); } catch { }
  }, true);

  const commitDesc = () => {
    if (curId) store.updateItem(curId, { description: ta.value }, 'editor');
  };
  ta.addEventListener('input', debounce(commitDesc, 350));
  ta.addEventListener('input', () => autoSize(ta));
  ta.addEventListener('blur', () => {
    commitDesc();
    descEditing = false;
    renderDesc();
  });
  ta.addEventListener('keydown', e => {
    if (e.key === 'Escape') { e.stopPropagation(); ta.blur(); }
  });
  ta.addEventListener('paste', e => {
    const files = [...(e.clipboardData?.files || [])].filter(f => /^image\//.test(f.type));
    if (files.length) {
      e.preventDefault();
      insertImageFile(files[0]);
    }
  });

  $('.e-addimg').addEventListener('click', () => $('.e-imgfile').click());
  $('.e-imgfile').addEventListener('change', e => {
    const f = e.target.files?.[0];
    if (f) insertImageFile(f);
    e.target.value = '';
  });

  store.on('change', d => {
    if (!curId) return;
    if (!store.items[curId]) { closeEditor(); return; }
    if (d?.source !== 'editor') renderFields();
  });
}

export function openEditor(id) {
  if (!store.items[id]) return;
  curId = id;
  descEditing = false;
  renderFields();
  scrim.hidden = false;
  panel.hidden = false;
  requestAnimationFrame(() => panel.classList.add('open'));
}

export function closeEditor() {
  curId = null;
  panel.classList.remove('open');
  scrim.hidden = true;
  panel.hidden = true;
}

export function editorOpenId() { return curId; }

function selectOptions(list, current, noneLabel) {
  let html = `<option value="">${esc(noneLabel)}</option>`;
  for (const v of list) {
    html += `<option value="${esc(v)}"${v === current ? ' selected' : ''}>${esc(v)}</option>`;
  }
  if (current && !list.includes(current)) {
    html += `<option value="${esc(current)}" selected>${esc(current)} (not in settings)</option>`;
  }
  return html;
}

function paintTagDot() {
  const it = store.items[curId];
  $('.tag-dot').style.background = it ? store.tagColor(it.tag) : UNTAGGED_COLOR;
}

function renderFields() {
  const it = store.items[curId];
  if (!it) return;
  const focused = document.activeElement;

  const title = $('.e-title');
  if (focused !== title) title.value = it.title;

  $('.e-tag').innerHTML = selectOptions(store.config.tags.map(t => t.name), it.tag, '— no tag —');
  $('.e-person').innerHTML = selectOptions(store.config.people, it.person, '— nobody —');

  const dl = $('.e-deadline');
  if (focused !== dl) dl.value = it.deadline || '';

  paintTagDot();

  const pos = $('.e-boardpos');
  if (it.x != null) {
    pos.innerHTML = `On whiteboard at (${Math.round(it.x)}, ${Math.round(it.y)}) <button class="mini-btn e-unplace">remove from board</button>`;
    pos.querySelector('.e-unplace').addEventListener('click', () => {
      store.updateItem(curId, { x: null, y: null }, 'editor-pos');
    });
  } else {
    pos.textContent = 'Not placed on the whiteboard yet.';
  }

  renderDesc();
}

function renderDesc() {
  const view = $('.md-view');
  const ta = $('.md-edit');
  const it = store.items[curId];
  if (!it) return;
  if (descEditing) {
    view.hidden = true;
    ta.hidden = false;
    return;
  }
  view.hidden = false;
  ta.hidden = true;
  const html = renderMarkdown(it.description, src => store.imgUrl(src));
  view.innerHTML = html || '<p class="md-empty">No description — click to add one.</p>';
}

function startDescEdit() {
  const it = store.items[curId];
  if (!it) return;
  descEditing = true;
  const ta = $('.md-edit');
  ta.value = it.description || '';
  renderDesc();
  ta.focus();
  autoSize(ta);
}

function autoSize(ta) {
  ta.style.height = 'auto';
  ta.style.height = Math.min(Math.max(ta.scrollHeight + 4, 120), window.innerHeight * 0.5) + 'px';
}

// ----- images -----

async function insertImageFile(file) {
  try {
    const { name, dataUrl } = await processImage(file);
    store.addImage(name, dataUrl);
    const md = `![${name}](../images/${name})`;
    const it = store.items[curId];
    if (!it) return;
    const ta = $('.md-edit');
    if (descEditing) {
      const s = ta.selectionStart ?? ta.value.length;
      ta.value = ta.value.slice(0, s) + (s && ta.value[s - 1] !== '\n' ? '\n' : '') + md + '\n' + ta.value.slice(s);
      store.updateItem(curId, { description: ta.value }, 'editor');
      autoSize(ta);
      ta.focus();
    } else {
      const desc = (it.description ? it.description.trimEnd() + '\n\n' : '') + md;
      store.updateItem(curId, { description: desc }, 'editor');
      renderDesc();
    }
    toast('Image added — it is uploaded when you save.', 'ok');
  } catch (e) {
    toast(e.message || 'Could not read the image.', 'err');
  }
}

const MAX_DIM = 1600;

function processImage(file) {
  return new Promise((resolve, reject) => {
    if (!/^image\//.test(file.type)) return reject(new Error('That file is not an image.'));
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('Could not read the image file.'));
    reader.onload = () => {
      const src = reader.result;
      const baseName = slugify(file.name.replace(/\.[a-z0-9]+$/i, '')) || 'img';
      const origExt = (file.name.match(/\.([a-z0-9]+)$/i)?.[1] || file.type.split('/')[1] || 'png').toLowerCase();
      if (file.type === 'image/gif' || file.type === 'image/svg+xml') {
        return resolve({ name: `${baseName}-${uid()}.${origExt}`, dataUrl: src });
      }
      const img = new Image();
      img.onerror = () => reject(new Error('Could not decode the image.'));
      img.onload = () => {
        if (Math.max(img.width, img.height) <= MAX_DIM) {
          return resolve({ name: `${baseName}-${uid()}.${origExt}`, dataUrl: src });
        }
        const k = MAX_DIM / Math.max(img.width, img.height);
        const c = document.createElement('canvas');
        c.width = Math.round(img.width * k);
        c.height = Math.round(img.height * k);
        c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
        const type = file.type === 'image/jpeg' ? 'image/jpeg' : 'image/png';
        resolve({
          name: `${baseName}-${uid()}.${type === 'image/jpeg' ? 'jpg' : 'png'}`,
          dataUrl: c.toDataURL(type, 0.85),
        });
      };
      img.src = src;
    };
    reader.readAsDataURL(file);
  });
}
