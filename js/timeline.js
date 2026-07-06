// timeline.js — horizontal, zoomable timeline. Items with a deadline sit at
// their date (drag horizontally to reschedule), clicking an empty spot adds an
// item at that date, undated items wait in the tray.

import { store } from './store.js';
import { openEditor } from './editor.js';
import { showPopover, trayChipDrag, itemCardHtml, isPopoverOpen, flagsFor } from './ui.js';
import {
  clamp, esc, fmtDate, isOverdue, lsGet, lsSet, debounce,
  DAY, EPOCH, dayFromDateStr, dateStrFromDay, todayStr, weekdayOfDay, monthName,
} from './util.js';

const MIN_K = 0.5, MAX_K = 120;
const HEADER_H = 54, LANE_H = 78, CARD_W = 150;

let root, vp, ticksEl, cardsEl, trayEl, trayChips;
let k = 18;          // px per day
let panX = 0, panY = 0;
let laneBottom = HEADER_H;
let viewRestored = false;
const pointers = new Map();
let pinch = null;
let panSession = null;
let ticksQueued = false;

const saveView = debounce(() => {
  lsSet(store.key('tlview'), { k, panX, panY });
}, 400);

function worldX(day) { return day * k; }
function dayAt(clientX) {
  const r = vp.getBoundingClientRect();
  return Math.round((clientX - r.left - panX) / k);
}

function clampPanY() {
  const r = vp.getBoundingClientRect();
  panY = clamp(panY, Math.min(0, r.height - laneBottom - 30), 0);
}

function apply(persist = true) {
  cardsEl.style.transform = `translate(${panX}px, ${panY}px)`;
  if (!ticksQueued) {
    ticksQueued = true;
    requestAnimationFrame(() => { ticksQueued = false; renderTicks(); });
  }
  if (persist) saveView();
}

function zoomAt(clientX, factor) {
  const r = vp.getBoundingClientRect();
  const nk = clamp(k * factor, MIN_K, MAX_K);
  if (nk === k) return;
  const px = clientX - r.left;
  panX = px - ((px - panX) / k) * nk;
  k = nk;
  layout();
  apply();
}

function initView() {
  const r = vp.getBoundingClientRect();
  k = 18;
  panX = r.width * 0.3 - dayFromDateStr(todayStr()) * k;
  panY = 0;
}

export const timeline = {
  init(el) {
    root = el;
    root.innerHTML = `
      <div class="canvas-viewport tl-viewport">
        <div class="tl-ticks"></div>
        <div class="tl-cards"></div>
      </div>
      <div class="canvas-hint">Click an empty spot to add an item at that date · drag a card to reschedule it</div>
      <div class="zoombar">
        <button data-z="in" title="Zoom in">＋</button>
        <button data-z="out" title="Zoom out">−</button>
        <button data-z="today" title="Jump to today">◉</button>
      </div>
      <div class="tray" hidden>
        <div class="tray-label">No deadline</div>
        <div class="tray-chips"></div>
      </div>`;
    vp = root.querySelector('.tl-viewport');
    ticksEl = root.querySelector('.tl-ticks');
    cardsEl = root.querySelector('.tl-cards');
    trayEl = root.querySelector('.tray');
    trayChips = root.querySelector('.tray-chips');

    const saved = lsGet(store.key('tlview'));
    if (saved && typeof saved.k === 'number') {
      ({ k, panX, panY } = saved);
      viewRestored = true;
    }

    root.querySelector('.zoombar').addEventListener('click', e => {
      const b = e.target.closest('button');
      if (!b) return;
      const r = vp.getBoundingClientRect();
      if (b.dataset.z === 'in') zoomAt(r.left + r.width / 2, 1.3);
      else if (b.dataset.z === 'out') zoomAt(r.left + r.width / 2, 1 / 1.3);
      else {
        panX = r.width * 0.3 - dayFromDateStr(todayStr()) * k;
        apply();
      }
    });

    vp.addEventListener('wheel', e => {
      e.preventDefault();
      if (Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
        panX -= e.deltaX;
        apply();
      } else {
        zoomAt(e.clientX, Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0016)));
      }
    }, { passive: false });

    vp.addEventListener('pointerdown', e => {
      if (e.button !== undefined && e.button !== 0 && e.pointerType === 'mouse') return;
      if (e.target.closest('.tl-item')) return;
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
          clampPanY();
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
      initView();
      viewRestored = true;
    }
    this.render();
  },

  render() {
    layout();
    apply(false);
  },
};

