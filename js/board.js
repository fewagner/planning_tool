// board.js — the whiteboard: an infinite pan/zoom canvas. Click an empty spot
// to add an item there, drag cards to move them, click a card to edit it.
// Items without coordinates wait in the tray at the bottom.
//
// Besides item cards the board holds decorations (stored in data/board/):
// draggable text boxes and shapes (rectangle / ellipse / line) with colors
// incl. transparency. A tool palette draws them; clicking one selects it and
// shows a style panel; double-click edits text; handles resize/reshape.

import { store } from './store.js';
import { openEditor } from './editor.js';
import { showPopover, ghostDrag, trayChipDrag, itemCardHtml, isPopoverOpen, flagsFor } from './ui.js';
import { clamp, esc, fmtDate, isOverdue, lsGet, lsSet, debounce } from './util.js';

const MIN_Z = 0.15, MAX_Z = 4;
const SVG_NS = 'http://www.w3.org/2000/svg';

let root, vp, canvas, decoLayer, itemLayer, trayEl, trayChips, toolsEl, panel;
let panX = 0, panY = 0, z = 1;
let viewRestored = false;
const pointers = new Map();
let pinch = null;
let panSession = null;

let tool = null;          // null | 'text' | 'rect' | 'ellipse' | 'line'
let selectedId = null;
let editingId = null;     // text box currently in contenteditable mode
let lastStroke = '#4f8cff';
let lastFill = '#4f8cff33';

const R = v => Math.round(v);

const saveView = debounce(() => {
  lsSet(store.key('boardview'), { panX, panY, z });
}, 400);

const saveStyle = debounce(() => {
  lsSet(store.key('decostyle'), { stroke: lastStroke, fill: lastFill });
}, 400);

