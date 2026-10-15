// ext-reload helper. Reloads unpacked extensions when ext-reload.mjs asks.
// The CLI writes inbox/request.json inside this folder; an unpacked extension reads its own files fresh
// from disk, so polling that file is the whole channel. Answers go back by POST to the port in the request.

const INBOX = chrome.runtime.getURL('inbox/request.json');
const POLL_MS = 250;
const SELF_RELOAD_ASK_MS = 1000;   // an extension with the dev hook answers in a few ms
const SELF_RELOAD_BACK_MS = 5000;  // ...and is loaded again well inside this

// Kept in storage.local, not memory: after reload-self this worker starts over while the same request is
// still on disk, and a memory-only check would reload itself again until the request expired.
let lastNonce = chrome.storage.local.get('lastNonce').then(r => r.lastNonce ?? null);
let busy = false;

async function poll() {
  if (busy) return;
  let req;
  try {
    req = await (await fetch(INBOX, { cache: 'no-store' })).json();
  } catch {
    return;  // no request yet: the CLI creates the file on first use
  }
  if (req.nonce === await lastNonce || !(Date.now() < req.expires)) return;
  busy = true;
  lastNonce = Promise.resolve(req.nonce);
  await chrome.storage.local.set({ lastNonce: req.nonce });
  try {
    await answer(req, { phase: 'received' });
    await answer(req, { phase: 'done', ...(await handle(req)) });
  } finally {
    busy = false;
  }
}

function answer(req, body) {
  return fetch(`http://127.0.0.1:${req.port}/`, {
    method: 'POST',
    body: JSON.stringify({ nonce: req.nonce, ...body }),
  }).catch(() => {});  // the CLI gave up waiting
}

setInterval(poll, POLL_MS);
// An extension API call resets the worker's idle timer (Chrome 110+), so this keeps it polling. The alarm
// restarts a worker Chrome stopped anyway; starting is all it needs to do.
setInterval(() => chrome.runtime.getPlatformInfo(), 20_000);
chrome.alarms.create('wake', { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener(() => {});
chrome.runtime.onStartup.addListener(() => chrome.storage.local.set({ browserStart: Date.now() }));

// Chrome reads an unpacked manifest.json only at browser start and on a full reload (the Reload button,
// chrome.runtime.reload). Remember when, so the CLI can tell whether a manifest edit is loaded.
chrome.management.onInstalled.addListener(async info => {
  const { loads = {} } = await chrome.storage.local.get('loads');
  loads[info.id] = Date.now();
  await chrome.storage.local.set({ loads });
});

async function handle(req) {
  try {
    if (req.action === 'ping') {
      return { ok: true, helperVersion: chrome.runtime.getManifest().version, extensions: await devExtensions() };
    }
    if (req.action === 'reload') return await reload(req);
    if (req.action === 'reload-self') {
      setTimeout(() => chrome.runtime.reload(), 300);  // after the answer has gone
      return { ok: true };
    }
    return { ok: false, error: `unknown action: ${req.action}` };
  } catch (e) {
    return { ok: false, error: String(e?.message ?? e) };
  }
}

async function devExtensions() {
  const { loads = {}, browserStart = null } = await chrome.storage.local.get(['loads', 'browserStart']);
  return (await chrome.management.getAll())
    .filter(e => e.installType === 'development' && e.id !== chrome.runtime.id)
    .map(e => ({
      id: e.id, name: e.name, version: e.version, enabled: e.enabled,
      lastFullLoad: Math.max(loads[e.id] ?? 0, browserStart ?? 0) || null,
    }));
}

async function reload({ ids, all, tabs }) {
  const dev = await devExtensions();
  const targets = all ? dev.filter(e => e.enabled) : ids.map(id => dev.find(e => e.id === id));
  if (targets.some(t => t == null)) return { ok: false, error: 'not-loaded', extensions: dev };

  const results = [];
  for (const t of targets) {
    results.push(t.enabled ? await reloadOne(t) : { ...t, ok: false, error: 'turned off in Chrome; left alone' });
  }
  const tabResult = tabs?.length ? await reloadTabs(tabs) : null;
  return { ok: results.every(r => r.ok), results, tabs: tabResult };
}

// A full reload when the extension has the dev hook (README), else off and on again, which re-reads the
// service worker and content scripts from disk but keeps the manifest Chrome already has.
async function reloadOne(t) {
  const back = cameBack(t.id, SELF_RELOAD_BACK_MS);
  if (await askToReloadItself(t.id)) {
    const loaded = await back.promise;
    const info = loaded && await chrome.management.get(t.id).catch(() => null);
    if (!info?.enabled) {
      return { ...t, ok: false, method: 'self', error: 'agreed to reload itself but is not back on within 5 s; look for a load error at chrome://extensions' };
    }
    return { id: info.id, name: info.name, version: info.version, ok: true, method: 'self', lastFullLoad: Date.now() };
  }
  back.cancel();
  await chrome.management.setEnabled(t.id, false);
  await chrome.management.setEnabled(t.id, true);
  const info = await chrome.management.get(t.id);
  return { id: info.id, name: info.name, version: info.version, ok: info.enabled, method: 'toggle', lastFullLoad: t.lastFullLoad };
}

async function askToReloadItself(id) {
  const ask = chrome.runtime.sendMessage(id, { type: 'ext-reload' }).catch(() => null);
  const timeout = new Promise(resolve => setTimeout(() => resolve(null), SELF_RELOAD_ASK_MS));
  return (await Promise.race([ask, timeout]))?.ok === true;
}

function cameBack(id, ms) {
  let finish;
  const promise = new Promise(resolve => {
    const listener = info => { if (info.id === id) finish(info); };
    const timer = setTimeout(() => finish(null), ms);
    finish = value => {
      chrome.management.onInstalled.removeListener(listener);
      clearTimeout(timer);
      resolve(value);
    };
    chrome.management.onInstalled.addListener(listener);
  });
  return { promise, cancel: () => finish(null) };
}

// Normal windows only: a YouTube Music app window matches *.youtube.com too. A tab playing sound is left
// alone so a reload never stops the user's music or video.
async function reloadTabs(patterns) {
  const reloaded = [];
  const skipped = [];
  for (const tab of await chrome.tabs.query({ url: patterns, windowType: 'normal' })) {
    if (tab.audible) {
      skipped.push({ url: tab.url, title: tab.title, why: 'playing sound' });
      continue;
    }
    await chrome.tabs.reload(tab.id);
    reloaded.push({ url: tab.url, title: tab.title });
  }
  return { reloaded, skipped };
}