function startPinch() {
  const [a, b] = [...pointers.values()];
  return { d: Math.hypot(a.x - b.x, a.y - b.y) || 1, cx: (a.x + b.x) / 2, k0: k, panX0: panX };
}

function applyPinch() {
  const [a, b] = [...pointers.values()];
  const d = Math.hypot(a.x - b.x, a.y - b.y) || 1;
  const cx = (a.x + b.x) / 2;
  const r = vp.getBoundingClientRect();
  const nk = clamp(pinch.k0 * (d / pinch.d), MIN_K, MAX_K);
  const dayC = (pinch.cx - r.left - pinch.panX0) / pinch.k0;
  panX = (cx - r.left) - dayC * nk;
  k = nk;
  layout();
  apply();
}

function onEmptyClick(e) {
  const day = dayAt(e.clientX);
  showPopover({
    x: e.clientX, y: e.clientY,
    hint: `Deadline: ${fmtDate(dateStrFromDay(day), true)}`,
    onSubmit(title) {
      store.newItem({ title, deadline: dateStrFromDay(day) });
    },
  });
}

// ----- cards -----

function layout() {
  const dated = Object.values(store.items)
    .filter(i => i.deadline)
    .sort((a, b) => (a.deadline < b.deadline ? -1 : a.deadline > b.deadline ? 1 : a.title.localeCompare(b.title)));
  const undated = Object.values(store.items).filter(i => !i.deadline);

  const laneEnds = [];
  const frag = document.createDocumentFragment();
  for (const it of dated) {
    const day = dayFromDateStr(it.deadline);
    const x = worldX(day);
    let lane = laneEnds.findIndex(end => x - end >= CARD_W + 14);
    if (lane === -1) {
      lane = laneEnds.length;
      laneEnds.push(x);
    } else {
      laneEnds[lane] = x;
    }
    const top = HEADER_H + 16 + lane * LANE_H;

    const stem = document.createElement('div');
    stem.className = 'tl-stem';
    stem.style.left = x + 'px';
    stem.style.top = HEADER_H + 'px';
    stem.style.height = (top - HEADER_H) + 'px';
    stem.style.setProperty('--tagc', store.tagColor(it.tag));
    frag.appendChild(stem);

    frag.appendChild(makeCard(it, x, top));
  }
  laneBottom = HEADER_H + 16 + Math.max(1, laneEnds.length) * LANE_H;
  clampPanY();
  cardsEl.replaceChildren(frag);
  renderTray(undated);
}

