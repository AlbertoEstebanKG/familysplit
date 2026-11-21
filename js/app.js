// FamilySplit — интерфейс. Без фреймворков: рендер в строки + делегирование событий.

import { t, setLang, getLang, LANGS, locale, plural, setVariant } from './i18n.js';
import {
  CATEGORIES, CURRENCIES, DEFAULT_COEFS, FAMILY_COLORS,
  live, membersOf, put, remove, removeFamily, setMeta, uid, dayDates, todayISO, merge, familyColor,
} from './model.js';
import { computeEvent, splitExpense, memberCoef, presence, rateOf, decimalsOf, MODES } from './calc.js';
import * as store from './store.js';
import * as sync from './sync.js';

const S = {
  view: 'home',   // 'home' | 'event'
  id: null,       // открытое мероприятие
  tab: 'expenses',
  sheet: null,    // { type, ... }
  draft: null,
  expanded: new Set(),
};

const $ = (sel, root = document) => root.querySelector(sel);
const doc = () => (S.id ? store.loadEvent(S.id) : null);
const myFamily = () => store.indexEntry(S.id)?.myFamily || null;
/** Режим «Друзья»: каждый участник — один человек, без семей и возрастных долей. */
const isFriends = (ev) => ev?.meta?.kind === 'friends';
const FRIEND_MODES = ['person', 'shares', 'exact'];

// ── Утилиты ──
function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function num(v) {
  const n = parseFloat(String(v ?? '').replace(/\s/g, '').replace(',', '.'));
  return Number.isFinite(n) ? n : 0;
}
export function money(v, cur, opts = {}) {
  const d = decimalsOf(cur);
  const abs = Math.abs(v);
  const s = new Intl.NumberFormat(locale(), { minimumFractionDigits: abs % 1 && d ? d : 0, maximumFractionDigits: d }).format(opts.abs ? abs : v);
  const sym = CURRENCIES[cur]?.symbol || cur;
  const sign = opts.sign && v > 0 ? '+' : '';
  return sym === '$' || sym === '€' ? `${sign}${sym}${s}` : `${sign}${s} ${sym}`;
}
function fmtDate(d, opts = { day: 'numeric', month: 'short' }) {
  if (!d) return '';
  try { return new Intl.DateTimeFormat(locale(), opts).format(d); } catch { return d.toISOString().slice(0, 10); }
}
function dayLabel(ev, i) {
  const dates = dayDates(ev.meta);
  const date = dates[i] ? ' · ' + fmtDate(dates[i]) : '';
  return t('dayN', { n: i + 1 }) + date;
}
function familyName(ev, fid) {
  const f = ev.families[fid];
  if (!f || f.del) return '—';
  return f.name || t('familyN', { n: live(ev, 'families').findIndex((x) => x.id === fid) + 1 });
}
function memberName(ev, m) {
  if (m.name) return m.name;
  const same = membersOf(ev, m.familyId).filter((x) => x.cat === m.cat);
  const idx = same.findIndex((x) => x.id === m.id) + 1;
  return t('cat.' + m.cat) + (same.length > 1 ? ' ' + idx : '');
}
function famColor(ev, fid) {
  return familyColor(ev.families[fid]?.color);
}
function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toast.t);
  toast.t = setTimeout(() => el.classList.remove('show'), 2200);
}
function confirmDialog(text, okLabel = t('delete'), danger = true) {
  return new Promise((resolve) => {
    const root = $('#dialog-root');
    root.innerHTML = `
      <div class="dialog-backdrop">
        <div class="dialog" role="alertdialog" aria-modal="true">
          <p>${esc(text)}</p>
          <div class="dialog-btns">
            <button class="btn ghost" data-r="0">${t('cancel')}</button>
            <button class="btn ${danger ? 'danger' : 'primary'}" data-r="1">${esc(okLabel)}</button>
          </div>
        </div>
      </div>`;
    root.querySelectorAll('[data-r]').forEach((b) => b.addEventListener('click', () => {
      root.innerHTML = '';
      resolve(b.dataset.r === '1');
    }));
  });
}
async function copyText(text) {
  try { await navigator.clipboard.writeText(text); toast(t('copied')); }
  catch {
    const ta = document.createElement('textarea');
    ta.value = text; document.body.appendChild(ta); ta.select();
    try { document.execCommand('copy'); toast(t('copied')); } catch { toast(text); }
    ta.remove();
  }
}
async function shareText(text, url) {
  if (navigator.share) {
    try { await navigator.share(url ? { text, url } : { text }); return; } catch (e) { if (e?.name === 'AbortError') return; }
  }
  copyText(url ? `${text}\n${url}` : text);
}
function save(ev) { store.saveEvent(ev, 'local'); }
function setPath(obj, path, value) {
  const keys = path.split('.');
  let o = obj;
  for (let i = 0; i < keys.length - 1; i++) {
    const k = keys[i];
    if (o[k] == null || typeof o[k] !== 'object') o[k] = {};
    o = o[k];
  }
  o[keys[keys.length - 1]] = value;
}

