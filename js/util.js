// util.js — ids, dates, YAML subset (config + frontmatter), Markdown subset, misc helpers.
// The YAML reader/writer intentionally supports only the shapes this tool writes:
// a flat frontmatter block, and a config file with scalar lists / lists of flat objects.

export const ITEM_DIR = 'data/items/';
export const IMAGE_DIR = 'data/images/';
export const CONFIG_PATH = 'data/config.yml';

export const esc = s => String(s ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

export const uid = () => Math.random().toString(36).slice(2, 8);

export const slugify = s => String(s || '').toLowerCase().normalize('NFKD')
  .replace(/[\u0300-\u036f]/g, '')
  .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);

export const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

export const debounce = (fn, ms) => {
  let t;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
};

// ---------- dates (all math in UTC; strings are YYYY-MM-DD) ----------

export const DAY = 86400000;
export const EPOCH = Date.UTC(2024, 0, 1);
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const WDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export const todayStr = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

export const dayFromDateStr = s => {
  const [y, m, d] = s.split('-').map(Number);
  return Math.round((Date.UTC(y, m - 1, d) - EPOCH) / DAY);
};

export const dateStrFromDay = day => new Date(EPOCH + day * DAY).toISOString().slice(0, 10);

export const fmtDate = (s, withYear = false) => {
  if (!s) return '';
  const [y, m, d] = s.split('-').map(Number);
  const showYear = withYear || y !== new Date().getFullYear();
  return `${MONTHS[m - 1]} ${d}${showYear ? ` ${y}` : ''}`;
};

export const weekdayOfDay = day => new Date(EPOCH + day * DAY).getUTCDay();
export const weekdayName = day => WDAYS[weekdayOfDay(day)];
export const monthName = m => MONTHS[m];

export const isOverdue = s => !!s && s < todayStr();

// ---------- YAML subset ----------

