// Синхронизация двух «устройств» через имитацию сервера Supabase.
import test from 'node:test';
import assert from 'node:assert/strict';

// Два отдельных localStorage — переключаем между «телефонами»
function makeStorage() {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) };
}
const phone1 = makeStorage(), phone2 = makeStorage();
globalThis.localStorage = phone1;

// Сервер с семантикой schema.sql
const db = new Map();
let injectConflict = 0;
globalThis.fetch = async (url, opts) => {
  const fn = url.split('/rpc/')[1];
  const a = JSON.parse(opts.body);
  let out;
  if (fn === 'fs_get_event') {
    const row = db.get(a.p_id);
    out = row ? (row.rev > (a.p_since_rev || 0) ? { rev: row.rev, doc: structuredClone(row.doc) } : { rev: row.rev }) : null;
  } else if (fn === 'fs_put_event') {
    const row = db.get(a.p_id);
    if (injectConflict > 0 && row) { injectConflict--; row.rev++; }
    if (!a.p_rev) { if (row) out = -1; else { db.set(a.p_id, { rev: 1, doc: a.p_doc }); out = 1; } }
    else if (row && row.rev === a.p_rev) { row.rev++; row.doc = a.p_doc; out = row.rev; }
    else out = -1;
  }
  return { ok: true, status: 200, text: async () => (out === null ? '' : JSON.stringify(out)) };
};

const store = await import('../js/store.js');
const sync = await import('../js/sync.js');
const { put, live } = await import('../js/model.js');
sync.configureCloud({ url: 'https://mock', key: 'k' });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

test('два телефона редактируют одно мероприятие и сходятся', async () => {
  globalThis.localStorage = phone1;
  let d = store.createEvent({ name: 'Ала-Арча' });
  const id = d.id;
  d = put(d, 'families', { id: 'F1', name: 'Семья 1' });
  store.saveEvent(d);
  await wait(800); await sync.syncEvent(id);
  assert.equal(db.get(id).doc.families.F1.name, 'Семья 1');

  // Телефон 2 входит по ссылке
  globalThis.localStorage = phone2;
  const r = await sync.fetchRemote(id);
  store.mergeIn(r.doc);
  store.updateIndex(id, { rev: r.rev });
  store.saveEvent(put(store.loadEvent(id), 'families', { id: 'F2', name: 'Семья 2' }));
  await wait(800); await sync.syncEvent(id);

  // Телефон 1 параллельно добавил расход, не видя Семью 2
  globalThis.localStorage = phone1;
  store.saveEvent(put(store.loadEvent(id), 'expenses', { id: 'E1', title: 'Самса', amount: 500, cur: 'KGS', paid: { F1: 500 } }));
  await wait(800); await sync.syncEvent(id);
  const p1 = store.loadEvent(id);
  assert.ok(p1.families.F2, 'телефон 1 получил семью 2');
  assert.ok(p1.expenses.E1);

  globalThis.localStorage = phone2;
  await sync.syncEvent(id);
  const p2 = store.loadEvent(id);
  assert.ok(p2.expenses.E1, 'телефон 2 получил расход');
  assert.deepEqual(live(p1, 'families').map((f) => f.id).sort(), live(p2, 'families').map((f) => f.id).sort());
  assert.deepEqual(db.get(id).doc.expenses, p2.expenses);
});

test('конфликт записи на сервере повторяется со слиянием', async () => {
  globalThis.localStorage = phone1;
  const d = store.createEvent({ name: 'Конфликт' });
  await wait(800); await sync.syncEvent(d.id);
  store.saveEvent(put(store.loadEvent(d.id), 'families', { id: 'X', name: 'X' }));
  injectConflict = 2;
  await wait(800); await sync.syncEvent(d.id);
  assert.ok(db.get(d.id).doc.families.X, 'правка доехала несмотря на конфликт');
  assert.equal(sync.getStatus(d.id), 'idle');
});

test('ссылка-снимок кодируется и раскодируется', async () => {
  const d = store.createEvent({ name: 'Снимок ✓ Ыссык-Көл' });
  const code = await sync.encodeSnapshot(d);
  const back = await sync.decodeSnapshot(code);
  assert.deepEqual(back, d);
});
