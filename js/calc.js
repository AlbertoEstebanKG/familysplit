// Расчёт: кто сколько потратил, чья доля сколько, кто кому должен.
// Чистые функции без DOM — их проверяют тесты в tests/.

import { live, CURRENCIES, DEFAULT_COEFS } from './model.js';

export const MODES = ['shares', 'person', 'family', 'exact'];

export function decimalsOf(cur) {
  return CURRENCIES[cur]?.decimals ?? 2;
}

export function roundCur(x, cur) {
  const f = 10 ** decimalsOf(cur);
  return Math.round(x * f) / f;
}

/** Курс: сколько базовой валюты в 1 единице `cur`. */
export function rateOf(doc, cur) {
  if (!cur || cur === doc.meta.currency) return 1;
  const r = doc.rates?.[cur];
  return r && !r.del && r.rate > 0 ? r.rate : NaN;
}

export function memberCoef(doc, m) {
  if (typeof m.coef === 'number' && m.coef >= 0) return m.coef;
  const coefs = { ...DEFAULT_COEFS, ...(doc.meta.coefs || {}) };
  return coefs[m.cat] ?? 1;
}

export function daysCount(doc) {
  return Math.max(1, doc.meta.days | 0);
}

/** Доля присутствия человека для конкретного расхода (0..1). */
export function presence(doc, m, e) {
  const n = daysCount(doc);
  const days = Array.isArray(m.days) ? m.days.filter((d) => d >= 0 && d < n) : null;
  if (e.day != null && e.day !== '') {
    return days === null || days.includes(Number(e.day)) ? 1 : 0;
  }
  if (e.byDays) return days === null ? 1 : days.length / n;
  return 1;
}

/**
 * Делит один расход. Возвращает { shares: {familyId: сумма в базовой валюте},
 * memberShares: {memberId: сумма}, paid: {familyId: сумма}, amount, error }.
 */
export function splitExpense(doc, e, ctx = null) {
  const c = ctx || context(doc);
  const rate = rateOf(doc, e.cur);
  const amount = Number(e.amount) || 0;
  const res = { id: e.id, amount: amount * rate, shares: {}, memberShares: {}, paid: {}, error: null };

  if (!(amount > 0)) return { ...res, error: 'noAmount' };
  if (!Number.isFinite(rate)) return { ...res, error: 'noRate' };

  // Кто платил
  const paidEntries = Object.entries(e.paid || {}).filter(([fid, v]) => c.famIds.has(fid) && Number(v) > 0);
  if (!paidEntries.length) return { ...res, error: 'noPayer' };
  const paidSum = paidEntries.reduce((s, [, v]) => s + Number(v), 0);
  if (Math.abs(paidSum - amount) > 0.005 * Math.max(1, amount / 100)) return { ...res, error: 'paidMismatch' };
  for (const [fid, v] of paidEntries) res.paid[fid] = Number(v) * rate;

  // Режим «вручную»: точные суммы по семьям
  if (e.mode === 'exact') {
    const ex = Object.entries(e.exact || {}).filter(([fid, v]) => c.famIds.has(fid) && Number(v) > 0);
    const sum = ex.reduce((s, [, v]) => s + Number(v), 0);
    if (!ex.length) return { ...res, error: 'noParticipants' };
    if (Math.abs(sum - amount) > 0.005 * Math.max(1, amount / 100)) return { ...res, error: 'exactMismatch' };
    for (const [fid, v] of ex) res.shares[fid] = Number(v) * rate;
    return res;
  }

  // Участники: список id людей; пусто/нет — все
  const partIds = Array.isArray(e.parts) && e.parts.length ? new Set(e.parts) : null;
  const people = c.members.filter((m) => !partIds || partIds.has(m.id));

  if (e.mode === 'family') {
    const famW = {};
    for (const m of people) {
      const p = presence(doc, m, e);
      if (p > 0) famW[m.familyId] = Math.max(famW[m.familyId] || 0, p);
    }
    const total = Object.values(famW).reduce((s, w) => s + w, 0);
    if (!(total > 0)) return { ...res, error: 'noParticipants' };
    for (const [fid, w] of Object.entries(famW)) res.shares[fid] = (res.amount * w) / total;
    return res;
  }

  const weights = {};
  for (const m of people) {
    const base = e.mode === 'person' ? 1 : (e.weights && typeof e.weights[m.id] === 'number' ? e.weights[m.id] : memberCoef(doc, m));
    const w = base * presence(doc, m, e);
    if (w > 0) weights[m.id] = w;
  }
  const total = Object.values(weights).reduce((s, w) => s + w, 0);
  if (!(total > 0)) return { ...res, error: 'noParticipants' };
  for (const [mid, w] of Object.entries(weights)) {
    const v = (res.amount * w) / total;
    res.memberShares[mid] = v;
    const fid = c.memberById[mid].familyId;
    res.shares[fid] = (res.shares[fid] || 0) + v;
  }
  return res;
}

