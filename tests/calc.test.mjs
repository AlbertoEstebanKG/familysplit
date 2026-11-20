// Запуск: node --test tests/
import test from 'node:test';
import assert from 'node:assert/strict';
import { newEvent, put, remove, merge, hasNewer, removeFamily, live } from '../js/model.js';
import { computeEvent, splitExpense, settle } from '../js/calc.js';

function base() {
  let d = newEvent({ name: 'Иссык-Куль', days: 3 });
  d = put(d, 'families', { id: 'A', name: 'Асановы' });
  d = put(d, 'families', { id: 'B', name: 'Беловы' });
  d = put(d, 'families', { id: 'C', name: 'Каримовы' });
  // A: 2 взрослых + ребёнок; B: 2 взрослых; C: взрослый + подросток + малыш
  d = put(d, 'members', { id: 'a1', familyId: 'A', name: 'Азамат', cat: 'adult', days: null });
  d = put(d, 'members', { id: 'a2', familyId: 'A', name: 'Айгуль', cat: 'adult', days: null });
  d = put(d, 'members', { id: 'a3', familyId: 'A', name: 'Нурик', cat: 'child', days: null });
  d = put(d, 'members', { id: 'b1', familyId: 'B', name: 'Борис', cat: 'adult', days: [0, 1] });
  d = put(d, 'members', { id: 'b2', familyId: 'B', name: 'Вера', cat: 'adult', days: [0, 1] });
  d = put(d, 'members', { id: 'c1', familyId: 'C', name: 'Камила', cat: 'adult', days: null });
  d = put(d, 'members', { id: 'c2', familyId: 'C', name: 'Тимур', cat: 'teen', days: null });
  d = put(d, 'members', { id: 'c3', familyId: 'C', name: 'Малыш', cat: 'infant', days: null });
  return d;
}

const near = (a, b, eps = 0.01) => assert.ok(Math.abs(a - b) < eps, `${a} ≉ ${b}`);

test('деление по коэффициентам: взрослый 1, подросток 0.75, ребёнок 0.5, малыш 0', () => {
  let d = base();
  d = put(d, 'expenses', { id: 'e1', title: 'Продукты', amount: 6250, cur: 'KGS', paid: { A: 6250 }, mode: 'shares' });
  const r = computeEvent(d);
  // веса: A=2.5, B=2, C=1.75 → всего 6.25 → 1000 за долю
  near(r.families.A.share, 2500);
  near(r.families.B.share, 2000);
  near(r.families.C.share, 1750);
  near(r.families.A.balance, 3750);
  assert.equal(r.total, 6250);
  near(r.families.C.members.c3 || 0, 0);
});

test('расход за весь период с учётом дней присутствия', () => {
  let d = base();
  // B были 2 дня из 3 → вес 2 * 2/3
  d = put(d, 'expenses', { id: 'e1', title: 'Аренда', amount: 9000, cur: 'KGS', paid: { C: 9000 }, mode: 'person', byDays: true });
  const r = computeEvent(d);
  // по людям: A=3, B=2*(2/3)=1.333, C=3 → 7.333
  near(r.families.A.share, 9000 * 3 / (22 / 3));
  near(r.families.B.share, 9000 * (4 / 3) / (22 / 3));
});

test('расход в конкретный день: отсутствующие не платят', () => {
  let d = base();
  d = put(d, 'expenses', { id: 'e1', title: 'Ужин', amount: 4250, cur: 'KGS', paid: { A: 4250 }, mode: 'shares', day: 2 });
  const r = computeEvent(d);
  near(r.families.B.share, 0);
  near(r.families.A.share, 2500); // 2.5 / 4.25
});

test('только взрослые (список участников)', () => {
  let d = base();
  d = put(d, 'expenses', { id: 'e1', title: 'Вино', amount: 5000, cur: 'KGS', paid: { B: 5000 }, mode: 'shares', parts: ['a1', 'a2', 'b1', 'b2', 'c1'] });
  const r = computeEvent(d);
  near(r.families.A.share, 2000);
  near(r.families.C.share, 1000);
});

test('индивидуальные веса в расходе переопределяют категорию', () => {
  let d = base();
  d = put(d, 'expenses', { id: 'e1', title: 'Сапсерф', amount: 3000, cur: 'KGS', paid: { A: 3000 }, mode: 'shares', parts: ['a3', 'c2'], weights: { a3: 1, c2: 2 } });
  const r = computeEvent(d);
  near(r.families.A.share, 1000);
  near(r.families.C.share, 2000);
});

test('поровну на семью', () => {
  let d = base();
  d = put(d, 'expenses', { id: 'e1', title: 'Мангал', amount: 900, cur: 'KGS', paid: { A: 900 }, mode: 'family' });
  const r = computeEvent(d);
  near(r.families.B.share, 300);
});

test('вручную: суммы должны сойтись', () => {
  let d = base();
  d = put(d, 'expenses', { id: 'e1', title: 'Такси', amount: 1000, cur: 'KGS', paid: { A: 1000 }, mode: 'exact', exact: { A: 200, B: 300, C: 400 } });
  assert.equal(computeEvent(d).errors[0].code, 'exactMismatch');
  d = put(d, 'expenses', { id: 'e1', exact: { A: 200, B: 300, C: 500 } });
  const r = computeEvent(d);
  assert.equal(r.errors.length, 0);
  near(r.families.C.share, 500);
});

