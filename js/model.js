// Модель данных мероприятия и слияние изменений между устройствами.
//
// Документ мероприятия хранит сущности в словарях по id. У каждой сущности есть
// метка времени `u`; при слиянии побеждает более свежая версия (last-writer-wins
// на уровне отдельной записи). Удаление — это запись с флагом `del: true`
// («надгробие»), чтобы удаление тоже доезжало до других устройств.

export const SCHEMA = 1;
export const COLLECTIONS = ['families', 'members', 'expenses', 'payments', 'rates'];

export const DEFAULT_COEFS = { adult: 1, teen: 0.75, child: 0.5, infant: 0 };
export const CATEGORIES = ['adult', 'teen', 'child', 'infant'];

export const CURRENCIES = {
  KGS: { symbol: 'сом', decimals: 0 },
  USD: { symbol: '$', decimals: 2 },
  EUR: { symbol: '€', decimals: 2 },
  RUB: { symbol: '₽', decimals: 0 },
  KZT: { symbol: '₸', decimals: 0 },
  UZS: { symbol: 'сўм', decimals: 0 },
  TRY: { symbol: '₺', decimals: 2 },
  CNY: { symbol: '¥', decimals: 2 },
  AED: { symbol: 'AED', decimals: 2 },
  GEL: { symbol: '₾', decimals: 2 },
};

// Цвета-метки семей. Без красного, зелёного и оранжевого: эти цвета в интерфейсе означают долг, переплату и акцент.
export const FAMILY_COLORS = ['#4a78d0', '#8a63cf', '#2a9a98', '#cc5f97', '#64748b', '#9c7a52', '#5a5fc8', '#3d9cc4', '#9b5a86', '#7b8a3a'];
// Цвета первой версии палитры — сопоставляем с новыми по номеру, чтобы старые мероприятия тоже выглядели единообразно.
export const LEGACY_FAMILY_COLORS = ['#d4870a', '#1e8c5a', '#2f6fd6', '#c0392b', '#8e44ad', '#16a085', '#d35400', '#7f8c8d', '#b8860b', '#2c3e50'];
export function familyColor(color) {
  const i = LEGACY_FAMILY_COLORS.indexOf(color);
  if (i >= 0) return FAMILY_COLORS[i];
  return color || FAMILY_COLORS[0];
}

let lastStamp = 0;
/** Монотонная метка времени: даже два изменения в одну миллисекунду упорядочены. */
export function stamp() {
  const now = Date.now();
  lastStamp = now > lastStamp ? now : lastStamp + 1;
  return lastStamp;
}

/** Случайный id. Для мероприятий — 128 бит: id служит «ключом доступа» в ссылке. */
export function uid(bytes = 8) {
  const a = new Uint8Array(bytes);
  crypto.getRandomValues(a);
  return Array.from(a, (b) => b.toString(36).padStart(2, '0')).join('').slice(0, Math.ceil(bytes * 1.6));
}
export function eventId() {
  const a = new Uint8Array(16);
  crypto.getRandomValues(a);
  return Array.from(a, (b) => b.toString(16).padStart(2, '0')).join('');
}

export function todayISO() {
  const d = new Date();
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
}

export function newEvent({ name = '', currency = 'KGS', days = 1, startDate = todayISO(), kind = 'families' } = {}) {
  return {
    id: eventId(),
    schema: SCHEMA,
    meta: { kind, name, currency, days, startDate, coefs: { ...DEFAULT_COEFS }, u: stamp() },
    families: {},
    members: {},
    expenses: {},
    payments: {},
    rates: {},
  };
}

/** Живые (не удалённые) записи коллекции, отсортированные. */
export function live(doc, coll, sortKey = 'createdAt') {
  return Object.values(doc[coll] || {})
    .filter((x) => !x.del)
    .sort((a, b) => (a[sortKey] ?? a.u ?? 0) - (b[sortKey] ?? b.u ?? 0));
}

export function membersOf(doc, familyId) {
  return live(doc, 'members').filter((m) => m.familyId === familyId);
}

/** Записать сущность с новой меткой времени (иммутабельно). */
export function put(doc, coll, entity) {
  const prev = doc[coll]?.[entity.id];
  const next = { createdAt: prev?.createdAt ?? stamp(), ...prev, ...entity, u: stamp() };
  return { ...doc, [coll]: { ...doc[coll], [entity.id]: next } };
}

export function remove(doc, coll, id) {
  const prev = doc[coll]?.[id];
  if (!prev) return doc;
  return { ...doc, [coll]: { ...doc[coll], [id]: { id, del: true, u: stamp(), createdAt: prev.createdAt } } };
}

export function setMeta(doc, patch) {
  return { ...doc, meta: { ...doc.meta, ...patch, u: stamp() } };
}

/** Удаление семьи: вместе с её людьми; чистим ссылки в расходах. */
export function removeFamily(doc, familyId) {
  let d = remove(doc, 'families', familyId);
  for (const m of membersOf(doc, familyId)) d = remove(d, 'members', m.id);
  for (const e of live(d, 'expenses')) {
    const touches = e.paid?.[familyId] != null || e.exact?.[familyId] != null;
    if (!touches) continue;
    const paid = { ...e.paid }; delete paid[familyId];
    const exact = e.exact ? { ...e.exact } : null; if (exact) delete exact[familyId];
    d = put(d, 'expenses', { ...e, paid, exact });
  }
  return d;
}

function newer(a, b) {
  if (!a) return b;
  if (!b) return a;
  return (b.u ?? 0) > (a.u ?? 0) ? b : a;
}

/** Слияние двух версий одного мероприятия. Коммутативно и идемпотентно. */
export function merge(a, b) {
  if (!a) return b;
  if (!b) return a;
  const out = { id: a.id, schema: Math.max(a.schema || 1, b.schema || 1), meta: newer(a.meta, b.meta) };
  for (const c of COLLECTIONS) {
    const res = {};
    const ids = new Set([...Object.keys(a[c] || {}), ...Object.keys(b[c] || {})]);
    for (const id of ids) res[id] = newer(a[c]?.[id], b[c]?.[id]);
    out[c] = res;
  }
  return out;
}

/** Есть ли в `local` что-то, чего нет (или что новее), чем в `remote`. */
export function hasNewer(local, remote) {
  if (!remote) return true;
  if ((local.meta?.u ?? 0) > (remote.meta?.u ?? 0)) return true;
  for (const c of COLLECTIONS) {
    for (const [id, e] of Object.entries(local[c] || {})) {
      const r = remote[c]?.[id];
      if (!r || (e.u ?? 0) > (r.u ?? 0)) return true;
    }
  }
  return false;
}

/** Последнее изменение в документе (для сортировки списка мероприятий). */
export function lastChange(doc) {
  let m = doc.meta?.u ?? 0;
  for (const c of COLLECTIONS) for (const e of Object.values(doc[c] || {})) if ((e.u ?? 0) > m) m = e.u;
  return m;
}

/** Даты дней мероприятия (для подписей). */
export function dayDates(meta) {
  const n = Math.max(1, meta.days | 0);
  const start = meta.startDate ? new Date(meta.startDate + 'T12:00:00') : null;
  return Array.from({ length: n }, (_, i) => {
    if (!start || isNaN(start)) return null;
    const d = new Date(start); d.setDate(d.getDate() + i);
    return d;
  });
}