// ── Маршрутизация ──
// Маршрут храним сами: в некоторых встраиваемых окнах hash в адресе недоступен.
let currentHash = location.hash;
function go(hash) {
  currentHash = hash;
  try { if (location.hash !== hash) history.pushState(null, '', hash); } catch {}
  route();
}
async function route() {
  const h = currentHash.replace(/^#\/?/, '');
  const [kind, arg] = h.split('/');
  closeSheet(false);
  if (kind === 'e' && arg) {
    if (!store.loadEvent(arg)) {
      if (!sync.cloudEnabled()) { toast(t('notFound')); return go('#/'); }
      renderLoading();
      try {
        const r = await sync.fetchRemote(arg);
        if (!r) { toast(t('notFound')); return go('#/'); }
        store.mergeIn(r.doc, 'remote');
        store.updateIndex(arg, { rev: r.rev, openedAt: Date.now() });
      } catch { toast(t('syncError')); return go('#/'); }
    }
    S.view = 'event'; S.id = arg;
    store.updateIndex(arg, { openedAt: Date.now() });
    sync.watch(arg);
    render();
    maybeAskFamily();
    return;
  }
  if (kind === 'import' && arg) {
    try {
      const snap = await sync.decodeSnapshot(arg);
      const existed = !!store.loadEvent(snap.id);
      store.mergeIn(snap, 'local');
      toast(existed ? t('importMerged') : t('imported'));
      currentHash = '#/e/' + snap.id;
      try { history.replaceState(null, '', currentHash); } catch {}
      return route();
    } catch { toast(t('badLink')); return go('#/'); }
  }
  S.view = 'home'; S.id = null;
  sync.watch(null);
  render();
}

function maybeAskFamily() {
  const ev = doc();
  if (!ev || myFamily()) return;
  const fams = live(ev, 'families');
  if (fams.length >= 2 && !store.indexEntry(S.id)?.askedFamily) {
    store.updateIndex(S.id, { askedFamily: true });
    openSheet({ type: 'pickFamily' });
  }
}

// ── Рендер ──
function render() {
  const app = $('#app');
  document.documentElement.lang = getLang();
  const ev = S.view === 'event' ? doc() : null;
  setVariant(isFriends(ev) ? 'friends' : null);
  if (ev) app.innerHTML = renderEvent(ev);
  else { S.view = 'home'; app.innerHTML = renderHome(); }
  if (S.sheet) renderSheet();
}
function renderLoading() {
  $('#app').innerHTML = `<div class="loading"><div class="spinner"></div>${t('loading')}</div>`;
}

function langSwitch() {
  return `<div class="lang-switch" role="group" aria-label="${t('language')}">${LANGS.map((l) =>
    `<button class="${l === getLang() ? 'on' : ''}" data-a="lang" data-lang="${l}">${l.toUpperCase()}</button>`).join('')}</div>`;
}

function renderHome() {
  const events = store.listEvents();
  const cards = events.map(({ doc: ev, entry }) => {
    const r = computeEvent(ev);
    const fams = live(ev, 'families').length;
    const ppl = live(ev, 'members').length;
    const dates = dayDates(ev.meta);
    const range = dates[0] ? (dates.length > 1 ? `${fmtDate(dates[0])} – ${fmtDate(dates[dates.length - 1])}` : fmtDate(dates[0], { day: 'numeric', month: 'short', year: 'numeric' })) : '';
    let mine = '';
    if (entry.myFamily && r.families[entry.myFamily]) {
      const b = r.families[entry.myFamily].balance;
      const eps = decimalsOf(ev.meta.currency) ? 0.005 : 0.5;
      mine = Math.abs(b) < eps ? `<span class="pill ok">${t('settled')}</span>`
        : `<span class="pill ${b > 0 ? 'ok' : 'bad'}">${b > 0 ? t('youAreOwed') : t('youOwe')} ${money(b, ev.meta.currency, { abs: true })}</span>`;
    }
    return `
      <button class="event-card" data-a="open" data-id="${ev.id}">
        <div class="event-card-top">
          <div class="event-name">${esc(ev.meta.name || t('untitled'))}</div>
          <div class="event-total">${money(r.total, ev.meta.currency)}</div>
        </div>
        <div class="event-meta">${isFriends(ev) ? '🎣 ' : '👨‍👩‍👧 '}${esc(range)}${range ? ' · ' : ''}${isFriends(ev) ? '' : plural('families', fams) + ' · '}${plural('people', ppl)}</div>
        ${mine ? `<div class="event-mine">${mine}</div>` : ''}
      </button>`;
  }).join('');

  return `
    <header class="top">
      <div>
        <div class="logo">Family<span>Split</span></div>
        <div class="tagline">${t('tagline')}</div>
      </div>
      ${langSwitch()}
    </header>
    <main class="scroll home">
      ${events.length ? `<div class="section-title">${t('myEvents')}</div>${cards}` : `
        <div class="hero">
          <div class="hero-emoji">🏕️👨‍👩‍👧‍👦🍉</div>
          <h1>${t('heroTitle')}</h1>
          <ul class="hero-list">
            <li>${t('hero1')}</li><li>${t('hero2')}</li><li>${t('hero3')}</li><li>${t('hero4')}</li><li>${t('hero5')}</li>
          </ul>
        </div>`}
      <button class="btn primary big" data-a="newEvent">＋ ${t('newEvent')}</button>
      <div class="home-links">
        <button class="link" data-a="importFile">${t('importFile')}</button>
        ${events.length ? '' : `<button class="link" data-a="demo">${t('tryDemo')}</button>`}
      </div>
      <div class="cloud-note">${sync.cloudEnabled() ? '☁️ ' + t('cloudOn') : '📱 ' + t('cloudOff')}</div>
    </main>`;
}

function syncBadge(id) {
  const s = sync.getStatus(id);
  return `<span class="sync-dot ${s}" title="${t('sync.' + s)}" aria-label="${t('sync.' + s)}"></span>`;
}

function renderEvent(ev) {
  const r = computeEvent(ev);
  const tabs = [
    ['expenses', '💸', t('tab.expenses')],
    ['families', isFriends(ev) ? '🧑‍🤝‍🧑' : '👨‍👩‍👧', t('tab.families')],
    ['results', '📊', t('tab.results')],
  ];
  let body = '';
  if (S.tab === 'expenses') body = renderExpenses(ev, r);
  else if (S.tab === 'families') body = renderFamilies(ev, r);
  else body = renderResults(ev, r);
  const fab = S.tab === 'expenses' ? `<button class="fab" data-a="addExpense" aria-label="${t('addExpense')}">＋</button>`
    : S.tab === 'families' && !isFriends(ev) ? `<button class="fab" data-a="addFamily" aria-label="${t('addFamily')}">＋</button>` : '';
  return `
    <header class="top event-top">
      <button class="icon-btn" data-a="home" aria-label="${t('back')}">←</button>
      <div class="event-title">
        <div class="event-title-name">${esc(ev.meta.name || t('untitled'))} ${syncBadge(ev.id)}</div>
        <div class="event-title-sub">${money(r.total, ev.meta.currency)} · ${ev.meta.days > 1 ? plural('days', ev.meta.days) : esc(fmtDate(dayDates(ev.meta)[0], { day: 'numeric', month: 'long' }))}</div>
      </div>
      <button class="icon-btn" data-a="share" aria-label="${t('share')}">⤴</button>
      <button class="icon-btn" data-a="settings" aria-label="${t('settings')}">⚙</button>
    </header>
    <main class="scroll" id="main">${body}</main>
    ${fab}
    <nav class="bottom-nav">${tabs.map(([k, ic, label]) => `
      <button class="bnav ${S.tab === k ? 'on' : ''}" data-a="tab" data-tab="${k}">
        <span class="bnav-ic">${ic}</span><span>${label}</span>
      </button>`).join('')}
    </nav>`;
}

function modeSummary(ev, e, res) {
  if (res?.error) return `<span class="warn">⚠ ${t('err.' + res.error)}</span>`;
  const mode = t('mode.' + (e.mode || 'shares'));
  if (e.mode === 'exact') return mode;
  const n = Object.keys(res?.memberShares || {}).length;
  if (e.mode === 'family') return `${mode} · ${plural('families', Object.keys(res.shares).length)}`;
  const all = !e.parts?.length;
  return `${mode} · ${all ? t('everyone') : plural('people', n)}${e.byDays ? ' · ' + t('byDaysShort') : ''}`;
}

function renderExpenses(ev, r) {
  const fams = live(ev, 'families');
  if (!fams.length) {
    return `<div class="empty"><div class="empty-ic">👨‍👩‍👧‍👦</div>${t('emptyNoFamilies')}<br><br>
      <button class="btn primary" data-a="addFamily">＋ ${t('addFamily')}</button></div>`;
  }
  const exps = live(ev, 'expenses');
  if (!exps.length) {
    return `<div class="empty"><div class="empty-ic">🧾</div>${t('emptyExpenses')}<br><br>
      <button class="btn primary" data-a="addExpense">＋ ${t('addExpense')}</button></div>`;
  }
  const groups = new Map();
  for (const e of exps) {
    const k = e.day == null || e.day === '' ? 'all' : String(e.day);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(e);
  }
  const keys = [...groups.keys()].sort((a, b) => (a === 'all' ? -1 : b === 'all' ? 1 : a - b));
  const base = ev.meta.currency;
  const errCount = r.errors.length;
  let html = errCount ? `<div class="banner warn">⚠ ${plural('problemExpenses', errCount)}</div>` : '';
  for (const k of keys) {
    const items = groups.get(k);
    const sum = items.reduce((s, e) => s + (r.byExpense[e.id]?.error ? 0 : r.byExpense[e.id].amount), 0);
    html += `<div class="group-head"><span>${k === 'all' ? t('wholeEvent') : esc(dayLabel(ev, +k))}</span><span>${money(sum, base)}</span></div>`;
    html += items.slice().reverse().map((e) => {
      const res = r.byExpense[e.id];
      const payers = Object.keys(e.paid || {}).filter((fid) => num(e.paid[fid]) > 0 && ev.families[fid] && !ev.families[fid].del);
      const payerTxt = payers.length ? payers.map((fid) => `<i class="dot" style="background:${famColor(ev, fid)}"></i>${esc(familyName(ev, fid))}`).join(', ') : `<span class="warn">${t('noPayer')}</span>`;
      const foreign = e.cur && e.cur !== base;
      return `
        <button class="exp ${res.error ? 'has-err' : ''}" data-a="editExpense" data-id="${e.id}">
          <div class="exp-main">
            <div class="exp-title">${esc(e.title || t('expense'))}</div>
            <div class="exp-sub">${t('paidBy')}: ${payerTxt}</div>
            <div class="exp-sub">${modeSummary(ev, e, res)}</div>
          </div>
          <div class="exp-amt">
            <div>${money(num(e.amount), e.cur || base)}</div>
            ${foreign && !res.error ? `<div class="exp-conv">≈ ${money(res.amount, base)}</div>` : ''}
          </div>
        </button>`;
    }).join('');
  }
  return html + '<div class="fab-space"></div>';
}

function catBadge(ev, m) {
  const c = memberCoef(ev, m);
  return `<span class="cat cat-${m.cat}">${t('cat.' + m.cat)} · ${c}</span>`;
}

function renderFriends(ev) {
  const fams = live(ev, 'families');
  const n = ev.meta.days;
  const mine = myFamily();
  const quick = `<div class="quick-add">
      <input type="text" id="quick-name" placeholder="${t('quickAddPh')}" maxlength="40" enterkeyhint="done" autocomplete="off">
      <button class="btn primary" data-a="quickAdd">＋</button>
    </div>`;
  if (!fams.length) return quick + `<div class="empty"><div class="empty-ic">🎣</div>${t('emptyFamilies')}</div>`;
  return quick + `<div class="friends-list">${fams.map((f) => {
    const m = membersOf(ev, f.id)[0];
    const days = m && Array.isArray(m.days) && n > 1 ? m.days.filter((d) => d < n) : null;
    const partial = days && days.length < n;
    const custom = m && typeof m.coef === 'number';
    return `<button class="friend-row" data-a="editFamily" data-id="${f.id}">
      <i class="dot big" style="background:${familyColor(f.color)}"></i>
      <span class="friend-name">${esc(familyName(ev, f.id))}</span>
      ${f.id === mine ? `<span class="pill">${t('myFamily')}</span>` : ''}
      ${partial ? `<span class="days-badge">📅 ${days.map((d) => d + 1).join(', ')}</span>` : ''}
      ${custom ? `<span class="cat cat-adult">× ${m.coef}</span>` : ''}
      <span class="chev">›</span>
    </button>`;
  }).join('')}</div><div class="fab-space"></div>`;
}

function renderFamilies(ev, r) {
  if (isFriends(ev)) return renderFriends(ev);
  const fams = live(ev, 'families');
  const coefs = { ...DEFAULT_COEFS, ...ev.meta.coefs };
  const legend = `<div class="legend">${CATEGORIES.map((c) => `<span class="cat cat-${c}">${t('cat.' + c)} = ${coefs[c]}</span>`).join('')}
    <button class="link small" data-a="settings">${t('change')}</button></div>`;
  if (!fams.length) {
    return legend + `<div class="empty"><div class="empty-ic">👨‍👩‍👧‍👦</div>${t('emptyFamilies')}<br><br>
      <button class="btn primary" data-a="addFamily">＋ ${t('addFamily')}</button></div>`;
  }
  const n = ev.meta.days;
  const mine = myFamily();
  return legend + fams.map((f) => {
    const ms = membersOf(ev, f.id);
    const w = ms.reduce((s, m) => s + memberCoef(ev, m), 0);
    return `
      <button class="fam-card" data-a="editFamily" data-id="${f.id}" style="--fc:${familyColor(f.color)}">
        <div class="fam-head">
          <div class="fam-name"><i class="dot big" style="background:${familyColor(f.color)}"></i>${esc(familyName(ev, f.id))}
            ${f.id === mine ? `<span class="pill">${t('myFamily')}</span>` : ''}</div>
          <div class="fam-w">${t('sharesN', { n: +w.toFixed(2) })}</div>
        </div>
        <div class="fam-members">${ms.map((m) => {
          const partial = Array.isArray(m.days) && n > 1 && m.days.filter((d) => d < n).length < n;
          return `<div class="mrow"><span>${esc(memberName(ev, m))}</span>${catBadge(ev, m)}${partial ? `<span class="days-badge">📅 ${m.days.filter((d) => d < n).map((d) => d + 1).join(', ')}</span>` : ''}</div>`;
        }).join('') || `<div class="muted">${t('noMembers')}</div>`}</div>
      </button>`;
  }).join('') + '<div class="fab-space"></div>';
}

function renderResults(ev, r) {
  const fams = live(ev, 'families');
  const cur = ev.meta.currency;
  if (!fams.length || !live(ev, 'expenses').length) {
    return `<div class="empty"><div class="empty-ic">📊</div>${t('emptyResults')}</div>`;
  }
  const mine = myFamily();
  const eps = decimalsOf(cur) ? 0.005 : 0.5;
  let html = '';
  if (r.errors.length) html += `<div class="banner warn">⚠ ${plural('problemExpenses', r.errors.length)} — ${t('notCounted')}</div>`;

  if (mine && r.families[mine]) {
    const owe = r.transfers.filter((x) => x.from === mine);
    const get = r.transfers.filter((x) => x.to === mine);
    // показываем ровно ту сумму, что в переводах (без расхождений округления)
    const b = owe.length || get.length ? get.reduce((s, x) => s + x.amount, 0) - owe.reduce((s, x) => s + x.amount, 0) : 0;
    html += `<div class="my-card ${Math.abs(b) < eps ? 'ok' : b > 0 ? 'ok' : 'bad'}">
      <div class="my-label">${esc(familyName(ev, mine))}</div>
      <div class="my-amt">${Math.abs(b) < eps ? t('settled') + ' ✓' : (b > 0 ? t('youAreOwed') : t('youOwe')) + ' ' + money(b, cur, { abs: true })}</div>
      ${owe.map((x) => `<div class="my-line">→ ${esc(familyName(ev, x.to))}: <b>${money(x.amount, cur)}</b></div>`).join('')}
      ${get.map((x) => `<div class="my-line">← ${esc(familyName(ev, x.from))}: <b>${money(x.amount, cur)}</b></div>`).join('')}
    </div>`;
  }

  const adult = (ev.meta.coefs?.adult ?? 1);
  const perShare = r.weightSum ? r.total / r.weightSum : 0;
  html += `<div class="stats">
    <div class="stat"><div class="stat-l">${t('total')}</div><div class="stat-v">${money(r.total, cur)}</div></div>
    <div class="stat"><div class="stat-l">${t('people')}</div><div class="stat-v">${r.people}</div></div>
    <div class="stat"><div class="stat-l">${t('perAdult')}</div><div class="stat-v">${money(perShare * adult, cur)}</div></div>
  </div>`;

  html += `<div class="section-title">${t('whoPaysWhom')}</div>`;
  if (!r.transfers.length) html += `<div class="all-good">✓ ${t('allSettled')}</div>`;
  else html += r.transfers.map((x, i) => `
    <div class="transfer ${x.from === mine || x.to === mine ? 'mine' : ''}">
      <div class="tr-names"><span class="tr-from">${esc(familyName(ev, x.from))}</span><span class="tr-arrow">→</span><span class="tr-to">${esc(familyName(ev, x.to))}</span></div>
      <div class="tr-right"><div class="tr-amt">${money(x.amount, cur)}</div>
      <button class="btn small ghost" data-a="markPaid" data-i="${i}">✓ ${t('markPaid')}</button></div>
    </div>`).join('');
  html += `<button class="btn ghost wide" data-a="shareResults">📤 ${t('shareResults')}</button>`;

  html += `<div class="section-title">${t('byFamily')}</div>`;
  const maxAbs = Math.max(1, ...Object.values(r.families).map((f) => Math.abs(f.balance)));
  html += fams.map((f) => {
    const x = r.families[f.id];
    const open = S.expanded.has(f.id);
    const b = x.balance;
    const items = x.items.map((it) => ({ e: ev.expenses[it.expenseId], v: it.amount })).sort((a, b) => b.v - a.v);
    const members = Object.entries(x.members).map(([mid, v]) => ({ m: ev.members[mid], v })).filter((o) => o.m);
    return `
      <div class="bal-card">
        <button class="bal-head" data-a="toggleFam" data-id="${f.id}" aria-expanded="${open}">
          <div class="bal-name"><i class="dot" style="background:${famColor(ev, f.id)}"></i>${esc(familyName(ev, f.id))}</div>
          <div class="bal-v ${Math.abs(b) < eps ? '' : b > 0 ? 'pos' : 'neg'}">${Math.abs(b) < eps ? '0' : money(b, cur, { sign: true })}</div>
        </button>
        <div class="bal-bar"><div class="${b >= 0 ? 'pos' : 'neg'}" style="width:${Math.min(50, (Math.abs(b) / maxAbs) * 50)}%;${b >= 0 ? 'left:50%' : 'right:50%'}"></div></div>
        <div class="bal-nums"><span>${t('paid')}: <b>${money(x.paid, cur)}</b></span><span>${t('share')}: <b>${money(x.share, cur)}</b></span>${x.sent ? `<span>${t('sentLbl')}: <b>${money(x.sent, cur)}</b></span>` : ''}${x.received ? `<span>${t('receivedLbl')}: <b>${money(x.received, cur)}</b></span>` : ''}</div>
        ${open ? `<div class="bal-detail">
          ${members.length && !isFriends(ev) ? `<div class="mini-title">${t('byMember')}</div>${members.map((o) => `<div class="drow"><span>${esc(memberName(ev, o.m))}</span><span>${money(o.v, cur)}</span></div>`).join('')}` : ''}
          <div class="mini-title">${t('byExpense')}</div>
          ${items.map((o) => `<div class="drow"><span>${esc(o.e?.title || t('expense'))}</span><span>${money(o.v, cur)}</span></div>`).join('') || `<div class="muted">—</div>`}
        </div>` : ''}
      </div>`;
  }).join('');

  const pays = live(ev, 'payments');
  if (pays.length) {
    html += `<div class="section-title">${t('paymentsMade')}</div>` + pays.slice().reverse().map((p) => `
      <div class="pay-row">
        <span>${esc(familyName(ev, p.from))} → ${esc(familyName(ev, p.to))}</span>
        <span><b>${money(num(p.amount), p.cur || cur)}</b> <button class="icon-btn small" data-a="undoPayment" data-id="${p.id}" aria-label="${t('delete')}">✕</button></span>
      </div>`).join('');
  }
  html += `<button class="link center" data-a="addPayment">＋ ${t('addPayment')}</button>`;
  return html;
}

// ── Нижние листы (модальные окна) ──
function openSheet(sheet) {
  S.sheet = sheet;
  S.draft = sheet.draft || null;
  renderSheet(true);
}
function closeSheet(rerender = true) {
  if (!S.sheet) return;
  S.sheet = null; S.draft = null;
  const root = $('#sheet-root');
  root.innerHTML = '';
  document.body.classList.remove('sheet-open');
  if (rerender) render();
}
function renderSheet(first = false) {
  const root = $('#sheet-root');
  const sh = S.sheet;
  if (!sh) return;
  const fn = SHEETS[sh.type];
  if (!fn) return;
  const scroller = root.querySelector('.sheet-body');
  const top = scroller ? scroller.scrollTop : 0;
  const { title, body, footer } = fn();
  root.innerHTML = `
    <div class="sheet-backdrop ${first ? 'enter' : ''}" data-a="closeSheet"></div>
    <section class="sheet ${first ? 'enter' : ''}" role="dialog" aria-modal="true" aria-label="${esc(title)}">
      <div class="sheet-head"><h2>${esc(title)}</h2><button class="icon-btn" data-a="closeSheet" aria-label="${t('close')}">✕</button></div>
      <div class="sheet-body">${body}</div>
      ${footer ? `<div class="sheet-foot">${footer}</div>` : ''}
    </section>`;
  document.body.classList.add('sheet-open');
  const sb = root.querySelector('.sheet-body');
  if (sb) sb.scrollTop = top;
  if (first) {
    const f = root.querySelector('[autofocus]');
    if (f && !('ontouchstart' in window)) setTimeout(() => f.focus(), 50);
  }
}
function field(label, inner, hint = '') {
  return `<label class="field"><span class="field-l">${label}</span>${inner}${hint ? `<span class="hint">${hint}</span>` : ''}</label>`;
}
/** Дата мероприятия; длительность — только если включить «Несколько дней». */
function dateFields(d) {
  const multi = d.days > 1;
  const date = `<input type="date" data-bind="startDate" value="${esc(d.startDate)}">`;
  return `
    ${multi ? `<div class="row2">${field(t('startDate'), date)}${field(t('daysCount'), stepper('days', d.days, 2))}</div>`
      : field(t('date'), date)}
    <button class="link small days-toggle" data-a="toggleMultiDay">${multi ? t('oneDay') : t('severalDays')}</button>`;
}

function currencyOptions(selected, extra = []) {
  const list = [...new Set([selected, ...extra, ...Object.keys(CURRENCIES)])].filter(Boolean);
  return list.map((c) => `<option value="${c}" ${c === selected ? 'selected' : ''}>${c}</option>`).join('');
}
function stepper(bind, value, min = 1, max = 60) {
  return `<div class="stepper"><button type="button" data-a="step" data-bind="${bind}" data-d="-1" data-min="${min}" data-max="${max}">−</button>
    <input type="number" inputmode="numeric" data-bind="${bind}" data-type="int" value="${value}" min="${min}" max="${max}">
    <button type="button" data-a="step" data-bind="${bind}" data-d="1" data-min="${min}" data-max="${max}">＋</button></div>`;
}

const SHEETS = {
  newEvent() {
    const d = S.draft;
    // Шаг 1: отдельный экран выбора, кто участвует
    if (d.step === 'kind') {
      const card = (kind, ic) => `
        <button class="kind-card ${d.kind === kind ? 'on' : ''}" data-a="setKind" data-kind="${kind}">
          <span class="kind-ic">${ic}</span>
          <span class="kind-text">
            <b>${t(kind === 'friends' ? 'kindFriends' : 'kindFamilies')}</b>
            <span>${t(kind === 'friends' ? 'kindFriendsHint' : 'kindFamiliesHint')}</span>
            <small>${t(kind === 'friends' ? 'kindFriendsEx' : 'kindFamiliesEx')}</small>
          </span>
          <span class="chev">›</span>
        </button>`;
      return {
        title: t('newEvent'),
        body: `
          <p class="step-label">${t('stepOf', { n: 1, total: 2 })}</p>
          <h3 class="step-q">${t('kindQuestion')}</h3>
          <div class="kind-cards">${card('friends', '🎣')}${card('families', '👨‍👩‍👧‍👦')}</div>`,
      };
    }
    // Шаг 2: название, дата, валюта
    const isFr = d.kind === 'friends';
    return {
      title: t('newEvent'),
      body: `
        <p class="step-label">${t('stepOf', { n: 2, total: 2 })}</p>
        <div class="kind-chosen">
          <span class="kind-ic small">${isFr ? '🎣' : '👨‍👩‍👧‍👦'}</span>
          <b>${t(isFr ? 'kindFriends' : 'kindFamilies')}</b>
          <button class="link small" data-a="backToKind">${t('change')}</button>
        </div>
        ${field(t('eventName'), `<input type="text" data-bind="name" value="${esc(d.name)}" placeholder="${isFr ? t('eventNamePhFriends') : t('eventNamePh')}" maxlength="80" autofocus>`)}
        ${dateFields(d)}
        ${field(t('baseCurrency'), `<select data-bind="currency">${currencyOptions(d.currency)}</select>`, t('baseCurrencyHint'))}`,
      footer: `<button class="btn primary wide" data-a="createEvent">${t('create')}</button>`,
    };
  },

  settings() {
    const d = S.draft;
    const ev = doc();
    const used = new Set(live(ev, 'expenses').map((e) => e.cur).filter((c) => c && c !== d.currency));
    Object.keys(d.rates).forEach((c) => used.add(c));
    used.delete(d.currency);
    const rates = [...used].map((c) => `
      <div class="rate-row">
        <span class="rate-l">1 ${c} =</span>
        <input type="text" inputmode="decimal" data-bind="rates.${c}" value="${d.rates[c] ?? ''}" placeholder="?">
        <span class="rate-r">${d.currency}</span>
      </div>`).join('');
    return {
      title: t('settings'),
      body: `
        ${field(t('eventName'), `<input type="text" data-bind="name" value="${esc(d.name)}" maxlength="80">`)}
        ${dateFields(d)}
        ${field(t('baseCurrency'), `<select data-bind="currency" data-rerender="1">${currencyOptions(d.currency)}</select>`)}
        ${isFriends(ev) ? '' : `<div class="sub-title">${t('coefsTitle')}</div>
        <p class="hint">${t('coefsHint')}</p>
        <div class="coefs">${CATEGORIES.map((c) => `
          <label class="coef"><span>${t('cat.' + c)}<small>${t('catAge.' + c)}</small></span>
          <input type="text" inputmode="decimal" data-bind="coefs.${c}" value="${d.coefs[c]}"></label>`).join('')}
        </div>`}
        <div class="sub-title">${t('ratesTitle')}</div>
        ${rates || `<p class="hint">${t('ratesEmpty')}</p>`}
        <div class="rate-actions">
          <select data-bind="newRateCur"><option value="">${t('addCurrency')}…</option>${Object.keys(CURRENCIES).filter((c) => c !== d.currency && !used.has(c)).map((c) => `<option>${c}</option>`).join('')}</select>
          ${used.size ? `<button class="btn small ghost" data-a="fetchRates">↻ ${t('fetchRates')}</button>` : ''}
        </div>
        <div class="sub-title">${t('data')}</div>
        <div class="btn-col">
          <button class="btn ghost" data-a="exportJson">⬇ ${t('exportJson')}</button>
          <button class="btn ghost danger-text" data-a="deleteEvent">🗑 ${t('deleteEvent')}</button>
        </div>`,
      footer: `<button class="btn primary wide" data-a="saveSettings">${t('save')}</button>`,
    };
  },

  family() {
    const d = S.draft;
    const ev = doc();
    const n = Math.max(1, ev.meta.days | 0);
    if (isFriends(ev)) {
      const m = d.members[0];
      return {
        title: d.isNew ? t('addFamily') : t('editFamily'),
        body: `
          ${field(t('familyName'), `<input type="text" data-bind="name" value="${esc(d.name)}" placeholder="${t('familyNamePh')}" maxlength="40" ${d.isNew ? 'autofocus' : ''}>`)}
          <div class="colors">${FAMILY_COLORS.map((c) => `<button class="color ${d.color === c ? 'on' : ''}" style="background:${c}" data-a="setColor" data-c="${c}" aria-label="${c}"></button>`).join('')}</div>
          ${n > 1 ? `<div class="sub-title">${t('presentDays')}</div><div class="days-row">${Array.from({ length: n }, (_, k) => {
            const on = m.days == null || m.days.includes(k);
            return `<button class="chip ${on ? 'on' : ''}" data-a="toggleDay" data-i="0" data-day="${k}">${esc(dayLabel(ev, k))}</button>`;
          }).join('')}</div><p class="hint">${t('friendDaysHint')}</p>` : ''}
          <details class="adv" ${m.coef != null && m.coef !== '' ? 'open' : ''}><summary>${t('customCoef')}</summary>
            <input type="text" inputmode="decimal" data-bind="members.0.coef" value="${m.coef ?? ''}" placeholder="1">
            <span class="hint">${t('customCoefHint')}</span>
          </details>
          <label class="check"><input type="checkbox" data-bind="isMine" data-type="bool" ${d.isMine ? 'checked' : ''}> ${t('thisIsMyFamily')}</label>
          ${d.isNew ? '' : `<button class="btn ghost danger-text wide" data-a="deleteFamily">🗑 ${t('deleteFamily')}</button>`}`,
        footer: `<button class="btn primary wide" data-a="saveFamily">${t('save')}</button>`,
      };
    }
    const coefs = { ...DEFAULT_COEFS, ...ev.meta.coefs };
    const members = d.members.map((m, i) => `
      <div class="medit">
        <div class="medit-top">
          <input type="text" data-bind="members.${i}.name" value="${esc(m.name)}" placeholder="${t('memberNamePh')}" maxlength="40">
          <button class="icon-btn small" data-a="removeMember" data-i="${i}" aria-label="${t('delete')}">✕</button>
        </div>
        <div class="seg small">${CATEGORIES.map((c) => `<button class="${m.cat === c ? 'on' : ''}" data-a="setCat" data-i="${i}" data-cat="${c}">${t('cat.' + c)} <small>${coefs[c]}</small></button>`).join('')}</div>
        ${n > 1 ? `<div class="days-row"><span class="muted">${t('presentDays')}:</span>${Array.from({ length: n }, (_, k) => {
          const on = m.days == null || m.days.includes(k);
          return `<button class="chip tiny ${on ? 'on' : ''}" data-a="toggleDay" data-i="${i}" data-day="${k}">${k + 1}</button>`;
        }).join('')}</div>` : ''}
        <details class="adv" ${m.coef != null && m.coef !== '' ? 'open' : ''}><summary>${t('customCoef')}</summary>
          <input type="text" inputmode="decimal" data-bind="members.${i}.coef" value="${m.coef ?? ''}" placeholder="${coefs[m.cat]}">
          <span class="hint">${t('customCoefHint')}</span>
        </details>
      </div>`).join('');
    return {
      title: d.isNew ? t('addFamily') : t('editFamily'),
      body: `
        ${field(t('familyName'), `<input type="text" data-bind="name" value="${esc(d.name)}" placeholder="${t('familyNamePh')}" maxlength="40" ${d.isNew ? 'autofocus' : ''}>`)}
        <div class="colors">${FAMILY_COLORS.map((c) => `<button class="color ${d.color === c ? 'on' : ''}" style="background:${c}" data-a="setColor" data-c="${c}" aria-label="${c}"></button>`).join('')}</div>
        <div class="sub-title">${t('members')} <span class="muted">(${d.members.length})</span></div>
        ${members}
        <div class="add-members">${CATEGORIES.map((c) => `<button class="btn small ghost" data-a="addMember" data-cat="${c}">＋ ${t('cat.' + c)}</button>`).join('')}</div>
        <label class="check"><input type="checkbox" data-bind="isMine" data-type="bool" ${d.isMine ? 'checked' : ''}> ${t('thisIsMyFamily')}</label>
        ${d.isNew ? '' : `<button class="btn ghost danger-text wide" data-a="deleteFamily">🗑 ${t('deleteFamily')}</button>`}`,
      footer: `<button class="btn primary wide" data-a="saveFamily">${t('save')}</button>`,
    };
  },

  expense() {
    const d = S.draft;
    const ev = doc();
    const fams = live(ev, 'families');
    const base = ev.meta.currency;
    const n = Math.max(1, ev.meta.days | 0);
    const knownCurs = Object.keys(ev.rates || {}).filter((c) => !ev.rates[c].del);
    const needRate = d.cur !== base && !(ev.rates?.[d.cur]?.rate > 0);

    const dayChips = n > 1 || d.day != null ? `
      <div class="sub-title">${t('when')}</div>
      <div class="chips">
        <button class="chip ${d.day == null ? 'on' : ''}" data-a="setDay" data-day="">${t('wholeEvent')}</button>
        ${Array.from({ length: n }, (_, i) => `<button class="chip ${d.day === i ? 'on' : ''}" data-a="setDay" data-day="${i}">${esc(dayLabel(ev, i))}</button>`).join('')}
      </div>` : '';

    const payers = d.multiPay
      ? `<div class="pay-multi">${fams.map((f) => `
          <div class="pm-row"><span><i class="dot" style="background:${famColor(ev, f.id)}"></i>${esc(familyName(ev, f.id))}</span>
          <input type="text" inputmode="decimal" data-bind="paidMulti.${f.id}" value="${d.paidMulti[f.id] ?? ''}" placeholder="0"></div>`).join('')}
          <div class="remain" id="paid-remain"></div></div>`
      : `<div class="chips">${fams.map((f) => `<button class="chip fam ${d.payer === f.id ? 'on' : ''}" style="--fc:${famColor(ev, f.id)}" data-a="setPayer" data-id="${f.id}">${esc(familyName(ev, f.id))}</button>`).join('')}</div>`;

    const friends = isFriends(ev);
    const modes = `<div class="seg">${(friends ? FRIEND_MODES : MODES).map((m) => `<button class="${d.mode === m ? 'on' : ''}" data-a="setMode" data-mode="${m}">${t('modeShort.' + m)}</button>`).join('')}</div>
      <p class="hint">${t('modeHint.' + d.mode)}</p>`;

    let parts = '';
    if (d.mode !== 'exact' && friends) {
      const sel = new Set(d.parts);
      parts = `
        <div class="sub-title">${t('whoTakesPart')}</div>
        <div class="quick">
          <button class="chip small" data-a="partsPreset" data-p="all">${t('preset.all')}</button>
          <button class="chip small" data-a="partsPreset" data-p="none">${t('preset.none')}</button>
        </div>
        <div class="chips">${live(ev, 'members').filter((m) => ev.families[m.familyId] && !ev.families[m.familyId].del).map((m) => {
          const absent = d.day != null && presence(ev, m, { day: d.day }) === 0;
          return `<button class="chip ${sel.has(m.id) ? 'on' : ''} ${absent ? 'absent' : ''}" data-a="togglePart" data-id="${m.id}"><i class="dot" style="background:${famColor(ev, m.familyId)}"></i>${esc(familyName(ev, m.familyId))}${absent ? ' 🚫' : ''}</button>`;
        }).join('')}</div>
        ${d.day == null && n > 1 ? `<label class="check"><input type="checkbox" data-bind="byDays" data-type="bool" data-rerender="1" ${d.byDays ? 'checked' : ''}> ${t('byDays')}</label><p class="hint">${t('byDaysHint')}</p>` : ''}
        ${d.mode === 'shares' ? `<div class="weights">${d.parts.map((mid) => {
          const m = ev.members[mid]; if (!m || m.del) return '';
          return `<div class="w-row"><span>${esc(familyName(ev, m.familyId))}</span>
            <input type="text" inputmode="decimal" data-bind="weights.${mid}" value="${d.weights[mid] ?? memberCoef(ev, m)}"></div>`;
        }).join('')}</div>` : ''}`;
    } else if (d.mode !== 'exact') {
      const sel = new Set(d.parts);
      parts = `
        <div class="sub-title">${t('whoTakesPart')}</div>
        <div class="quick">
          <button class="chip small" data-a="partsPreset" data-p="all">${t('preset.all')}</button>
          <button class="chip small" data-a="partsPreset" data-p="adults">${t('preset.adults')}</button>
          <button class="chip small" data-a="partsPreset" data-p="kids">${t('preset.kids')}</button>
          <button class="chip small" data-a="partsPreset" data-p="none">${t('preset.none')}</button>
        </div>
        ${fams.map((f) => {
          const ms = membersOf(ev, f.id);
          const allOn = ms.length && ms.every((m) => sel.has(m.id));
          return `<div class="pfam">
            <button class="pfam-name ${allOn ? 'on' : ''}" data-a="toggleFamParts" data-id="${f.id}"><i class="dot" style="background:${famColor(ev, f.id)}"></i>${esc(familyName(ev, f.id))}</button>
            <div class="chips">${ms.map((m) => {
              const absent = d.day != null && presence(ev, m, { day: d.day }) === 0;
              return `<button class="chip small ${sel.has(m.id) ? 'on' : ''} ${absent ? 'absent' : ''}" data-a="togglePart" data-id="${m.id}">${esc(memberName(ev, m))}${absent ? ' 🚫' : ''}</button>`;
            }).join('') || `<span class="muted">${t('noMembers')}</span>`}</div>
          </div>`;
        }).join('')}
        ${d.day == null && n > 1 ? `<label class="check"><input type="checkbox" data-bind="byDays" data-type="bool" data-rerender="1" ${d.byDays ? 'checked' : ''}> ${t('byDays')}</label><p class="hint">${t('byDaysHint')}</p>` : ''}
        ${d.mode === 'shares' ? `
          <label class="check"><input type="checkbox" data-bind="customW" data-type="bool" data-rerender="1" ${d.customW ? 'checked' : ''}> ${t('customWeights')}</label>
          ${d.customW ? `<div class="weights">${d.parts.map((mid) => {
            const m = ev.members[mid]; if (!m || m.del) return '';
            return `<div class="w-row"><span>${esc(memberName(ev, m))} <small class="muted">${esc(familyName(ev, m.familyId))}</small></span>
              <input type="text" inputmode="decimal" data-bind="weights.${mid}" value="${d.weights[mid] ?? memberCoef(ev, m)}"></div>`;
          }).join('')}</div>` : ''}` : ''}`;
    } else {
      parts = `<div class="sub-title">${t('exactTitle')}</div>
        <div class="pay-multi">${fams.map((f) => `
          <div class="pm-row"><span><i class="dot" style="background:${famColor(ev, f.id)}"></i>${esc(familyName(ev, f.id))}</span>
          <input type="text" inputmode="decimal" data-bind="exact.${f.id}" value="${d.exact[f.id] ?? ''}" placeholder="0"></div>`).join('')}
          <div class="remain" id="exact-remain"></div></div>`;
    }

    return {
      title: d.isNew ? t('addExpense') : t('editExpense'),
      body: `
        ${field(t('whatFor'), `<input type="text" data-bind="title" value="${esc(d.title)}" placeholder="${t('expensePh')}" maxlength="60" ${d.isNew ? 'autofocus' : ''}>`)}
        <div class="amount-row">
          <input class="amount" type="text" inputmode="decimal" data-bind="amount" value="${esc(d.amount)}" placeholder="0" aria-label="${t('amount')}">
          <select data-bind="cur" data-rerender="1" aria-label="${t('currency')}">${currencyOptions(d.cur, [base, ...knownCurs])}</select>
        </div>
        ${needRate ? `<div class="rate-inline">1 ${d.cur} = <input type="text" inputmode="decimal" data-bind="rateInput" value="${d.rateInput ?? ''}" placeholder="?"> ${base}
          <button class="btn small ghost" data-a="fetchRateOne">↻</button></div>` : ''}
        ${dayChips}
        <div class="sub-title">${t('whoPaid')} <button class="link small" data-a="toggleMultiPay">${d.multiPay ? t('onePayer') : t('severalPayers')}</button></div>
        ${payers}
        <div class="sub-title">${t('howToSplit')}</div>
        ${modes}
        ${parts}
        <div class="preview" id="preview"></div>
        ${d.isNew ? '' : `<button class="btn ghost danger-text wide" data-a="deleteExpense">🗑 ${t('deleteExpense')}</button>`}`,
      footer: `<button class="btn primary wide" data-a="saveExpense">${t('save')}</button>`,
    };
  },

  share() {
    const ev = doc();
    const cloud = sync.cloudEnabled();
    return {
      title: t('share'),
      body: cloud ? `
        <p>${t('shareCloudText')}</p>
        <div class="linkbox">${esc(sync.joinLink(ev.id))}</div>
        <div class="btn-col">
          <button class="btn primary" data-a="shareJoin">📤 ${t('sendLink')}</button>
          <button class="btn ghost" data-a="copyJoin">📋 ${t('copyLink')}</button>
        </div>` : `
        <p>${t('shareSnapshotText')}</p>
        <div class="btn-col">
          <button class="btn primary" data-a="shareSnapshot">📤 ${t('sendSnapshot')}</button>
          <button class="btn ghost" data-a="copySnapshot">📋 ${t('copyLink')}</button>
        </div>
        <p class="hint">${t('cloudHint')}</p>`,
      footer: `<button class="btn ghost wide" data-a="shareResults">📊 ${t('shareResults')}</button>`,
    };
  },

  pickFamily() {
    const ev = doc();
    return {
      title: t('whichFamily'),
      body: `<p class="hint">${t('whichFamilyHint')}</p><div class="btn-col">${live(ev, 'families').map((f) => `
        <button class="btn ghost fam-pick" data-a="pickFamily" data-id="${f.id}"><i class="dot big" style="background:${famColor(ev, f.id)}"></i>${esc(familyName(ev, f.id))}</button>`).join('')}
        <button class="link" data-a="closeSheet">${t('skip')}</button></div>`,
    };
  },

  payment() {
    const d = S.draft;
    const ev = doc();
    const fams = live(ev, 'families');
    const opts = (sel) => fams.map((f) => `<option value="${f.id}" ${f.id === sel ? 'selected' : ''}>${esc(familyName(ev, f.id))}</option>`).join('');
    return {
      title: t('addPayment'),
      body: `
        <p class="hint">${t('paymentHint')}</p>
        ${field(t('from'), `<select data-bind="from">${opts(d.from)}</select>`)}
        ${field(t('to'), `<select data-bind="to">${opts(d.to)}</select>`)}
        <div class="amount-row">
          <input class="amount" type="text" inputmode="decimal" data-bind="amount" value="${esc(d.amount)}" placeholder="0">
          <select data-bind="cur">${currencyOptions(d.cur, [ev.meta.currency])}</select>
        </div>`,
      footer: `<button class="btn primary wide" data-a="savePayment">${t('save')}</button>`,
    };
  },
};

// Живой предпросмотр в редакторе расхода (без перерисовки — чтобы не терять фокус)
function draftToExpense(d, ev) {
  const amount = num(d.amount);
  const all = live(ev, 'members').map((m) => m.id);
  const allSel = d.parts.length === all.length && all.every((id) => d.parts.includes(id));
  const paid = {};
  if (d.multiPay) for (const [k, v] of Object.entries(d.paidMulti)) { if (num(v) > 0) paid[k] = num(v); }
  else if (d.payer) paid[d.payer] = amount;
  const weights = {};
  if (d.mode === 'shares' && (d.customW || isFriends(ev))) for (const mid of d.parts) if (d.weights[mid] != null && d.weights[mid] !== '') weights[mid] = num(d.weights[mid]);
  const exact = {};
  if (d.mode === 'exact') for (const [k, v] of Object.entries(d.exact)) if (num(v) > 0) exact[k] = num(v);
  return {
    id: d.id, title: d.title.trim(), amount, cur: d.cur, day: d.day,
    paid, mode: d.mode,
    parts: d.mode === 'exact' ? [] : (allSel ? [] : d.parts.slice()),
    byDays: d.day == null && !!d.byDays,
    weights: Object.keys(weights).length ? weights : null,
    exact: d.mode === 'exact' ? exact : null,
  };
}
function evWithDraftRate(ev, d) {
  const r = num(d.rateInput);
  if (d.cur !== ev.meta.currency && r > 0 && !(ev.rates?.[d.cur]?.rate > 0)) {
    return { ...ev, rates: { ...ev.rates, [d.cur]: { id: d.cur, rate: r, u: 0 } } };
  }
  return ev;
}
function updatePreview() {
  if (S.sheet?.type !== 'expense') return;
  const d = S.draft;
  const ev0 = doc();
  const ev = evWithDraftRate(ev0, d);
  const e = draftToExpense(d, ev);
  const box = $('#preview');
  const amount = num(d.amount);
  const remainEl = (id, map) => {
    const el = $(id);
    if (!el) return;
    const sum = Object.values(map).reduce((s, v) => s + num(v), 0);
    const left = amount - sum;
    el.textContent = Math.abs(left) < 0.005 ? '✓' : `${left > 0 ? t('remaining') : t('over')}: ${money(Math.abs(left), d.cur)}`;
    el.className = 'remain ' + (Math.abs(left) < 0.005 ? 'ok' : 'bad');
  };
  remainEl('#paid-remain', d.paidMulti);
  remainEl('#exact-remain', d.exact);
  if (!box) return;
  if (!amount) { box.innerHTML = ''; return; }
  const r = splitExpense(ev, e);
  if (r.error) { box.innerHTML = `<div class="warn">⚠ ${t('err.' + r.error)}</div>`; return; }
  const base = ev.meta.currency;
  const rate = rateOf(ev, d.cur);
  box.innerHTML = `<div class="mini-title">${t('preview')}</div>` + live(ev, 'families').filter((f) => r.shares[f.id] || r.paid[f.id]).map((f) => {
    const sh = r.shares[f.id] || 0;
    const inCur = d.cur !== base ? ` <small class="muted">(${money(sh / rate, d.cur)})</small>` : '';
    return `<div class="drow"><span><i class="dot" style="background:${famColor(ev, f.id)}"></i>${esc(familyName(ev, f.id))}</span><span>${money(sh, base)}${inCur}</span></div>`;
  }).join('');
}

// ── Действия ──
const A = {
  lang(el) { setLang(el.dataset.lang); store.setSettings({ lang: el.dataset.lang }); render(); },
  open(el) { S.tab = 'expenses'; go('#/e/' + el.dataset.id); },
  home() { go('#/'); },
  tab(el) { S.tab = el.dataset.tab; render(); $('#main')?.scrollTo(0, 0); },
  closeSheet() { closeSheet(); },

  newEvent() { openSheet({ type: 'newEvent', draft: { step: 'kind', kind: null, name: '', startDate: todayISO(), days: 1, currency: 'KGS' } }); },
  setKind(el) {
    S.draft.kind = el.dataset.kind;
    S.draft.step = 'details';
    renderSheet(true);
  },
  backToKind() { S.draft.step = 'kind'; renderSheet(); },
  toggleMultiDay() { S.draft.days = S.draft.days > 1 ? 1 : 2; renderSheet(); },
  createEvent() {
    const d = S.draft;
    const ev = store.createEvent({ kind: d.kind, name: d.name.trim() || t('untitled'), startDate: d.startDate, days: Math.max(1, d.days | 0), currency: d.currency });
    closeSheet(false);
    S.tab = 'families';
    go('#/e/' + ev.id);
    if (d.kind === 'friends') setTimeout(() => $('#quick-name')?.focus(), 150);
    else setTimeout(() => A.addFamily(), 150);
  },
  quickAdd() {
    const inp = $('#quick-name');
    const name = inp?.value.trim();
    if (!name) { inp?.focus(); return; }
    let ev = doc();
    const fams = live(ev, 'families');
    const used = new Set(fams.map((f) => f.color));
    const color = FAMILY_COLORS.find((c) => !used.has(c)) || FAMILY_COLORS[fams.length % FAMILY_COLORS.length];
    const fid = uid(6);
    ev = put(ev, 'families', { id: fid, name, color });
    ev = put(ev, 'members', { id: uid(6), familyId: fid, name, cat: 'adult', days: null, coef: null, order: 0 });
    save(ev);
    render();
    const again = $('#quick-name');
    if (again) again.focus();
  },
  demo() {
    const ev = buildDemo();
    S.tab = 'results';
    go('#/e/' + ev.id);
  },

  settings() {
    const ev = doc();
    const rates = {};
    for (const [c, r] of Object.entries(ev.rates || {})) if (!r.del) rates[c] = r.rate;
    openSheet({ type: 'settings', draft: { name: ev.meta.name, startDate: ev.meta.startDate || todayISO(), days: ev.meta.days, currency: ev.meta.currency, coefs: { ...DEFAULT_COEFS, ...ev.meta.coefs }, rates, newRateCur: '' } });
  },
  saveSettings() {
    const d = S.draft;
    let ev = doc();
    const coefs = {};
    for (const c of CATEGORIES) coefs[c] = Math.max(0, num(d.coefs[c]));
    const curChanged = d.currency !== ev.meta.currency;
    ev = setMeta(ev, { name: d.name.trim() || t('untitled'), startDate: d.startDate, days: Math.max(1, d.days | 0), currency: d.currency, coefs });
    for (const [c, v] of Object.entries(d.rates)) {
      const rate = num(v);
      if (c === d.currency) continue;
      if (rate > 0 && ev.rates?.[c]?.rate !== rate) ev = put(ev, 'rates', { id: c, rate });
    }
    save(ev);
    closeSheet();
    toast(curChanged ? t('curChangedHint') : t('saved'));
  },
  async fetchRates() {
    const d = S.draft;
    try {
      const rates = await loadRates(d.currency);
      for (const c of Object.keys(d.rates)) if (rates[c]) d.rates[c] = +(1 / rates[c]).toPrecision(6);
      renderSheet(); toast(t('ratesLoaded'));
    } catch { toast(t('ratesFailed')); }
  },
  async fetchRateOne() {
    const d = S.draft;
    const ev = doc();
    try {
      const rates = await loadRates(ev.meta.currency);
      if (rates[d.cur]) { d.rateInput = +(1 / rates[d.cur]).toPrecision(6); renderSheet(); updatePreview(); }
    } catch { toast(t('ratesFailed')); }
  },
  exportJson() {
    const ev = doc();
    const blob = new Blob([JSON.stringify(ev, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `familysplit-${(ev.meta.name || 'event').replace(/[^\p{L}\p{N}]+/gu, '-')}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  },
  importFile() {
    const inp = document.createElement('input');
    inp.type = 'file'; inp.accept = '.json,application/json';
    inp.onchange = async () => {
      try {
        const ev = JSON.parse(await inp.files[0].text());
        if (!ev.id || !ev.meta) throw 0;
        store.mergeIn(ev, 'local');
        toast(t('imported'));
        go('#/e/' + ev.id);
      } catch { toast(t('badFile')); }
    };
    inp.click();
  },
  async deleteEvent() {
    const ok = await confirmDialog(sync.cloudEnabled() ? t('confirmDeleteEventCloud') : t('confirmDeleteEvent'));
    if (!ok) return;
    store.deleteEventLocal(S.id);
    closeSheet(false);
    go('#/');
  },

  addFamily() {
    const ev = doc();
    const used = new Set(live(ev, 'families').map((f) => f.color));
    const color = FAMILY_COLORS.find((c) => !used.has(c)) || FAMILY_COLORS[live(ev, 'families').length % FAMILY_COLORS.length];
    const all = n => Array.from({ length: n }, () => null);
    openSheet({ type: 'family', draft: {
      id: uid(6), isNew: true, name: '', color,
      isMine: !myFamily() && !live(ev, 'families').length,
      members: all(isFriends(ev) ? 1 : 2).map(() => ({ id: uid(6), name: '', cat: 'adult', days: null, coef: null })),
    } });
  },
  editFamily(el) {
    const ev = doc();
    const f = ev.families[el.dataset.id];
    openSheet({ type: 'family', draft: {
      id: f.id, isNew: false, name: f.name || '', color: familyColor(f.color),
      isMine: myFamily() === f.id,
      members: membersOf(ev, f.id).map((m) => ({ id: m.id, name: m.name || '', cat: m.cat, days: Array.isArray(m.days) ? [...m.days] : null, coef: m.coef ?? null })),
    } });
    if (isFriends(ev) && !S.draft.members.length) { S.draft.members.push({ id: uid(6), name: '', cat: 'adult', days: null, coef: null }); renderSheet(); }
  },
  addMember(el) { S.draft.members.push({ id: uid(6), name: '', cat: el.dataset.cat, days: null, coef: null }); renderSheet(); },
  removeMember(el) { S.draft.members.splice(+el.dataset.i, 1); renderSheet(); },
  setCat(el) { S.draft.members[+el.dataset.i].cat = el.dataset.cat; renderSheet(); },
  setColor(el) { S.draft.color = el.dataset.c; renderSheet(); },
  toggleDay(el) {
    const m = S.draft.members[+el.dataset.i];
    const n = Math.max(1, doc().meta.days | 0);
    const k = +el.dataset.day;
    let days = m.days == null ? Array.from({ length: n }, (_, i) => i) : [...m.days];
    days = days.includes(k) ? days.filter((x) => x !== k) : [...days, k].sort((a, b) => a - b);
    m.days = days.length === n ? null : days;
    renderSheet();
  },
  saveFamily() {
    const d = S.draft;
    let ev = doc();
    if (isFriends(ev)) {
      if (!d.name.trim()) { toast(t('enterName')); return; }
      d.members = d.members.slice(0, 1).map((m) => ({ ...m, name: d.name.trim(), cat: 'adult' }));
    }
    ev = put(ev, 'families', { id: d.id, name: d.name.trim(), color: d.color });
    const keep = new Set(d.members.map((m) => m.id));
    for (const m of membersOf(ev, d.id)) if (!keep.has(m.id)) ev = remove(ev, 'members', m.id);
    const n = Math.max(1, ev.meta.days | 0);
    d.members.forEach((m, i) => {
      const coef = m.coef === '' || m.coef == null ? null : Math.max(0, num(m.coef));
      const days = Array.isArray(m.days) && m.days.length >= n ? null : m.days;
      const prev = ev.members[m.id];
      const next = { id: m.id, familyId: d.id, name: m.name.trim(), cat: m.cat, days, coef, order: i };
      if (!prev || prev.del || ['name', 'cat', 'coef', 'order'].some((k) => prev[k] !== next[k]) || JSON.stringify(prev.days) !== JSON.stringify(days)) {
        ev = put(ev, 'members', next);
      }
    });
    if (d.isMine) store.updateIndex(S.id, { myFamily: d.id });
    else if (myFamily() === d.id) store.updateIndex(S.id, { myFamily: null });
    save(ev);
    closeSheet();
    toast(t('saved'));
  },
  async deleteFamily() {
    const ok = await confirmDialog(t('confirmDeleteFamily'));
    if (!ok) return;
    save(removeFamily(doc(), S.draft.id));
    if (myFamily() === S.draft.id) store.updateIndex(S.id, { myFamily: null });
    closeSheet();
  },

  addExpense() {
    const ev = doc();
    const fams = live(ev, 'families');
    if (!fams.length) { toast(t('addFamiliesFirst')); S.tab = 'families'; render(); return; }
    const mine = myFamily();
    openSheet({ type: 'expense', draft: {
      id: uid(6), isNew: true, title: '', amount: '', cur: ev.meta.currency, day: null,
      payer: mine && ev.families[mine] ? mine : fams[0].id, multiPay: false, paidMulti: {},
      mode: isFriends(ev) ? 'person' : 'shares', parts: live(ev, 'members').map((m) => m.id), byDays: false, customW: false, weights: {}, exact: {},
    } });
  },
  editExpense(el) {
    const ev = doc();
    const e = ev.expenses[el.dataset.id];
    const payers = Object.keys(e.paid || {}).filter((k) => num(e.paid[k]) > 0);
    const allIds = live(ev, 'members').map((m) => m.id);
    openSheet({ type: 'expense', draft: {
      id: e.id, isNew: false, title: e.title || '', amount: String(e.amount ?? ''), cur: e.cur || ev.meta.currency,
      day: e.day == null || e.day === '' ? null : +e.day,
      payer: payers[0] || null, multiPay: payers.length > 1, paidMulti: { ...(e.paid || {}) },
      mode: e.mode || 'shares', parts: e.parts?.length ? e.parts.filter((id) => allIds.includes(id)) : allIds,
      byDays: !!e.byDays, customW: !!(e.weights && Object.keys(e.weights).length), weights: { ...(e.weights || {}) }, exact: { ...(e.exact || {}) },
    } });
    updatePreview();
  },
  setDay(el) { S.draft.day = el.dataset.day === '' ? null : +el.dataset.day; renderSheet(); updatePreview(); },
  setPayer(el) { S.draft.payer = el.dataset.id; renderSheet(); updatePreview(); },
  toggleMultiPay() {
    const d = S.draft;
    d.multiPay = !d.multiPay;
    if (d.multiPay && d.payer && !Object.values(d.paidMulti).some((v) => num(v) > 0)) d.paidMulti = { [d.payer]: d.amount };
    if (!d.multiPay) d.payer = Object.keys(d.paidMulti).sort((a, b) => num(d.paidMulti[b]) - num(d.paidMulti[a]))[0] || d.payer;
    renderSheet(); updatePreview();
  },
  setMode(el) {
    S.draft.mode = el.dataset.mode;
    // у друзей «по долям» = сразу свои доли для каждого
    if (isFriends(doc()) && S.draft.mode === 'shares') S.draft.customW = true;
    renderSheet(); updatePreview();
  },
  togglePart(el) {
    const d = S.draft; const id = el.dataset.id;
    d.parts = d.parts.includes(id) ? d.parts.filter((x) => x !== id) : [...d.parts, id];
    renderSheet(); updatePreview();
  },
  toggleFamParts(el) {
    const d = S.draft;
    const ids = membersOf(doc(), el.dataset.id).map((m) => m.id);
    const allOn = ids.every((id) => d.parts.includes(id));
    d.parts = allOn ? d.parts.filter((x) => !ids.includes(x)) : [...new Set([...d.parts, ...ids])];
    renderSheet(); updatePreview();
  },
  partsPreset(el) {
    const ms = live(doc(), 'members');
    const p = el.dataset.p;
    S.draft.parts = ms.filter((m) => p === 'all' || (p === 'adults' && m.cat === 'adult') || (p === 'kids' && m.cat !== 'adult')).map((m) => m.id);
    renderSheet(); updatePreview();
  },
  saveExpense() {
    const d = S.draft;
    let ev = doc();
    if (!(num(d.amount) > 0)) { toast(t('err.noAmount')); return; }
    if (d.cur !== ev.meta.currency && !(ev.rates?.[d.cur]?.rate > 0)) {
      if (!(num(d.rateInput) > 0)) { toast(t('err.noRate')); return; }
      ev = put(ev, 'rates', { id: d.cur, rate: num(d.rateInput) });
    }
    const e = draftToExpense(d, ev);
    if (!e.title) e.title = t('expense');
    const res = splitExpense(ev, e);
    ev = put(ev, 'expenses', e);
    save(ev);
    closeSheet();
    toast(res.error ? '⚠ ' + t('err.' + res.error) : t('saved'));
  },
  async deleteExpense() {
    if (!(await confirmDialog(t('confirmDeleteExpense')))) return;
    save(remove(doc(), 'expenses', S.draft.id));
    closeSheet();
  },

  step(el) {
    const input = el.parentElement.querySelector('input');
    const v = Math.min(+el.dataset.max, Math.max(+el.dataset.min, (parseInt(input.value, 10) || 0) + +el.dataset.d));
    input.value = v;
    setPath(S.draft, el.dataset.bind, v);
  },

  toggleFam(el) {
    const id = el.dataset.id;
    S.expanded.has(id) ? S.expanded.delete(id) : S.expanded.add(id);
    render();
  },
  markPaid(el) {
    const ev = doc();
    const x = computeEvent(ev).transfers[+el.dataset.i];
    if (!x) return;
    openSheet({ type: 'payment', draft: { id: uid(6), from: x.from, to: x.to, amount: String(x.amount), cur: ev.meta.currency } });
  },
  addPayment() {
    const ev = doc();
    const fams = live(ev, 'families');
    if (fams.length < 2) return;
    openSheet({ type: 'payment', draft: { id: uid(6), from: myFamily() || fams[0].id, to: fams.find((f) => f.id !== (myFamily() || fams[0].id)).id, amount: '', cur: ev.meta.currency } });
  },
  savePayment() {
    const d = S.draft;
    if (d.from === d.to) { toast(t('samePayer')); return; }
    if (!(num(d.amount) > 0)) { toast(t('err.noAmount')); return; }
    save(put(doc(), 'payments', { id: d.id, from: d.from, to: d.to, amount: num(d.amount), cur: d.cur, date: todayISO() }));
    closeSheet();
    toast(t('paymentSaved'));
  },
  async undoPayment(el) {
    if (!(await confirmDialog(t('confirmDeletePayment')))) return;
    save(remove(doc(), 'payments', el.dataset.id));
  },
  shareResults() { shareText(resultsText(doc())); },

  share() { openSheet({ type: 'share' }); },
  shareJoin() { shareText(t('joinInvite', { name: doc().meta.name }), sync.joinLink(S.id)); },
  copyJoin() { copyText(sync.joinLink(S.id)); },
  async shareSnapshot() { shareText(t('snapshotInvite', { name: doc().meta.name }), await sync.snapshotLink(doc())); },
  async copySnapshot() { copyText(await sync.snapshotLink(doc())); },
  pickFamily(el) { store.updateIndex(S.id, { myFamily: el.dataset.id }); closeSheet(); },
};

function resultsText(ev) {
  const r = computeEvent(ev);
  const cur = ev.meta.currency;
  const lines = [`💰 ${ev.meta.name || t('untitled')}`, `${t('total')}: ${money(r.total, cur)} · ${isFriends(ev) ? '' : plural('families', live(ev, 'families').length) + ' · '}${plural('people', r.people)}`, ''];
  lines.push(t('whoPaysWhom') + ':');
  if (!r.transfers.length) lines.push('✓ ' + t('allSettled'));
  for (const x of r.transfers) lines.push(`• ${familyName(ev, x.from)} → ${familyName(ev, x.to)}: ${money(x.amount, cur)}`);
  lines.push('', t('byFamily') + ':');
  for (const f of live(ev, 'families')) {
    const x = r.families[f.id];
    lines.push(`• ${familyName(ev, f.id)}: ${t('paid').toLowerCase()} ${money(x.paid, cur)}, ${t('share').toLowerCase()} ${money(x.share, cur)}`);
  }
  lines.push('', '— FamilySplit');
  return lines.join('\n');
}

async function loadRates(base) {
  const res = await fetch(`https://open.er-api.com/v6/latest/${base}`);
  if (!res.ok) throw new Error('rates');
  const j = await res.json();
  if (j.result !== 'success') throw new Error('rates');
  return j.rates; // 1 base = rates[c] c
}

function buildDemo() {
  let ev = store.createEvent({ name: t('demoName'), startDate: todayISO(), days: 3, currency: 'KGS' });
  const F = (name, color, members) => {
    const id = uid(6);
    ev = put(ev, 'families', { id, name, color });
    members.forEach(([n, cat, days], i) => { ev = put(ev, 'members', { id: uid(6), familyId: id, name: n, cat, days: days || null, order: i }); });
    return id;
  };
  const a = F(t('demoF1'), FAMILY_COLORS[0], [['Азамат', 'adult'], ['Айгуль', 'adult'], ['Нурик', 'child'], ['Айсулуу', 'infant']]);
  const b = F(t('demoF2'), FAMILY_COLORS[1], [['Бакыт', 'adult', [0, 1]], ['Жылдыз', 'adult', [0, 1]]]);
  const c = F(t('demoF3'), FAMILY_COLORS[2], [['Тимур', 'adult'], ['Камила', 'adult'], ['Эмир', 'teen']]);
  const adults = live(ev, 'members').filter((m) => m.cat === 'adult').map((m) => m.id);
  ev = put(ev, 'rates', { id: 'USD', rate: 87.4 });
  const E = (o) => { ev = put(ev, 'expenses', { id: uid(6), mode: 'shares', cur: 'KGS', day: null, parts: [], ...o }); };
  E({ title: t('demoE1'), amount: 300, cur: 'USD', paid: { [a]: 300 }, mode: 'person', byDays: true });
  E({ title: t('demoE2'), amount: 12400, paid: { [b]: 7000, [c]: 5400 } });
  E({ title: t('demoE3'), amount: 4500, paid: { [c]: 4500 }, parts: adults, day: 1 });
  E({ title: t('demoE4'), amount: 6000, paid: { [a]: 6000 }, mode: 'family' });
  E({ title: t('demoE5'), amount: 3800, paid: { [c]: 3800 }, day: 2 });
  store.updateIndex(ev.id, { myFamily: a, askedFamily: true });
  save(ev);
  return ev;
}

// ── Привязка событий ──
document.addEventListener('click', (e) => {
  const el = e.target.closest('[data-a]');
  if (!el) return;
  const fn = A[el.dataset.a];
  if (fn) { e.preventDefault(); fn(el, e); }
});
document.addEventListener('input', (e) => {
  const el = e.target;
  if (!el.dataset?.bind || !S.draft || el.tagName === 'SELECT' || el.type === 'checkbox') return;
  let v = el.type === 'checkbox' ? el.checked : el.value;
  if (el.dataset.type === 'int') v = parseInt(v, 10) || 0;
  setPath(S.draft, el.dataset.bind, v);
  if (el.dataset.rerender) renderSheet();
  updatePreview();
});
document.addEventListener('change', (e) => {
  const el = e.target;
  if (!el.dataset?.bind || !S.draft) return;
  if (el.tagName !== 'SELECT' && el.type !== 'checkbox') return;
  let v = el.type === 'checkbox' ? el.checked : el.value;
  if (el.dataset.bind === 'newRateCur') { if (v) S.draft.rates[v] = ''; S.draft.newRateCur = ''; renderSheet(); return; }
  setPath(S.draft, el.dataset.bind, v);
  if (el.dataset.rerender || el.tagName === 'SELECT') renderSheet();
  updatePreview();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && e.target?.id === 'quick-name') { e.preventDefault(); A.quickAdd(); return; }
  if (e.key === 'Escape' && S.sheet && !$('#dialog-root').innerHTML) closeSheet();
});

store.subscribe((id, source) => {
  if (source === 'remote' && id === S.id) {
    if (!S.sheet) render();
    else {
      // не мешаем редактированию: обновим фон, лист оставим
      const sh = S.sheet; S.sheet = null; render(); S.sheet = sh;
    }
  }
});
sync.onStatus((id) => {
  if (id !== S.id) return;
  const dot = document.querySelector('.sync-dot');
  if (dot) dot.outerHTML = syncBadge(id);
});

// ── PWA ──
if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}

// ── Старт ──
const settings = store.getSettings();
setLang(settings.lang || (navigator.language || 'ru').slice(0, 2));
store.migrateLegacy(t('legacyName'));
const onNav = () => { if (location.hash !== currentHash) { currentHash = location.hash; route(); } };
window.addEventListener('hashchange', onNav);
window.addEventListener('popstate', onNav);
route();
