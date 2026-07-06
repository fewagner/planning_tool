// board.js — the whiteboard: an infinite pan/zoom canvas. Click an empty spot
// to add an item there, drag cards to move them, click a card to edit it.
// Items without coordinates wait in the tray at the bottom.

import { store } from './store.js';
import { openEditor } from './editor.js';
import { showPopover, ghostDrag, trayChipDrag, itemCardHtml, isPopoverOpen, flagsFor } from './ui.js';
import { clamp, esc, fmtDate, isOverdue, lsGet, lsSet, debounce } from './util.js';

const MIN_Z = 0.15, MAX_Z = 4;

let root, vp, canvas, trayEl, trayChips;
let panX = 0, panY = 0, z = 1;
let viewRestored = false;
const pointers = new Map();
let pinch = null;
let panSession = null;

const saveView = debounce(() => {
  lsSet(store.key('boardview'), { panX, panY, z });
}, 400);

function apply(persist = true) {
  canvas.style.transform = `translate(${panX}px, ${panY}px) scale(${z})`;
  vp.style.backgroundSize = `${24 * z}px ${24 * z}px`;
  vp.style.backgroundPosition = `${panX}px ${panY}px`;
  if (persist) saveView();
}

function toCanvas(clientX, clientY) {
  const r = vp.getBoundingClientRect();
  return { x: (clientX - r.left - panX) / z, y: (clientY - r.top - panY) / z };
}

function zoomAt(clientX, clientY, factor) {
  const r = vp.getBoundingClientRect();
  const nz = clamp(z * factor, MIN_Z, MAX_Z);
  const px = clientX - r.left, py = clientY - r.top;
  panX = px - ((px - panX) / z) * nz;
  panY = py - ((py - panY) / z) * nz;
  z = nz;
  apply();
}

function fitView() {
  const r = vp.getBoundingClientRect();
  const placed = Object.values(store.items).filter(i => i.x != null);
  if (!placed.length) {
    z = 1;
    panX = r.width / 2;
    panY = r.height / 2;
    apply();
    return;
  }
  const xs = placed.map(i => i.x), ys = placed.map(i => i.y);
  const minX = Math.min(...xs) - 150, maxX = Math.max(...xs) + 150;
  const minY = Math.min(...ys) - 110, maxY = Math.max(...ys) + 110;
  z = clamp(Math.min(r.width / (maxX - minX), r.height / (maxY - minY)), MIN_Z, 1.4);
  panX = r.width / 2 - ((minX + maxX) / 2) * z;
  panY = r.height / 2 - ((minY + maxY) / 2) * z;
  apply();
}

export const board = {
  init(el) {
    root = el;
    root.innerHTML = `
      <div class="canvas-viewport board-viewport">
        <div class="board-canvas"></div>
      </div>
      <div class="canvas-hint">Click an empty spot to add an item · drag the background to pan · scroll or pinch to zoom</div>
      <div class="zoombar">
        <button data-z="in" title="Zoom in">＋</button>
        <button data-z="out" title="Zoom out">−</button>
        <button data-z="fit" title="Fit all items">⛶</button>
      </div>
      <div class="tray" hidden>
        <div class="tray-label">No position</div>
        <div class="tray-chips"></div>
      </div>`;
    vp = root.querySelector('.board-viewport');
    canvas = root.querySelector('.board-canvas');
    trayEl = root.querySelector('.tray');
    trayChips = root.querySelector('.tray-chips');

    const saved = lsGet(store.key('boardview'));
    if (saved && typeof saved.z === 'number') {
      ({ panX, panY, z } = saved);
      viewRestored = true;
    }

    root.querySelector('.zoombar').addEventListener('click', e => {
      const b = e.target.closest('button');
      if (!b) return;
      const r = vp.getBoundingClientRect();
      if (b.dataset.z === 'in') zoomAt(r.left + r.width / 2, r.top + r.height / 2, 1.3);
      else if (b.dataset.z === 'out') zoomAt(r.left + r.width / 2, r.top + r.height / 2, 1 / 1.3);
      else fitView();
    });

    vp.addEventListener('wheel', e => {
      e.preventDefault();
      const f = Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0016));
      zoomAt(e.clientX, e.clientY, f);
    }, { passive: false });

    vp.addEventListener('pointerdown', e => {
      if (e.button !== undefined && e.button !== 0 && e.pointerType === 'mouse') return;
      if (e.target.closest('.board-item')) return;
      try { vp.setPointerCapture(e.pointerId); } catch { }
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pointers.size === 2) {
        pinch = startPinch();
        panSession = null;
      } else if (pointers.size === 1) {
        panSession = { sx: e.clientX, sy: e.clientY, px: panX, py: panY, moved: false };
      }
    });
    vp.addEventListener('pointermove', e => {
      if (!pointers.has(e.pointerId)) return;
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pinch && pointers.size >= 2) {
        applyPinch();
      } else if (panSession) {
        const dx = e.clientX - panSession.sx, dy = e.clientY - panSession.sy;
        if (!panSession.moved && Math.hypot(dx, dy) > 4) panSession.moved = true;
        if (panSession.moved) {
          panX = panSession.px + dx;
          panY = panSession.py + dy;
          apply();
        }
      }
    });
    const endPointer = e => {
      if (!pointers.has(e.pointerId)) return;
      pointers.delete(e.pointerId);
      if (pinch && pointers.size < 2) pinch = null;
      if (panSession && pointers.size === 0) {
        const wasClick = !panSession.moved && e.type === 'pointerup';
        panSession = null;
        if (wasClick && !isPopoverOpen()) onEmptyClick(e);
      }
    };
    vp.addEventListener('pointerup', endPointer);
    vp.addEventListener('pointercancel', endPointer);

    store.on('change', () => { if (!root.hidden) this.render(); });
  },

  activate() {
    if (!viewRestored) {
      fitView();
      viewRestored = true;
    }
    this.render();
  },

  render() {
    apply(false);
    const frag = document.createDocumentFragment();
    const unplaced = [];
    for (const it of Object.values(store.items)) {
      if (it.x == null) { unplaced.push(it); continue; }
      frag.appendChild(makeCard(it));
    }
    canvas.replaceChildren(frag);
    renderTray(unplaced);
  },
};