function apply(persist = true) {
  canvas.style.transform = `translate(${panX}px, ${panY}px) scale(${z})`;
  vp.style.backgroundSize = `${24 * z}px ${24 * z}px`;
  vp.style.backgroundPosition = `${panX}px ${panY}px`;
  positionPanel();
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
  const pts = [];
  for (const i of Object.values(store.items)) {
    if (i.x != null) { pts.push([i.x - 100, i.y - 70], [i.x + 100, i.y + 70]); }
  }
  for (const b of Object.values(store.board)) {
    pts.push([b.x, b.y]);
    if (b.x2 != null) pts.push([b.x2, b.y2]);
    if (b.w != null) pts.push([b.x + b.w, b.y + b.h]);
    if (b.type === 'text') pts.push([b.x + 220, b.y + 60]);
  }
  if (!pts.length) {
    z = 1;
    panX = r.width / 2;
    panY = r.height / 2;
    apply();
    return;
  }
  const xs = pts.map(p => p[0]), ys = pts.map(p => p[1]);
  const minX = Math.min(...xs) - 60, maxX = Math.max(...xs) + 60;
  const minY = Math.min(...ys) - 50, maxY = Math.max(...ys) + 50;
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
        <div class="board-canvas">
          <div class="deco-layer"></div>
          <div class="item-layer"></div>
        </div>
      </div>
      <div class="canvas-hint">Click an empty spot to add an item · drag to pan · scroll or pinch to zoom</div>
      <div class="board-tools">
        <button data-tool="text" title="Text box">T</button>
        <button data-tool="rect" title="Rectangle (drag to draw)">▭</button>
        <button data-tool="ellipse" title="Ellipse (drag to draw)">◯</button>
        <button data-tool="line" title="Line (drag to draw)">╱</button>
      </div>
      <div class="zoombar">
        <button data-z="in" title="Zoom in">＋</button>
        <button data-z="out" title="Zoom out">−</button>
        <button data-z="fit" title="Fit everything">⛶</button>
      </div>
      <div class="tray" hidden>
        <div class="tray-label">No position</div>
        <div class="tray-chips"></div>
      </div>`;
    vp = root.querySelector('.board-viewport');
    canvas = root.querySelector('.board-canvas');
    decoLayer = root.querySelector('.deco-layer');
    itemLayer = root.querySelector('.item-layer');
    trayEl = root.querySelector('.tray');
    trayChips = root.querySelector('.tray-chips');
    toolsEl = root.querySelector('.board-tools');
    buildPanel();

    const saved = lsGet(store.key('boardview'));
    if (saved && typeof saved.z === 'number') {
      ({ panX, panY, z } = saved);
      viewRestored = true;
    }
    const style = lsGet(store.key('decostyle'));
    if (style && style.stroke) ({ stroke: lastStroke, fill: lastFill } = { fill: '', ...style });

    toolsEl.addEventListener('click', e => {
      const b = e.target.closest('button');
      if (b) setTool(tool === b.dataset.tool ? null : b.dataset.tool);
    });

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
      if (tool) {
        try { vp.setPointerCapture(e.pointerId); } catch { }
        startDraw(e);
        return;
      }
      if (e.target.closest('.board-item, .deco, .deco-handle')) return;
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

    window.addEventListener('keydown', e => {
      if (root.hidden) return;
      const inField = e.target.closest && e.target.closest('input, textarea, select, [contenteditable="true"]');
      if ((e.key === 'Delete' || e.key === 'Backspace') && selectedId && !inField) {
        e.preventDefault();
        store.deleteBoardEl(selectedId);
        selectedId = null;
      } else if (e.key === 'Escape' && !inField) {
        if (tool) setTool(null);
        else if (selectedId) { selectedId = null; board.render(); }
      }
    });

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
    if (editingId) return; // don't yank the contenteditable out from under the user
    apply(false);

    const dfrag = document.createDocumentFragment();
    if (selectedId && !store.board[selectedId]) selectedId = null;
    for (const el of Object.values(store.board).sort((a, b) => (a.id < b.id ? -1 : 1))) {
      const node = buildDecoNode(el);
      attachDeco(node, el);
      if (el.id === selectedId) node.classList.add('selected');
      dfrag.appendChild(node);
    }
    if (selectedId) addHandles(dfrag, store.board[selectedId]);
    decoLayer.replaceChildren(dfrag);

    const frag = document.createDocumentFragment();
    const unplaced = [];
    for (const it of Object.values(store.items)) {
      if (it.x == null) { unplaced.push(it); continue; }
      frag.appendChild(makeCard(it));
    }
    itemLayer.replaceChildren(frag);
    renderTray(unplaced);
    fillPanel();
    positionPanel();
  },
};

// ----- pan / pinch -----

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
  if (selectedId) {
    selectedId = null;
    board.render();
    return;
  }
  const pt = toCanvas(e.clientX, e.clientY);
  showPopover({
    x: e.clientX, y: e.clientY,
    onSubmit(title) {
      store.newItem({ title, x: R(pt.x), y: R(pt.y) });
    },
  });
}

// ----- item cards -----

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
        store.updateItem(it.id, { x: R(it.x), y: R(it.y) }, 'board-drag');
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
        store.updateItem(it.id, { x: R(pt.x), y: R(pt.y) });
      },
    });
    trayChips.appendChild(chip);
  }
}

// ----- decorations: nodes -----

function buildDecoNode(el) {
  let node;
  if (el.type === 'line') {
    node = document.createElementNS(SVG_NS, 'svg');
    node.classList.add('deco', 'deco-line');
    const hit = document.createElementNS(SVG_NS, 'line');
    hit.setAttribute('class', 'line-hit');
    const vis = document.createElementNS(SVG_NS, 'line');
    vis.setAttribute('class', 'line-vis');
    node.append(hit, vis);
  } else {
    node = document.createElement('div');
    node.className = 'deco ' + (el.type === 'text' ? 'deco-text' : 'deco-shape');
    if (el.type === 'text') node.textContent = el.text || 'Text';
  }
  node.dataset.id = el.id;
  styleDeco(node, el);
  return node;
}

function styleDeco(node, el) {
  if (el.type === 'text') {
    node.style.left = el.x + 'px';
    node.style.top = el.y + 'px';
    node.style.fontSize = (el.size || 20) + 'px';
    node.style.color = el.color || 'var(--text)';
    node.style.transform = el.rot ? `rotate(${el.rot}deg)` : '';
  } else if (el.type === 'rect' || el.type === 'ellipse') {
    node.style.left = el.x + 'px';
    node.style.top = el.y + 'px';
    node.style.width = (el.w || 100) + 'px';
    node.style.height = (el.h || 100) + 'px';
    node.style.border = `${el.size || 3}px solid ${el.color || '#4f8cff'}`;
    node.style.background = el.fill || 'transparent';
    node.style.borderRadius = el.type === 'ellipse' ? '50%' : '10px';
    node.style.transform = el.rot ? `rotate(${el.rot}deg)` : '';
  } else if (el.type === 'line') {
    const x2 = el.x2 ?? el.x + 100, y2 = el.y2 ?? el.y;
    const x = Math.min(el.x, x2), y = Math.min(el.y, y2);
    node.style.left = x + 'px';
    node.style.top = y + 'px';
    node.setAttribute('width', Math.max(2, Math.abs(x2 - el.x)));
    node.setAttribute('height', Math.max(2, Math.abs(y2 - el.y)));
    for (const ln of node.querySelectorAll('line')) {
      ln.setAttribute('x1', el.x - x);
      ln.setAttribute('y1', el.y - y);
      ln.setAttribute('x2', x2 - x);
      ln.setAttribute('y2', y2 - y);
    }
    const vis = node.querySelector('.line-vis');
    vis.setAttribute('stroke', el.color || '#4f8cff');
    vis.setAttribute('stroke-width', el.size || 4);
  }
}

function attachDeco(node, el) {
  node.addEventListener('pointerdown', e => {
    if (e.button !== undefined && e.button !== 0 && e.pointerType === 'mouse') return;
    if (node.isContentEditable) return;
    e.stopPropagation();
    try { node.setPointerCapture(e.pointerId); } catch { }
    const s = { x: e.clientX, y: e.clientY, ox: el.x, oy: el.y, ox2: el.x2, oy2: el.y2 };
    let moved = false;

    const move = ev => {
      const dx = (ev.clientX - s.x) / z, dy = (ev.clientY - s.y) / z;
      if (!moved && Math.hypot(ev.clientX - s.x, ev.clientY - s.y) > 5) moved = true;
      if (moved) {
        el.x = s.ox + dx;
        el.y = s.oy + dy;
        if (el.x2 != null) { el.x2 = s.ox2 + dx; el.y2 = s.oy2 + dy; }
        styleDeco(node, el);
        positionHandles();
        positionPanel();
      }
    };
    const up = ev => {
      node.removeEventListener('pointermove', move);
      node.removeEventListener('pointerup', up);
      node.removeEventListener('pointercancel', up);
      if (moved) {
        const patch = { x: R(el.x), y: R(el.y) };
        if (el.x2 != null) { patch.x2 = R(el.x2); patch.y2 = R(el.y2); }
        store.updateBoardEl(el.id, patch, 'board-drag');
      } else if (ev.type === 'pointerup' && selectedId !== el.id) {
        selectedId = el.id;
        board.render();
      }
    };
    node.addEventListener('pointermove', move);
    node.addEventListener('pointerup', up);
    node.addEventListener('pointercancel', up);
  });
  node.addEventListener('dblclick', () => {
    if (el.type === 'text') startTextEdit(el.id);
  });
}

// ----- decorations: selection handles -----

let handleNodes = [];

// rotate point (px,py) around (cx,cy) by deg
function rotPoint(px, py, cx, cy, deg) {
  const a = deg * Math.PI / 180;
  const dx = px - cx, dy = py - cy;
  return [cx + dx * Math.cos(a) - dy * Math.sin(a), cy + dx * Math.sin(a) + dy * Math.cos(a)];
}

// the resize handle sits on the element's actual (rotated) bottom-right corner
function seHandlePos(el) {
  const w = el.w || 100, h = el.h || 100;
  return rotPoint(el.x + w, el.y + h, el.x + w / 2, el.y + h / 2, el.rot || 0);
}

function addHandles(frag, el) {
  handleNodes = [];
  const mk = (cx, cy, kind) => {
    const h = document.createElement('div');
    h.className = 'deco-handle';
    h.style.left = cx + 'px';
    h.style.top = cy + 'px';
    attachHandleDrag(h, el, kind);
    handleNodes.push({ node: h, kind });
    frag.appendChild(h);
  };
  if (el.type === 'rect' || el.type === 'ellipse') mk(...seHandlePos(el), 'se');
  else if (el.type === 'line') { mk(el.x, el.y, 'a'); mk(el.x2 ?? el.x + 100, el.y2 ?? el.y, 'b'); }
}

function positionHandles() {
  const el = selectedId && store.board[selectedId];
  if (!el) return;
  for (const { node, kind } of handleNodes) {
    if (kind === 'se') {
      const [hx, hy] = seHandlePos(el);
      node.style.left = hx + 'px';
      node.style.top = hy + 'px';
    }
    else if (kind === 'a') { node.style.left = el.x + 'px'; node.style.top = el.y + 'px'; }
    else if (kind === 'b') { node.style.left = el.x2 + 'px'; node.style.top = el.y2 + 'px'; }
  }
}

function attachHandleDrag(h, el, kind) {
  h.addEventListener('pointerdown', e => {
    e.stopPropagation();
    try { h.setPointerCapture(e.pointerId); } catch { }
    const s = { x: e.clientX, y: e.clientY, ox: el.x, oy: el.y, ox2: el.x2, oy2: el.y2, ow: el.w, oh: el.h };
    const main = decoLayer.querySelector(`[data-id="${CSS.escape(el.id)}"]`);
    const move = ev => {
      const dx = (ev.clientX - s.x) / z, dy = (ev.clientY - s.y) / z;
      if (kind === 'se') {
        // map the screen delta into the element's rotated frame
        const a = -(el.rot || 0) * Math.PI / 180;
        const rdx = dx * Math.cos(a) - dy * Math.sin(a);
        const rdy = dx * Math.sin(a) + dy * Math.cos(a);
        el.w = Math.max(24, s.ow + rdx);
        el.h = Math.max(24, s.oh + rdy);
      } else if (kind === 'a') {
        el.x = s.ox + dx;
        el.y = s.oy + dy;
      } else if (kind === 'b') {
        el.x2 = s.ox2 + dx;
        el.y2 = s.oy2 + dy;
      }
      if (main) styleDeco(main, el);
      positionHandles();
      positionPanel();
    };
    const up = () => {
      h.removeEventListener('pointermove', move);
      h.removeEventListener('pointerup', up);
      h.removeEventListener('pointercancel', up);
      const patch = kind === 'se'
        ? { w: R(el.w), h: R(el.h) }
        : kind === 'a' ? { x: R(el.x), y: R(el.y) } : { x2: R(el.x2), y2: R(el.y2) };
      store.updateBoardEl(el.id, patch, 'board-resize');
    };
    h.addEventListener('pointermove', move);
    h.addEventListener('pointerup', up);
    h.addEventListener('pointercancel', up);
  });
}

// ----- decorations: drawing tools -----

function setTool(t) {
  tool = t;
  vp.classList.toggle('drawing', !!tool);
  for (const b of toolsEl.querySelectorAll('button')) {
    b.classList.toggle('active', b.dataset.tool === tool);
  }
}

function startDraw(e) {
  const t = tool;
  const start = toCanvas(e.clientX, e.clientY);
  if (t === 'text') {
    setTool(null);
    const el = store.addBoardEl({ type: 'text', text: 'Text', x: R(start.x), y: R(start.y), size: 20 });
    selectedId = el.id;
    board.render();
    requestAnimationFrame(() => startTextEdit(el.id, true));
    return;
  }

  const previewEl = t === 'line'
    ? { type: 'line', x: start.x, y: start.y, x2: start.x, y2: start.y, size: 4, color: lastStroke }
    : { type: t, x: start.x, y: start.y, w: 1, h: 1, size: 3, color: lastStroke, fill: lastFill };
  let preview = null;

  const move = ev => {
    const cur = toCanvas(ev.clientX, ev.clientY);
    if (!preview) {
      preview = buildDecoNode({ ...previewEl, id: '__preview' });
      preview.classList.add('preview');
      decoLayer.appendChild(preview);
    }
    if (t === 'line') {
      previewEl.x2 = cur.x;
      previewEl.y2 = cur.y;
    } else {
      previewEl.x = Math.min(start.x, cur.x);
      previewEl.y = Math.min(start.y, cur.y);
      previewEl.w = Math.abs(cur.x - start.x);
      previewEl.h = Math.abs(cur.y - start.y);
    }
    styleDeco(preview, previewEl);
  };
  const up = ev => {
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', up);
    if (preview) preview.remove();
    const cur = toCanvas(ev.clientX, ev.clientY);
    setTool(null);
    let el;
    if (t === 'line') {
      if (Math.hypot(cur.x - start.x, cur.y - start.y) < 8) { cur.x = start.x + 160; cur.y = start.y; }
      el = store.addBoardEl({ type: 'line', x: R(start.x), y: R(start.y), x2: R(cur.x), y2: R(cur.y), size: 4, color: lastStroke });
    } else {
      let x = Math.min(start.x, cur.x), y = Math.min(start.y, cur.y);
      let w = Math.abs(cur.x - start.x), h = Math.abs(cur.y - start.y);
      if (w < 12 || h < 12) { x = start.x; y = start.y; w = 200; h = 130; }
      el = store.addBoardEl({ type: t, x: R(x), y: R(y), w: R(w), h: R(h), size: 3, color: lastStroke, fill: lastFill });
    }
    selectedId = el.id;
    board.render();
  };
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
}

// ----- decorations: text editing -----

function startTextEdit(id, selectAll = false) {
  const node = decoLayer.querySelector(`[data-id="${CSS.escape(id)}"]`);
  const el = store.board[id];
  if (!node || !el || el.type !== 'text') return;
  editingId = id;
  node.contentEditable = 'true';
  node.classList.add('editing');
  node.focus();
  if (selectAll) {
    const range = document.createRange();
    range.selectNodeContents(node);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
  }
  const finish = () => {
    editingId = null;
    node.contentEditable = 'false';
    node.classList.remove('editing');
    const text = node.innerText.replace(/\u00A0/g, ' ').replace(/\s+$/, '');
    if (!text.trim()) {
      store.deleteBoardEl(id);
      if (selectedId === id) selectedId = null;
    } else {
      store.updateBoardEl(id, { text }, 'board-text');
    }
  };
  node.addEventListener('blur', finish, { once: true });
  node.addEventListener('keydown', ev => {
    if (ev.key === 'Escape') { ev.stopPropagation(); node.blur(); }
  });
}

// ----- decorations: style panel -----

const splitColor = (c, defHex) => {
  const m = /^#([0-9a-f]{6})([0-9a-f]{2})?$/i.exec(c || '');
  if (!m) return { hex: defHex, a: 100 };
  return { hex: '#' + m[1], a: m[2] ? Math.round(parseInt(m[2], 16) / 255 * 100) : 100 };
};
const joinColor = (hex, a) => a >= 100 ? hex : hex + Math.round(a / 100 * 255).toString(16).padStart(2, '0');

function buildPanel() {
  panel = document.createElement('div');
  panel.className = 'deco-panel';
  panel.hidden = true;
  panel.innerHTML = `
    <div class="dp-row">
      <span class="dp-colorlabel">Color</span>
      <input type="color" class="dp-color">
      <input type="range" class="dp-alpha" min="10" max="100" title="Opacity">
    </div>
    <div class="dp-row dp-fillrow">
      <span>Fill</span>
      <input type="color" class="dp-fill">
      <input type="range" class="dp-fillalpha" min="0" max="100" title="Fill opacity (0 = none)">
    </div>
    <div class="dp-row dp-rotrow">
      <span title="Rotation">↻</span>
      <input type="range" class="dp-rot" min="0" max="359" step="1" title="Rotate">
      <span class="dp-rotlabel"></span>
    </div>
    <div class="dp-row">
      <button class="mini-btn dp-smaller" title="Smaller">−</button>
      <span class="dp-sizelabel"></span>
      <button class="mini-btn dp-bigger" title="Bigger">＋</button>
      <button class="mini-btn dp-edit" title="Edit text">✎</button>
      <button class="mini-btn dp-del" title="Delete (Del)">🗑</button>
    </div>`;
  panel.addEventListener('pointerdown', e => e.stopPropagation());
  root.appendChild(panel);

  const $ = s => panel.querySelector(s);
  const applyStroke = () => {
    const el = store.board[selectedId];
    if (!el) return;
    const color = joinColor($('.dp-color').value, +$('.dp-alpha').value);
    if (el.type !== 'text') lastStroke = color;
    saveStyle();
    panelFillGuard = true;
    store.updateBoardEl(selectedId, { color }, 'deco-panel');
    panelFillGuard = false;
  };
  const applyFill = () => {
    const el = store.board[selectedId];
    if (!el) return;
    const a = +$('.dp-fillalpha').value;
    const fill = a === 0 ? '' : joinColor($('.dp-fill').value, a);
    lastFill = fill;
    saveStyle();
    panelFillGuard = true;
    store.updateBoardEl(selectedId, { fill }, 'deco-panel');
    panelFillGuard = false;
  };
  $('.dp-color').addEventListener('input', applyStroke);
  $('.dp-alpha').addEventListener('input', applyStroke);
  $('.dp-fill').addEventListener('input', applyFill);
  $('.dp-fillalpha').addEventListener('input', applyFill);
  $('.dp-rot').addEventListener('input', () => {
    const el = store.board[selectedId];
    if (!el) return;
    const rot = +$('.dp-rot').value || 0;
    $('.dp-rotlabel').textContent = rot + '°';
    panelFillGuard = true;
    store.updateBoardEl(selectedId, { rot }, 'deco-panel');
    panelFillGuard = false;
  });
  $('.dp-rot').addEventListener('dblclick', () => {
    // quick reset to 0°
    const el = store.board[selectedId];
    if (!el) return;
    $('.dp-rot').value = 0;
    $('.dp-rotlabel').textContent = '0°';
    panelFillGuard = true;
    store.updateBoardEl(selectedId, { rot: 0 }, 'deco-panel');
    panelFillGuard = false;
  });
  const step = dir => {
    const el = store.board[selectedId];
    if (!el) return;
    const isText = el.type === 'text';
    const cur = el.size || (isText ? 20 : 3);
    const next = clamp(cur + dir * (isText ? 2 : 1), isText ? 10 : 1, isText ? 96 : 20);
    store.updateBoardEl(selectedId, { size: next }, 'deco-panel');
  };
  $('.dp-smaller').addEventListener('click', () => step(-1));
  $('.dp-bigger').addEventListener('click', () => step(1));
  $('.dp-edit').addEventListener('click', () => startTextEdit(selectedId));
  $('.dp-del').addEventListener('click', () => {
    store.deleteBoardEl(selectedId);
    selectedId = null;
  });
}

let panelFillGuard = false;

function fillPanel() {
  const el = selectedId && store.board[selectedId];
  if (!el || panelFillGuard) return;
  const $ = s => panel.querySelector(s);
  const isText = el.type === 'text';
  const stroke = splitColor(el.color, isText ? '#888888' : '#4f8cff');
  $('.dp-colorlabel').textContent = isText ? 'Text' : el.type === 'line' ? 'Line' : 'Border';
  $('.dp-color').value = stroke.hex;
  $('.dp-alpha').value = stroke.a;
  const showFill = el.type === 'rect' || el.type === 'ellipse';
  $('.dp-fillrow').style.display = showFill ? '' : 'none';
  if (showFill) {
    const fill = splitColor(el.fill, '#4f8cff');
    $('.dp-fill').value = fill.hex;
    $('.dp-fillalpha').value = el.fill ? fill.a : 0;
  }
  $('.dp-sizelabel').textContent = String(el.size || (isText ? 20 : el.type === 'line' ? 4 : 3)) + (isText ? ' px' : '');
  $('.dp-edit').style.display = isText ? '' : 'none';
  const canRotate = el.type !== 'line'; // lines rotate via their endpoints
  $('.dp-rotrow').style.display = canRotate ? '' : 'none';
  if (canRotate) {
    $('.dp-rot').value = el.rot || 0;
    $('.dp-rotlabel').textContent = (el.rot || 0) + '°';
  }
}

function positionPanel() {
  if (!panel) return;
  const el = selectedId && store.board[selectedId];
  if (!el || editingId) { panel.hidden = true; return; }
  const node = decoLayer.querySelector(`[data-id="${CSS.escape(selectedId)}"]`);
  if (!node) { panel.hidden = true; return; }
  panel.hidden = false;
  const r = node.getBoundingClientRect();
  const rootR = root.getBoundingClientRect();
  const w = panel.offsetWidth, h = panel.offsetHeight;
  panel.style.left = clamp(r.left - rootR.left + r.width / 2 - w / 2, 8, rootR.width - w - 8) + 'px';
  panel.style.top = clamp(r.top - rootR.top - h - 10, 8, rootR.height - h - 8) + 'px';
}