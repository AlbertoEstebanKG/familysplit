// Локальное хранилище: мероприятия в localStorage + настройки устройства.

import { merge, newEvent, put, uid, lastChange } from './model.js';

const K_INDEX = 'fs2:index';
const K_SETTINGS = 'fs2:settings';
const kEvent = (id) => 'fs2:ev:' + id;

function read(key, fallback) {
  try {
    const v = localStorage.getItem(key);
    return v ? JSON.parse(v) : fallback;
  } catch { return fallback; }
}
function write(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); return true; } catch { return false; }
}

const listeners = new Set();
export function subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); }
function emit(id, source) { for (const fn of listeners) fn(id, source); }

// ── Настройки устройства ──
export function getSettings() {
  const s = read(K_SETTINGS, {});
  if (!s.deviceId) { s.deviceId = uid(8); write(K_SETTINGS, s); }
  return s;
}
export function setSettings(patch) {
  const s = { ...getSettings(), ...patch };
  write(K_SETTINGS, s);
  return s;
}

// ── Индекс мероприятий на этом устройстве ──
// { id, myFamily, rev, archived, openedAt }
export function getIndex() { return read(K_INDEX, []); }
function setIndex(list) { write(K_INDEX, list); }
export function indexEntry(id) { return getIndex().find((x) => x.id === id) || null; }
export function updateIndex(id, patch) {
  const list = getIndex();
  const i = list.findIndex((x) => x.id === id);
  if (i >= 0) list[i] = { ...list[i], ...patch }; else list.push({ id, ...patch });
  setIndex(list);
}

export function listEvents() {
  return getIndex()
    .map((entry) => ({ entry, doc: read(kEvent(entry.id), null) }))
    .filter((x) => x.doc)
    .sort((a, b) => lastChange(b.doc) - lastChange(a.doc));
}

export function loadEvent(id) { return read(kEvent(id), null); }

/** Сохранить документ (source: 'local' — правка пользователя, 'remote' — пришло с сервера). */
export function saveEvent(doc, source = 'local') {
  write(kEvent(doc.id), doc);
  if (!indexEntry(doc.id)) updateIndex(doc.id, { openedAt: Date.now() });
  emit(doc.id, source);
  return doc;
}

/** Применить версию с сервера/ссылки: слить с локальной. */
export function mergeIn(remoteDoc, source = 'remote') {
  const local = loadEvent(remoteDoc.id);
  const merged = merge(local, remoteDoc);
  return saveEvent(merged, source);
}

export function deleteEventLocal(id) {
  try { localStorage.removeItem(kEvent(id)); } catch {}
  setIndex(getIndex().filter((x) => x.id !== id));
  emit(id, 'delete');
}

export function createEvent(opts) {
  const doc = newEvent(opts);
  saveEvent(doc);
  return doc;
}

/** Перенос данных из первой версии FamilySplit (fs_families / fs_expenses). */
export function migrateLegacy(defaultName) {
  if (read('fs2:migrated', false)) return null;
  write('fs2:migrated', true);
  const fams = read('fs_families', null);
  const exps = read('fs_expenses', null);
  if (!Array.isArray(fams) || !fams.length) return null;
  let d = newEvent({ name: defaultName, currency: 'KGS', days: 1 });
  const famMap = {};
  for (const f of fams) {
    const id = uid(6); famMap[f.id] = id;
    d = put(d, 'families', { id, name: f.name || `#${f.id}` });
    for (let i = 0; i < (f.adults | 0); i++) d = put(d, 'members', { id: uid(6), familyId: id, name: '', cat: 'adult', days: null });
    for (let i = 0; i < (f.children | 0); i++) d = put(d, 'members', { id: uid(6), familyId: id, name: '', cat: 'child', days: null });
  }
  for (const e of exps || []) {
    if (!(e.amount > 0)) continue;
    const payers = (e.payers || []).map((p) => famMap[p]).filter(Boolean);
    const paid = {};
    payers.forEach((p) => { paid[p] = e.amount / payers.length; });
    const partFams = new Set((e.participants || []).map((p) => famMap[p]));
    const parts = Object.values(d.members).filter((m) => partFams.has(m.familyId)).map((m) => m.id);
    d = put(d, 'expenses', { id: uid(6), title: e.name || '', amount: e.amount, cur: 'KGS', paid, mode: 'shares', parts, day: null });
  }
  saveEvent(d);
  return d;
}
