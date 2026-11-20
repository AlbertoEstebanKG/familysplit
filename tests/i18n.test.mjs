// Все ключи, используемые в интерфейсе, переведены на все три языка.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { _dicts } from '../js/i18n.js';

const src = readFileSync(new URL('../js/app.js', import.meta.url), 'utf8');
const used = new Set([...src.matchAll(/\bt\('([^']+)'/g)].map((m) => m[1]).filter((k) => !k.endsWith('.')));
const prefixed = { 'cat.': ['adult', 'teen', 'child', 'infant'], 'catAge.': ['adult', 'teen', 'child', 'infant'],
  'mode.': ['shares', 'person', 'family', 'exact'], 'modeShort.': ['shares', 'person', 'family', 'exact'], 'modeHint.': ['shares', 'person', 'family', 'exact'],
  'err.': ['noAmount', 'noRate', 'noPayer', 'paidMismatch', 'exactMismatch', 'noParticipants'], 'sync.': ['local', 'idle', 'syncing', 'offline', 'error'] };
for (const [p, ks] of Object.entries(prefixed)) ks.forEach((k) => used.add(p + k));

for (const lang of ['ru', 'en', 'ky']) {
  test(`перевод ${lang} полный`, () => {
    const missing = [...used].filter((k) => !(k in _dicts[lang]));
    assert.deepEqual(missing, []);
    const extra = Object.keys(_dicts.ru).filter((k) => !(k in _dicts[lang]));
    assert.deepEqual(extra, []);
  });
}