test('несколько плательщиков и мультивалюта', () => {
  let d = base();
  d = put(d, 'rates', { id: 'USD', rate: 87.5 });
  d = put(d, 'expenses', { id: 'e1', title: 'Отель', amount: 100, cur: 'USD', paid: { A: 60, B: 40 }, mode: 'family' });
  const r = computeEvent(d);
  near(r.total, 8750);
  near(r.families.A.paid, 5250);
  near(r.families.B.paid, 3500);
  near(r.families.A.share, 8750 / 3);
});

test('нет курса — ошибка, расход не учитывается', () => {
  let d = base();
  d = put(d, 'expenses', { id: 'e1', title: 'X', amount: 10, cur: 'EUR', paid: { A: 10 }, mode: 'family' });
  const r = computeEvent(d);
  assert.equal(r.errors[0].code, 'noRate');
  assert.equal(r.total, 0);
});

test('сумма плательщиков не равна сумме расхода — ошибка', () => {
  let d = base();
  d = put(d, 'expenses', { id: 'e1', title: 'X', amount: 1000, cur: 'KGS', paid: { A: 500 }, mode: 'family' });
  assert.equal(computeEvent(d).errors[0].code, 'paidMismatch');
});

test('баланс сходится к нулю, переводы гасят долги, оплата учитывается', () => {
  let d = base();
  d = put(d, 'expenses', { id: 'e1', title: 'Продукты', amount: 6250, cur: 'KGS', paid: { A: 6250 }, mode: 'shares' });
  d = put(d, 'expenses', { id: 'e2', title: 'Бензин', amount: 3000, cur: 'KGS', paid: { B: 3000 }, mode: 'family' });
  let r = computeEvent(d);
  const sum = Object.values(r.families).reduce((s, f) => s + f.balance, 0);
  near(sum, 0);
  // применим предложенные переводы как оплаты — все должны стать в расчёте
  r.transfers.forEach((t, i) => { d = put(d, 'payments', { id: 'p' + i, from: t.from, to: t.to, amount: t.amount, cur: 'KGS' }); });
  r = computeEvent(d);
  assert.equal(r.transfers.length, 0);
});

test('settle: минимальное число переводов в простом случае', () => {
  const t = settle({ A: 300, B: -100, C: -200 }, 'KGS');
  assert.equal(t.length, 2);
  assert.deepEqual(t.map((x) => x.to), ['A', 'A']);
});

test('удаление семьи убирает её людей и платежи из расходов', () => {
  let d = base();
  d = put(d, 'expenses', { id: 'e1', title: 'X', amount: 100, cur: 'KGS', paid: { C: 100 }, mode: 'family' });
  d = removeFamily(d, 'C');
  assert.equal(live(d, 'members').filter((m) => m.familyId === 'C').length, 0);
  assert.equal(computeEvent(d).errors[0].code, 'noPayer');
});

test('слияние: изменения с двух устройств не теряются, удаление побеждает старую версию', () => {
  const d0 = base();
  let phone1 = put(d0, 'expenses', { id: 'x1', title: 'Шашлык', amount: 100, cur: 'KGS', paid: { A: 100 } });
  let phone2 = put(d0, 'expenses', { id: 'x2', title: 'Арбуз', amount: 50, cur: 'KGS', paid: { B: 50 } });
  phone2 = remove(phone2, 'members', 'c3');
  const m1 = merge(phone1, phone2), m2 = merge(phone2, phone1);
  assert.deepEqual(m1, m2);
  assert.ok(m1.expenses.x1 && m1.expenses.x2);
  assert.ok(m1.members.c3.del);
  assert.ok(hasNewer(phone1, phone2));
  assert.ok(!hasNewer(m1, m1));
  assert.deepEqual(merge(m1, m1), m1);
});

test('splitExpense: нулевые веса (только малыш) — ошибка', () => {
  const d = base();
  const r = splitExpense(d, { id: 'z', amount: 100, cur: 'KGS', paid: { A: 100 }, mode: 'shares', parts: ['c3'] });
  assert.equal(r.error, 'noParticipants');
});

test('режим «Друзья»: каждый участник — один человек, поровну и по долям', () => {
  let d = newEvent({ name: 'Рыбалка', days: 2, kind: 'friends' });
  assert.equal(d.meta.kind, 'friends');
  for (const [id, days] of [['A', null], ['B', null], ['C', [0]]]) {
    d = put(d, 'families', { id, name: id });
    d = put(d, 'members', { id: 'm' + id, familyId: id, name: id, cat: 'adult', days });
  }
  d = put(d, 'expenses', { id: 'e1', title: 'Бензин', amount: 3000, cur: 'KGS', paid: { A: 3000 }, mode: 'person' });
  d = put(d, 'expenses', { id: 'e2', title: 'Пиво', amount: 1500, cur: 'KGS', paid: { B: 1500 }, mode: 'shares', weights: { mA: 1, mB: 1, mC: 0.5 } });
  d = put(d, 'expenses', { id: 'e3', title: 'Уха', amount: 1000, cur: 'KGS', paid: { C: 1000 }, mode: 'person', day: 1 });
  const r = computeEvent(d);
  near(r.families.C.share, 1000 + 300);           // C не было во 2-й день
  near(r.families.A.share, 1000 + 600 + 500);
  near(Object.values(r.families).reduce((s, f) => s + f.balance, 0), 0);
});
