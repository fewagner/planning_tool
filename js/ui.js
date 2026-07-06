// ui.js — small shared UI primitives: toasts, the "add item" popover, and
// pointer-based drag helpers (used instead of HTML5 drag&drop so everything
// works with touch).

import { clamp, esc } from './util.js';

// ----- toasts -----

export function toast(msg, type = 'info', ms = 3800) {
  let host = document.getElementById('toasts');
  if (!host) {
    host = document.createElement('div');
    host.id = 'toasts';
    document.body.appendChild(host);
  }
  const el = document.createElement('div');
  el.className = `toast toast-${type}`;
  el.textContent = msg;
  el.addEventListener('click', () => el.remove());
  host.appendChild(el);
  setTimeout(() => {
    el.classList.add('toast-out');
    setTimeout(() => el.remove(), 300);
  }, ms);
}

// ----- add-item popover -----

let popEl = null;
let popCloser = null;

export function closePopover() {
  if (popEl) popEl.remove();
  popEl = null;
  if (popCloser) {
    window.removeEventListener('pointerdown', popCloser, true);
    window.removeEventListener('keydown', popKeydown, true);
    popCloser = null;
  }
}

function popKeydown(e) {
  if (e.key === 'Escape') {
    e.stopPropagation();
    closePopover();
  }
}

export function isPopoverOpen() { return !!popEl; }

export function showPopover({ x, y, placeholder = 'New item title…', hint = '', onSubmit }) {
  closePopover();
  popEl = document.createElement('div');
  popEl.className = 'popover';
  popEl.innerHTML = `
    ${hint ? `<div class="popover-hint">${esc(hint)}</div>` : ''}
    <form class="popover-form">
      <input type="text" placeholder="${esc(placeholder)}" maxlength="200" autocomplete="off">
      <button type="submit" class="btn primary">Add</button>
    </form>`;
  popEl.addEventListener('pointerdown', e => e.stopPropagation());
  document.body.appendChild(popEl);

  const r = popEl.getBoundingClientRect();
  popEl.style.left = clamp(x - 20, 8, window.innerWidth - r.width - 8) + 'px';
  popEl.style.top = clamp(y + 10, 8, window.innerHeight - r.height - 8) + 'px';

  const input = popEl.querySelector('input');
  popEl.querySelector('form').addEventListener('submit', e => {
    e.preventDefault();
    const title = input.value.trim();
    closePopover();
    if (title) onSubmit(title);
  });

  popCloser = e => { if (popEl && !popEl.contains(e.target)) closePopover(); };
  setTimeout(() => {
    if (!popCloser) return;
    window.addEventListener('pointerdown', popCloser, true);
    window.addEventListener('keydown', popKeydown, true);
  }, 0);
  input.focus();
}

// ----- ghost drag (chip that follows the pointer) -----

export function ghostDrag(startEvent, { label, color, onMove, onDrop, onCancel }) {
  const g = document.createElement('div');
  g.className = 'ghost-chip';
  g.textContent = label;
  if (color) g.style.setProperty('--tagc', color);
  document.body.appendChild(g);

  const place = ev => {
    g.style.left = ev.clientX + 'px';
    g.style.top = ev.clientY + 'px';
  };
  place(startEvent);

  const move = ev => { place(ev); onMove?.(ev); };
  const finish = ev => { cleanup(); onDrop?.(ev); };
  const cancel = () => { cleanup(); onCancel?.(); };

  function cleanup() {
    g.remove();
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', finish);
    window.removeEventListener('pointercancel', cancel);
  }
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', finish);
  window.addEventListener('pointercancel', cancel);
}

// ----- tray chips: tap = click, pull up/out = drag (leaves horizontal
//       swipes to the tray's native scrolling on touch) -----

export function trayChipDrag(el, opts) {
  el.addEventListener('pointerdown', e => {
    if (e.button !== undefined && e.button !== 0) return;
    const sx = e.clientX, sy = e.clientY;
    const isTouch = e.pointerType !== 'mouse';
    let started = false, cancelled = false;

    const move = ev => {
      const dx = ev.clientX - sx, dy = ev.clientY - sy;
      if (isTouch && Math.abs(dx) > 16 && Math.abs(dx) > Math.abs(dy)) {
        cancelled = true;
        cleanup();
        return;
      }
      const go = isTouch
        ? (Math.abs(dy) > 10 && Math.abs(dy) > Math.abs(dx))
        : Math.hypot(dx, dy) > 5;
      if (go) {
        started = true;
        cleanup();
        try { el.setPointerCapture(ev.pointerId); } catch { }
        ghostDrag(ev, opts);
      }
    };
    const up = () => {
      cleanup();
      if (!started && !cancelled) opts.onClick?.();
    };
    const cancel = () => { cancelled = true; cleanup(); };

    function cleanup() {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', cancel);
    }
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', cancel);
  });
}

// ----- shared card/markup helpers -----

// Emoji markers shown before the title everywhere an item appears:
// 💬 = flagged "to discuss", ⏳/✅ = in progress / done.
export function flagsFor(item) {
  return (item.discuss ? '💬 ' : '')
    + (item.status === 'done' ? '✅ ' : item.status === 'in-progress' ? '⏳ ' : '');
}

export function itemCardHtml(item, { fmtDate, isOverdue }) {
  const meta = [];
  for (const p of item.people || []) meta.push(`<span class="chip chip-person">${esc(p)}</span>`);
  if (item.deadline) meta.push(`<span class="chip chip-date${isOverdue(item.deadline) ? ' overdue' : ''}">${esc(fmtDate(item.deadline))}</span>`);
  const flags = flagsFor(item);
  return `
    <div class="item-title">${flags ? `<span class="item-flags">${flags}</span>` : ''}${esc(item.title || 'Untitled')}</div>
    ${meta.length ? `<div class="item-meta">${meta.join('')}</div>` : ''}`;
}
