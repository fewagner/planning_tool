// list.js — all items grouped under a headline per tag (plus "Untagged"),
// sorted by title. Clicking a row opens the editor; each section and the
// toolbar have an "add item" button.

import { store, UNTAGGED_COLOR } from './store.js';
import { openEditor } from './editor.js';
import { showPopover } from './ui.js';
import { esc, fmtDate, isOverdue } from './util.js';

let root, sectionsEl;

export const list = {
  init(el) {
    root = el;
    root.innerHTML = `
      <div class="list-wrap">
        <div class="list-toolbar">
          <h2>All items</h2>
          <button class="btn list-add">＋ Add item</button>
        </div>
        <div class="list-sections"></div>
      </div>`;
    sectionsEl = root.querySelector('.list-sections');

    root.querySelector('.list-add').addEventListener('click', e => {
      const r = e.target.getBoundingClientRect();
      showPopover({
        x: r.left, y: r.bottom,
        onSubmit(title) { openEditor(store.newItem({ title }).id); },
      });
    });

    store.on('change', () => { if (!root.hidden) this.render(); });
  },

  activate() { this.render(); },

  render() {
    const items = Object.values(store.items);
    const tagNames = store.config.tags.map(t => t.name);
    for (const it of items) {
      if (it.tag && !tagNames.includes(it.tag)) tagNames.push(it.tag);
    }

    const groups = tagNames
      .map(name => ({ name, color: store.tagColor(name), items: items.filter(i => i.tag === name) }))
      .filter(g => g.items.length);
    const untagged = items.filter(i => !i.tag);
    if (untagged.length || !groups.length) {
      groups.push({ name: null, color: UNTAGGED_COLOR, items: untagged });
    }

    sectionsEl.replaceChildren();
    if (!items.length) {
      sectionsEl.innerHTML = `<p class="list-empty">No items yet. Add one here, or click anywhere on the whiteboard or timeline.</p>`;
      return;
    }

    for (const g of groups) {
      if (!g.items.length) continue;
      const sec = document.createElement('section');
      sec.className = 'list-section';
      sec.innerHTML = `
        <h3 class="list-head" style="--tagc:${g.color}">
          <span class="chip-dot"></span>
          <span class="list-head-name">${g.name ? esc(g.name) : 'Untagged'}</span>
          <span class="list-count">${g.items.length}</span>
          <button class="mini-btn sec-add" title="Add item with this tag">＋</button>
        </h3>
        <div class="list-rows"></div>`;

      sec.querySelector('.sec-add').addEventListener('click', e => {
        const r = e.target.getBoundingClientRect();
        showPopover({
          x: r.left, y: r.bottom,
          onSubmit(title) { openEditor(store.newItem({ title, tag: g.name }).id); },
        });
      });

      const rows = sec.querySelector('.list-rows');
      for (const it of [...g.items].sort((a, b) => a.title.localeCompare(b.title))) {
        const row = document.createElement('button');
        row.className = 'list-row';
        row.style.setProperty('--tagc', store.tagColor(it.tag));
        row.innerHTML = `
          <span class="chip-dot"></span>
          <span class="row-title">${esc(it.title || 'Untitled')}</span>
          ${it.description ? '<span class="row-desc" title="Has a description">≡</span>' : ''}
          <span class="row-space"></span>
          ${it.person ? `<span class="chip chip-person">${esc(it.person)}</span>` : ''}
          ${it.deadline ? `<span class="chip chip-date${isOverdue(it.deadline) ? ' overdue' : ''}">${esc(fmtDate(it.deadline))}</span>` : ''}`;
        row.addEventListener('click', () => openEditor(it.id));
        rows.appendChild(row);
      }
      sectionsEl.appendChild(sec);
    }
  },
};