function makeCard(it, x, top) {
  const card = document.createElement('div');
  card.className = 'tl-item item-card' + (it.status === 'done' ? ' is-done' : '');
  card.style.left = x + 'px';
  card.style.top = top + 'px';
  card.style.setProperty('--tagc', store.tagColor(it.tag));
  card.innerHTML = itemCardHtml(it, { fmtDate, isOverdue });

  card.addEventListener('pointerdown', e => {
    if (e.button !== undefined && e.button !== 0 && e.pointerType === 'mouse') return;
    e.stopPropagation();
    try { card.setPointerCapture(e.pointerId); } catch { }
    const startX = e.clientX;
    const day0 = dayFromDateStr(it.deadline);
    let moved = false;
    let newDay = day0;
    let bubble = null;

    const move = ev => {
      if (!moved && Math.abs(ev.clientX - startX) > 5) {
        moved = true;
        card.classList.add('dragging');
        bubble = document.createElement('div');
        bubble.className = 'drag-date';
        card.appendChild(bubble);
      }
      if (moved) {
        newDay = Math.round(day0 + (ev.clientX - startX) / k);
        card.style.left = worldX(newDay) + 'px';
        bubble.textContent = fmtDate(dateStrFromDay(newDay), true);
      }
    };
    const up = ev => {
      card.removeEventListener('pointermove', move);
      card.removeEventListener('pointerup', up);
      card.removeEventListener('pointercancel', up);
      card.classList.remove('dragging');
      bubble?.remove();
      if (moved) {
        store.updateItem(it.id, { deadline: dateStrFromDay(newDay) }, 'tl-drag');
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

function renderTray(undated) {
  trayEl.hidden = undated.length === 0;
  if (trayEl.hidden) return;
  trayChips.replaceChildren();
  for (const it of undated.sort((a, b) => a.title.localeCompare(b.title))) {
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
        store.updateItem(it.id, { deadline: dateStrFromDay(dayAt(ev.clientX)) });
      },
    });
    trayChips.appendChild(chip);
  }
}

// ----- ticks / axis -----

function monthStartsBetween(day0, day1) {
  const out = [];
  const d = new Date(EPOCH + day0 * DAY);
  d.setUTCDate(1);
  while (true) {
    const day = Math.round((Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1) - EPOCH) / DAY);
    if (day > day1) break;
    out.push({ day, y: d.getUTCFullYear(), m: d.getUTCMonth() });
    d.setUTCMonth(d.getUTCMonth() + 1);
  }
  return out;
}

function renderTicks() {
  const r = vp.getBoundingClientRect();
  if (!r.width) return;
  const day0 = Math.floor((0 - panX) / k) - 1;
  const day1 = Math.ceil((r.width - panX) / k) + 1;
  const X = day => day * k + panX;
  let html = '';

  const months = monthStartsBetween(day0 - 31, day1);

  // top bands: months (zoomed in) or years (zoomed out)
  if (k >= 7) {
    for (let i = 0; i < months.length; i++) {
      const s = months[i];
      const eDay = months[i + 1]?.day ?? day1 + 31;
      const x0 = Math.max(X(s.day), 0), x1 = Math.min(X(eDay), r.width);
      if (x1 - x0 < 46) continue;
      html += `<div class="band-lab" style="left:${x0 + 8}px">${monthName(s.m)} ${s.y}</div>`;
    }
  } else {
    const yearsSeen = new Set();
    for (const s of months) {
      if (yearsSeen.has(s.y)) continue;
      yearsSeen.add(s.y);
      const x0 = Math.max(X(Math.round((Date.UTC(s.y, 0, 1) - EPOCH) / DAY)), 0);
      html += `<div class="band-lab" style="left:${x0 + 8}px">${s.y}</div>`;
    }
  }

  // grid lines + second-row labels
  if (k >= 26) {
    for (let day = day0; day <= day1; day++) {
      const wd = weekdayOfDay(day);
      const date = new Date(EPOCH + day * DAY);
      html += `<div class="tick-line${wd === 1 ? ' strong' : ''}" style="left:${X(day)}px"></div>`;
      html += `<div class="tick-lab${wd === 0 || wd === 6 ? ' dim' : ''}" style="left:${X(day)}px">${date.getUTCDate()}</div>`;
    }
  } else if (k >= 7) {
    for (let day = day0; day <= day1; day++) {
      if (weekdayOfDay(day) !== 1) continue;
      html += `<div class="tick-line" style="left:${X(day)}px"></div>`;
      html += `<div class="tick-lab" style="left:${X(day)}px">${fmtDate(dateStrFromDay(day))}</div>`;
    }
  } else if (k >= 1.8) {
    for (const s of months) {
      if (s.day < day0) continue;
      html += `<div class="tick-line${s.m === 0 ? ' strong' : ''}" style="left:${X(s.day)}px"></div>`;
      html += `<div class="tick-lab" style="left:${X(s.day)}px">${monthName(s.m)}</div>`;
    }
  } else {
    for (const s of months) {
      if (s.day < day0) continue;
      html += `<div class="tick-line${s.m === 0 ? ' strong' : ''}" style="left:${X(s.day)}px"></div>`;
      if (s.m === 0) html += `<div class="tick-lab" style="left:${X(s.day)}px">${s.y}</div>`;
    }
  }

  // today marker
  const today = dayFromDateStr(todayStr());
  if (today >= day0 && today <= day1) {
    html += `<div class="today-line" style="left:${X(today)}px"></div>`;
    html += `<div class="today-pill" style="left:${X(today)}px">today</div>`;
  }

  ticksEl.innerHTML = html;
}
