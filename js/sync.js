// Облачная синхронизация через Supabase (REST RPC, без SDK) и шаринг ссылкой-снимком.

import { SUPABASE_URL, SUPABASE_ANON_KEY, POLL_INTERVAL } from './config.js';
import { merge, hasNewer } from './model.js';
import { loadEvent, saveEvent, mergeIn, indexEntry, updateIndex, subscribe } from './store.js';

const cfg = { url: SUPABASE_URL, key: SUPABASE_ANON_KEY, poll: POLL_INTERVAL };
/** Для тестов и ручной настройки. */
export function configureCloud(patch) { Object.assign(cfg, patch); }
export const cloudEnabled = () => Boolean(cfg.url && cfg.key);

async function rpc(fn, args) {
  const res = await fetch(`${cfg.url.replace(/\/$/, '')}/rest/v1/rpc/${fn}`, {
    method: 'POST',
    headers: {
      apikey: cfg.key,
      // Старые anon-ключи (JWT) передаются и в Authorization; новые publishable — только в apikey
      ...(cfg.key.startsWith('eyJ') ? { Authorization: `Bearer ${cfg.key}` } : {}),
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(args),
  });
  if (!res.ok) throw new Error(`${fn}: HTTP ${res.status}`);
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

const status = new Map(); // id → 'idle' | 'syncing' | 'offline' | 'error'
const statusListeners = new Set();
export function onStatus(fn) { statusListeners.add(fn); return () => statusListeners.delete(fn); }
export function getStatus(id) { return status.get(id) || (cloudEnabled() ? 'idle' : 'local'); }
function setStatus(id, s) { status.set(id, s); statusListeners.forEach((fn) => fn(id, s)); }

/** Скачать мероприятие из облака (для входа по ссылке). null — не найдено. */
export async function fetchRemote(id) {
  const r = await rpc('fs_get_event', { p_id: id, p_since_rev: 0 });
  if (!r || !r.doc) return null;
  return { doc: r.doc, rev: r.rev };
}

const running = new Map(); // id → Promise (не запускаем две синхронизации одного мероприятия параллельно)
const again = new Set();

/** Один цикл: забрать новое с сервера → слить → отправить своё, если есть что. */
export function syncEvent(id) {
  if (!cloudEnabled()) return Promise.resolve();
  if (running.has(id)) { again.add(id); return running.get(id); }
  const p = (async () => {
    setStatus(id, 'syncing');
    try {
      for (let attempt = 0; attempt < 5; attempt++) {
        const entry = indexEntry(id) || {};
        let rev = entry.rev || 0;
        const r = await rpc('fs_get_event', { p_id: id, p_since_rev: rev });
        let remote = null;
        if (r) {
          if (r.doc) { remote = r.doc; mergeIn(remote, 'remote'); }
          rev = r.rev;
          updateIndex(id, { rev, remoteSeen: true });
        } else {
          rev = 0;
        }
        const seq = indexEntry(id)?.editSeq || 0;
        const local = loadEvent(id);
        if (!local) break;
        // Если сервер не прислал документ (ревизия не менялась) — считаем, что там
        // ровно то, что мы видели в прошлый раз; отправляем, только если есть локальные правки.
        const dirty = (entry.pushedSeq || 0) < seq || !r || (remote && hasNewer(local, remote));
        if (!dirty) break;
        const newRev = await rpc('fs_put_event', { p_id: id, p_doc: local, p_rev: rev });
        if (newRev > 0) { updateIndex(id, { rev: newRev, pushedSeq: seq }); break; }
        // конфликт: кто-то записал раньше нас — повторяем со слиянием
        updateIndex(id, { rev: 0 });
      }
      setStatus(id, 'idle');
    } catch (err) {
      console.warn('sync', err);
      setStatus(id, navigator.onLine === false ? 'offline' : 'error');
    } finally {
      running.delete(id);
      if (again.delete(id)) syncEvent(id);
    }
  })();
  running.set(id, p);
  return p;
}

// Локальные правки помечаем «грязными» и отправляем с небольшой задержкой.
const timers = new Map();
subscribe((id, source) => {
  if (source !== 'local' || !cloudEnabled()) return;
  updateIndex(id, { editSeq: (indexEntry(id)?.editSeq || 0) + 1 });
  clearTimeout(timers.get(id));
  timers.set(id, setTimeout(() => syncEvent(id), 700));
});

let pollTimer = null;
let currentId = null;
/** Держать открытое мероприятие в актуальном состоянии (опрос сервера). */
export function watch(id) {
  currentId = id;
  clearInterval(pollTimer);
  if (!cloudEnabled() || !id) return;
  syncEvent(id);
  pollTimer = setInterval(() => {
    if (document.visibilityState === 'visible') syncEvent(currentId);
  }, cfg.poll);
}
if (typeof window !== 'undefined') {
  window.addEventListener('focus', () => currentId && syncEvent(currentId));
  window.addEventListener('online', () => currentId && syncEvent(currentId));
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && currentId) syncEvent(currentId);
  });
}

// ── Ссылка-снимок (работает без облака) ──
function b64url(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function unb64url(str) {
  const s = atob(str.replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(s, (c) => c.charCodeAt(0));
}
async function pipe(bytes, stream) {
  const out = new Response(new Blob([bytes]).stream().pipeThrough(stream));
  return new Uint8Array(await out.arrayBuffer());
}

export async function encodeSnapshot(doc) {
  const json = new TextEncoder().encode(JSON.stringify(doc));
  if (typeof CompressionStream !== 'undefined') return 'z' + b64url(await pipe(json, new CompressionStream('deflate-raw')));
  return 'j' + b64url(json);
}

export async function decodeSnapshot(code) {
  const kind = code[0];
  let bytes = unb64url(code.slice(1));
  if (kind === 'z') bytes = await pipe(bytes, new DecompressionStream('deflate-raw'));
  const doc = JSON.parse(new TextDecoder().decode(bytes));
  if (!doc || !doc.id || !doc.meta) throw new Error('bad snapshot');
  return doc;
}

export function appBaseUrl() {
  return location.href.split('#')[0];
}
export function joinLink(id) {
  return `${appBaseUrl()}#/e/${id}`;
}
export async function snapshotLink(doc) {
  return `${appBaseUrl()}#/import/${await encodeSnapshot(doc)}`;
}

export { merge };
export { saveEvent };