export function yamlScalar(v) {
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  const s = String(v);
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const plainOk = /^[A-Za-z0-9À-ɏ][A-Za-z0-9À-ɏ _.,()\/'!?+-]*$/.test(s)
    && !/\s$/.test(s)
    && !/^(true|false|null|yes|no|on|off)$/i.test(s)
    && !/^[+-]?[\d.]+$/.test(s);
  return plainOk ? s : JSON.stringify(s);
}

export function parseYamlScalar(raw) {
  let s = String(raw ?? '').trim();
  if (!s || s === 'null' || s === '~') return null;
  if (s === 'true') return true;
  if (s === 'false') return false;
  if (s[0] === '"' && s.endsWith('"') && s.length > 1) {
    try { return JSON.parse(s); } catch { return s.slice(1, -1); }
  }
  if (s[0] === "'" && s.endsWith("'") && s.length > 1) return s.slice(1, -1).replace(/''/g, "'");
  if (/^[+-]?\d+(\.\d+)?$/.test(s)) return Number(s);
  return s;
}

// Parses the config shape: `key: []`, or `key:` followed by `- scalar` or
// `- key: value` items with indented `key: value` continuation lines.
export function parseYamlConfig(text) {
  const out = {};
  let key = null, obj = null;
  for (const rawLine of String(text || '').split(/\r?\n/)) {
    const trimmed = rawLine.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const indent = rawLine.match(/^ */)[0].length;
    if (indent === 0) {
      const m = trimmed.match(/^([\w-]+):\s*(.*)$/);
      if (m) { key = m[1]; obj = null; out[key] ||= []; }
      continue;
    }
    if (!key) continue;
    if (trimmed.startsWith('- ') || trimmed === '-') {
      const rest = trimmed.slice(1).trim();
      const m = rest.match(/^([\w-]+):\s*(.*)$/);
      if (m) { obj = { [m[1]]: parseYamlScalar(m[2]) }; out[key].push(obj); }
      else { obj = null; out[key].push(parseYamlScalar(rest)); }
    } else if (obj) {
      const m = trimmed.match(/^([\w-]+):\s*(.*)$/);
      if (m) obj[m[1]] = parseYamlScalar(m[2]);
    }
  }
  const cfg = { people: [], tags: [] };
  cfg.people = (out.people || []).filter(p => typeof p === 'string' && p);
  cfg.tags = (out.tags || [])
    .map(t => typeof t === 'string' ? { name: t, color: '' } : t)
    .filter(t => t && typeof t === 'object' && t.name)
    .map(t => ({ name: String(t.name), color: t.color ? String(t.color) : '' }));
  return cfg;
}

export function serializeConfig(cfg) {
  const L = [
    '# Planning data configuration.',
    '# Managed by the planning tool settings — safe to edit by hand too.',
    '',
  ];
  L.push(cfg.people.length ? 'people:' : 'people: []');
  for (const p of cfg.people) L.push(`  - ${yamlScalar(p)}`);
  L.push('');
  L.push(cfg.tags.length ? 'tags:' : 'tags: []');
  for (const t of cfg.tags) {
    L.push(`  - name: ${yamlScalar(t.name)}`);
    if (t.color) L.push(`    color: ${JSON.stringify(t.color)}`);
  }
  return L.join('\n') + '\n';
}

// ---------- item files (Markdown + frontmatter) ----------

export const STATUSES = ['in-progress', 'done']; // absent = not started

// `person: Alice` or `person: [Alice, Bob]` (also accepts a `people:` key).
export function parseNameList(raw) {
  let s = String(raw ?? '').trim();
  if (!s) return [];
  if (s.startsWith('[') && s.endsWith(']')) s = s.slice(1, -1);
  return s.split(',')
    .map(p => parseYamlScalar(p))
    .filter(p => p != null && p !== '')
    .map(String);
}

export function parseItemFile(path, text) {
  const id = path.slice(path.lastIndexOf('/') + 1).replace(/\.md$/, '');
  const item = {
    id, title: '', description: '', people: [], deadline: null, tag: null,
    status: null, discuss: false, x: null, y: null,
  };
  let body = String(text || '');
  const m = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*\r?\n?/.exec(body);
  if (m) {
    body = body.slice(m[0].length);
    for (const line of m[1].split(/\r?\n/)) {
      const km = line.match(/^([\w-]+):\s*(.*)$/);
      if (!km) continue;
      const v = parseYamlScalar(km[2]);
      switch (km[1]) {
        case 'title': item.title = v == null ? '' : String(v); break;
        case 'tag': item.tag = v == null ? null : String(v); break;
        case 'deadline': item.deadline = v == null ? null : String(v); break;
        case 'person':
        case 'people': item.people = parseNameList(km[2]); break;
        case 'status': item.status = v == null ? null : String(v).toLowerCase().replace(/[\s_]+/g, '-'); break;
        case 'discuss': item.discuss = v === true; break;
        case 'x': item.x = typeof v === 'number' && isFinite(v) ? v : null; break;
        case 'y': item.y = typeof v === 'number' && isFinite(v) ? v : null; break;
      }
    }
  }
  if (item.deadline != null && !/^\d{4}-\d{2}-\d{2}$/.test(item.deadline)) item.deadline = null;
  if (!STATUSES.includes(item.status)) item.status = null;
  if (item.x == null || item.y == null) { item.x = null; item.y = null; }
  item.description = body.replace(/^\s*\n/, '').replace(/\s+$/, '');
  return item;
}

export function serializeItem(item) {
  const L = ['---', `title: ${yamlScalar(item.title || 'Untitled')}`];
  if (item.tag) L.push(`tag: ${yamlScalar(item.tag)}`);
  const people = (item.people || []).filter(Boolean);
  if (people.length === 1) L.push(`person: ${yamlScalar(people[0])}`);
  else if (people.length > 1) L.push(`person: [${people.map(yamlScalar).join(', ')}]`);
  if (item.deadline) L.push(`deadline: ${item.deadline}`);
  if (STATUSES.includes(item.status)) L.push(`status: ${item.status}`);
  if (item.discuss) L.push('discuss: true');
  if (item.x != null && item.y != null) {
    L.push(`x: ${Math.round(item.x)}`);
    L.push(`y: ${Math.round(item.y)}`);
  }
  L.push('---');
  const desc = String(item.description || '').trim();
  return L.join('\n') + '\n' + (desc ? '\n' + desc + '\n' : '');
}

// ---------- Markdown subset renderer (escape first, then transform) ----------
// Placeholders use private-use characters \uE000/\uE001 so user text can't forge them
// (esc() has already run, and those characters never survive keyboard input).

export function renderMarkdown(md, resolveImg = s => s) {
  if (!md || !String(md).trim()) return '';
  let text = esc(String(md).replace(/\r\n/g, '\n'));
  const slots = [];
  const put = html => { slots.push(html); return `\uE000${slots.length - 1}\uE001`; };

  text = text.replace(/^```[^\n]*\n([\s\S]*?)^```[ \t]*$/gm, (_, code) => put(`<pre><code>${code}</code></pre>`));

  const inline = s => {
    s = s.replace(/`([^`\n]+)`/g, (_, c) => put(`<code>${c}</code>`));
    s = s.replace(/!\[([^\]\n]*)\]\(([^)\s]+)\)/g, (_, alt, src) => {
      const raw = src.replace(/&amp;/g, '&');
      return put(`<img src="${esc(resolveImg(raw))}" alt="${alt}" loading="lazy" data-src="${esc(raw)}">`);
    });
    s = s.replace(/\[([^\]\n]+)\]\(([^)\s]+)\)/g, (_, t, href) => {
      const raw = href.replace(/&amp;/g, '&');
      const safe = /^(https?:|mailto:)/i.test(raw) ? raw : '#';
      return put(`<a href="${esc(safe)}" target="_blank" rel="noopener">${t}</a>`);
    });
    s = s.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
    s = s.replace(/(^|[\s(])\*([^*\n]+)\*(?=[\s).,;:!?]|$)/g, '$1<em>$2</em>');
    s = s.replace(/~~([^~\n]+)~~/g, '<del>$1</del>');
    return s;
  };

  const lines = text.split('\n');
  const out = [];
  const para = [];
  const flushPara = () => {
    if (para.length) out.push(`<p>${para.map(inline).join('<br>')}</p>`);
    para.length = 0;
  };
  let i = 0;
  while (i < lines.length) {
    const t = lines[i].trim();
    if (!t) { flushPara(); i++; continue; }
    if (/^\uE000\d+\uE001$/.test(t)) { flushPara(); out.push(t); i++; continue; }
    let m;
    if ((m = t.match(/^(#{1,6})\s+(.*)$/))) {
      flushPara();
      out.push(`<h${m[1].length}>${inline(m[2])}</h${m[1].length}>`);
      i++; continue;
    }
    if (/^(-{3,}|\*{3,}|_{3,})$/.test(t)) { flushPara(); out.push('<hr>'); i++; continue; }
    if (/^[-*]\s+/.test(t)) {
      flushPara();
      const items = [];
      while (i < lines.length && /^[-*]\s+/.test(lines[i].trim())) {
        items.push(`<li>${inline(lines[i].trim().replace(/^[-*]\s+/, ''))}</li>`); i++;
      }
      out.push(`<ul>${items.join('')}</ul>`); continue;
    }
    if (/^\d+[.)]\s+/.test(t)) {
      flushPara();
      const items = [];
      while (i < lines.length && /^\d+[.)]\s+/.test(lines[i].trim())) {
        items.push(`<li>${inline(lines[i].trim().replace(/^\d+[.)]\s+/, ''))}</li>`); i++;
      }
      out.push(`<ol>${items.join('')}</ol>`); continue;
    }
    if (/^&gt;\s?/.test(t)) {
      flushPara();
      const q = [];
      while (i < lines.length && /^&gt;\s?/.test(lines[i].trim())) {
        q.push(lines[i].trim().replace(/^&gt;\s?/, '')); i++;
      }
      out.push(`<blockquote>${q.map(inline).join('<br>')}</blockquote>`); continue;
    }
    para.push(t); i++;
  }
  flushPara();

  let html = out.join('\n');
  let guard = 0;
  while (/\uE000/.test(html) && guard++ < 10) {
    html = html.replace(/\uE000(\d+)\uE001/g, (_, n) => slots[+n] ?? '');
  }
  return html;
}

// ---------- misc ----------

export function contrastOn(hex) {
  const m = String(hex || '').match(/^#?([0-9a-f]{6}|[0-9a-f]{3})$/i);
  if (!m) return '#fff';
  let h = m[1];
  if (h.length === 3) h = h.split('').map(c => c + c).join('');
  const r = parseInt(h.slice(0, 2), 16), g = parseInt(h.slice(2, 4), 16), b = parseInt(h.slice(4, 6), 16);
  return (0.299 * r + 0.587 * g + 0.114 * b) > 150 ? '#1b2430' : '#fff';
}

export function b64EncodeUtf8(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(bin);
}

export function b64DecodeUtf8(b64) {
  const bin = atob(String(b64 || '').replace(/\s/g, ''));
  const bytes = Uint8Array.from(bin, c => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

export const lsGet = k => {
  try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : null; } catch { return null; }
};
export const lsSet = (k, v) => {
  try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch { return false; }
};
export const lsDel = k => { try { localStorage.removeItem(k); } catch { } };