function context(doc) {
  const families = live(doc, 'families');
  const famIds = new Set(families.map((f) => f.id));
  const members = live(doc, 'members').filter((m) => famIds.has(m.familyId));
  const memberById = Object.fromEntries(members.map((m) => [m.id, m]));
  return { families, famIds, members, memberById };
}

/** Минимизация числа переводов: крупнейший должник платит крупнейшему кредитору. */
export function settle(balances, cur) {
  const eps = decimalsOf(cur) === 0 ? 0.5 : 0.005;
  const debt = Object.entries(balances).filter(([, b]) => b < -eps).map(([id, b]) => ({ id, v: -b }));
  const cred = Object.entries(balances).filter(([, b]) => b > eps).map(([id, b]) => ({ id, v: b }));
  const out = [];
  while (debt.length && cred.length) {
    debt.sort((a, b) => b.v - a.v);
    cred.sort((a, b) => b.v - a.v);
    const d = debt[0], c = cred[0];
    const pay = Math.min(d.v, c.v);
    const rounded = roundCur(pay, cur);
    if (rounded > 0) out.push({ from: d.id, to: c.id, amount: rounded });
    d.v -= pay; c.v -= pay;
    if (d.v <= eps) debt.shift();
    if (c.v <= eps) cred.shift();
  }
  return out;
}

/** Полный расчёт мероприятия. Все суммы — в базовой валюте мероприятия. */
export function computeEvent(doc) {
  const c = context(doc);
  const cur = doc.meta.currency;
  const fam = {};
  for (const f of c.families) fam[f.id] = { paid: 0, share: 0, sent: 0, received: 0, balance: 0, members: {}, items: [] };

  const errors = [];
  let total = 0;
  const byExpense = {};
  for (const e of live(doc, 'expenses')) {
    const r = splitExpense(doc, e, c);
    byExpense[e.id] = r;
    if (r.error) { errors.push({ expenseId: e.id, code: r.error }); continue; }
    total += r.amount;
    for (const [fid, v] of Object.entries(r.paid)) fam[fid].paid += v;
    for (const [fid, v] of Object.entries(r.shares)) {
      fam[fid].share += v;
      fam[fid].items.push({ expenseId: e.id, amount: v });
    }
    for (const [mid, v] of Object.entries(r.memberShares)) {
      const fid = c.memberById[mid].familyId;
      fam[fid].members[mid] = (fam[fid].members[mid] || 0) + v;
    }
  }

  for (const p of live(doc, 'payments')) {
    const rate = rateOf(doc, p.cur);
    const v = (Number(p.amount) || 0) * (Number.isFinite(rate) ? rate : 0);
    if (fam[p.from]) fam[p.from].sent += v;
    if (fam[p.to]) fam[p.to].received += v;
  }

  const balances = {};
  for (const [fid, f] of Object.entries(fam)) {
    f.balance = f.paid - f.share + f.sent - f.received;
    balances[fid] = f.balance;
  }

  const people = c.members.length;
  const weightSum = c.members.reduce((s, m) => s + memberCoef(doc, m), 0);
  return { total, families: fam, transfers: settle(balances, cur), errors, byExpense, people, weightSum };
}