function startPinch() {
  const [a, b] = [...pointers.values()];
  return {
    d: Math.hypot(a.x - b.x, a.y - b.y) || 1,
    cx: (a.x + b.x) / 2, cy: (a.y + b.y) / 2,
    z0: z, panX0: panX, panY0: panY,
  };
}

function applyPinch() {
  const [a, b] = [...pointers.values()];
  const d = Math.hypot(a.x - b.x, a.y - b.y) || 1;
  const cx = (a.x + b.x) / 2, cy = (a.y + b.y) / 2;
  const r = vp.getBoundingClientRect();
  const nz = clamp(pinch.z0 * (d / pinch.d), MIN_Z, MAX_Z);
  const cxCanvas = (pinch.cx - r.left - pinch.panX0) / pinch.z0;
  const cyCanvas = (pinch.cy - r.top - pinch.panY0) / pinch.z0;
  panX = (cx - r.left) - cxCanvas * nz;
  panY = (cy - r.top) - cyCanvas * nz;
  z = nz;
  apply();
}

function onEmptyClick(e) {
  const pt = toCanvas(e.clientX, e.clientY);
  showPopover({
    x: e.clientX, y: e.clientY,
    onSubmit(title) {
      store.newItem({ title, x: Math.round(pt.x), y: Math.round(pt.y) });
    },
  });
}

function makeCard(it) {
  const card = document.createElement('div');
  card.className = 'board-item item-card' + (it.status === 'done' ? ' is-done' : '');
  card.style.left = it.x + 'px';
  card.style.top = it.y + 'px';
  card.style.setProperty('--tagc', store.tagColor(it.tag));
  card.innerHTML = itemCardHtml(it, { fmtDate, isOverdue });

  card.addEventListener('pointerdown', e => {
    if (e.button !== undefined && e.button !== 0 && e.pointerType === 'mouse') return;
    e.stopPropagation();
    try { card.setPointerCapture(e.pointerId); } catch { }
    const start = { x: e.clientX, y: e.clientY, ix: it.x, iy: it.y };
    let moved = false;

    const move = ev => {
      if (!moved && Math.hypot(ev.clientX - start.x, ev.clientY - start.y) > 5) {
        moved = true;
        card.classList.add('dragging');
      }
      if (moved) {
        it.x = start.ix + (ev.clientX - start.x) / z;
        it.y = start.iy + (ev.clientY - start.y) / z;
        card.style.left = it.x + 'px';
        card.style.top = it.y + 'px';
      }
    };
    const up = ev => {
      card.removeEventListener('pointermove', move);
      card.removeEventListener('pointerup', up);
      card.removeEventListener('pointercancel', up);
      card.classList.remove('dragging');
      if (moved) {
        store.updateItem(it.id, { x: Math.round(it.x), y: Math.round(it.y) }, 'board-drag');
      } else if (ev.type === 'pointerup') {
        openEditor(it.id);
      }
    };
    card.addEventListener('pointermove', move);
    card.addEventListener('pointerup', up);
    card.addEventListener('pointercancel', up);
  });

  return card;
}

function renderTray(unplaced) {
  trayEl.hidden = unplaced.length === 0;
  if (trayEl.hidden) return;
  trayChips.replaceChildren();
  for (const it of unplaced.sort((a, b) => a.title.localeCompare(b.title))) {
    const chip = document.createElement('button');
    chip.className = 'tray-chip';
    chip.style.setProperty('--tagc', store.tagColor(it.tag));
    chip.innerHTML = `<span class="chip-dot"></span>${flagsFor(it)}${esc(it.title || 'Untitled')}`;
    trayChipDrag(chip, {
      label: it.title || 'Untitled',
      color: store.tagColor(it.tag),
      onClick: () => openEditor(it.id),
      onDrop: ev => {
        const r = vp.getBoundingClientRect();
        if (ev.clientX < r.left || ev.clientX > r.right || ev.clientY < r.top || ev.clientY > r.bottom) return;
        const pt = toCanvas(ev.clientX, ev.clientY);
        store.updateItem(it.id, { x: Math.round(pt.x), y: Math.round(pt.y) });
      },
    });
    trayChips.appendChild(chip);
  }
}
