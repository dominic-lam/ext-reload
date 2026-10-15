#!/usr/bin/env node
// End-to-end check of ext-reload in Playwright's own Chromium: npm install && npx playwright install chromium
// && npm test. It runs on a copy of the CLI and the helper, because a helper loaded in your everyday Chrome
// polls this folder's inbox and would act on test requests too.

import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const HERE = path.dirname(fileURLToPath(import.meta.url));

// The copy starts without extension/inbox/, the way a fresh clone does, so the CLI must create it. It is not a
// git clone, so it runs no update check; test-update.mjs covers that.
const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ext-reload-test-')));
const tool = path.join(tmp, 'tool');
const helperSrc = path.join(HERE, 'extension');
fs.mkdirSync(tool);
fs.copyFileSync(path.join(HERE, 'ext-reload.mjs'), path.join(tool, 'ext-reload.mjs'));
fs.cpSync(helperSrc, path.join(tool, 'extension'), {
  recursive: true,
  filter: src => !/^(inbox|update\.)/.test(path.relative(helperSrc, src).split(path.sep)[0]),
});

const HELPER_ID = 'aedmcelajgmppcepfnehdcnpolaeoajp';  // from the key in extension/manifest.json
const HOOK = `chrome.runtime.onMessageExternal.addListener((msg, sender, reply) => {
  if (sender.id !== '${HELPER_ID}' || msg?.type !== 'ext-reload') return;
  reply({ ok: true });
  setTimeout(() => chrome.runtime.reload(), 50);
});\n`;

function makeExtension(name, { hook = false } = {}) {
  const dir = path.join(tmp, name);
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({
    manifest_version: 3, name, version: '1.0',
    background: { service_worker: 'sw.js' },
    content_scripts: [{ matches: ['http://127.0.0.1/*'], js: ['cs.js'] }],
  }));
  writeCode(dir, name, 'a', hook);
  return dir;
}

function writeCode(dir, name, mark, hook = false) {
  fs.writeFileSync(path.join(dir, 'sw.js'), `self.MARK = '${mark}';\n${hook ? HOOK : ''}`);
  fs.writeFileSync(path.join(dir, 'cs.js'), `document.documentElement.dataset.${name} = '${mark}';\n`);
}

function bumpVersion(dir, version) {
  const file = path.join(dir, 'manifest.json');
  fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(file, 'utf8')), version }));
}

function run(...args) {
  return new Promise(resolve => {
    const started = Date.now();
    const child = spawn(process.execPath, [path.join(tool, 'ext-reload.mjs'), ...args],
      { env: { ...process.env, EXT_RELOAD_SKIP_CHROME_CHECK: '1' } });
    let out = '';
    child.stdout.on('data', d => { out += d; });
    child.stderr.on('data', d => { out += d; });
    child.on('close', code => resolve({ code, out, ms: Date.now() - started }));
  });
}

const wait = ms => new Promise(r => setTimeout(r, ms));
let failures = 0;
function check(label, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `\n      ${detail.replace(/\n/g, '\n      ')}`}`);
  if (!ok) failures++;
}

const plain = makeExtension('plain');
const hooked = makeExtension('hooked', { hook: true });
const plainLink = path.join(tmp, 'plain-link');  // loaded through a symlink: the id comes from the real path
fs.symlinkSync(plain, plainLink);

const server = http.createServer((q, r) => r.end('<html><body>test page</body></html>')).listen(0, '127.0.0.1');
await new Promise(r => server.on('listening', r));
// Loaded the way the Load unpacked button loads them, through CDP. With --load-extension instead, an
// extension that calls chrome.runtime.reload() comes back turned off, which never happens in real Chrome.
const ctx = await chromium.launchPersistentContext(path.join(tmp, 'profile'), {
  channel: 'chromium', headless: true, ignoreDefaultArgs: ['--disable-extensions'],
  args: ['--enable-unsafe-extension-debugging'],
});
// Developer mode on, as in any Chrome that has Load unpacked. From Chromium 156, an unpacked extension that
// reloads while it is off comes back turned off (disable reason unsupportedDeveloperExtension).
const settings = await ctx.newPage();
await settings.goto('chrome://extensions');
await settings.evaluate(() => chrome.developerPrivate.updateProfileConfiguration({ inDeveloperMode: true }));
await settings.close();
const cdp = await ctx.browser().newBrowserCDPSession();
for (const dir of [path.join(tool, 'extension'), hooked, plainLink]) await cdp.send('Extensions.loadUnpacked', { path: dir });

try {
  await wait(1500);
  const page = await ctx.newPage();
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  const marks = () => page.evaluate(() => ({ ...document.documentElement.dataset }));
  const workerOf = async name => {
    const id = new RegExp(`${name} [\\d.]+  (\\w+)`).exec((await run('--ping')).out)?.[1];
    return ctx.serviceWorkers().filter(sw => sw.url().includes(id)).at(-1);
  };

  const inbox = path.join(tool, 'extension', 'inbox');
  const inboxAtStart = fs.existsSync(inbox);
  let r = await run('--ping');
  check(`ping answers and lists both test extensions (${r.ms} ms)`, r.code === 0 && /plain 1\.0/.test(r.out) && /hooked 1\.0/.test(r.out), r.out);
  check('  starting with no extension/inbox/, as in a fresh clone; the CLI created it', !inboxAtStart && fs.existsSync(inbox));

  writeCode(plain, 'plain', 'b');
  r = await run(plainLink);
  await wait(800);
  check(`code edit, no dev hook: exit 0, one tab reloaded (${r.ms} ms)`, r.code === 0 && /Reloaded 1 tab/.test(r.out), r.out);
  check('  the reloaded tab runs the new content script', (await marks()).plain === 'b', JSON.stringify(await marks()));
  check('  the service worker runs the new code', await (await workerOf('plain'))?.evaluate(() => self.MARK) === 'b');
  check('  says it cannot tell whether the manifest is current yet', /Not checked/.test(r.out), r.out);

  // The Reload button at chrome://extensions and chrome.runtime.reload() take the same path in Chrome.
  await (await workerOf('plain')).evaluate(() => chrome.runtime.reload()).catch(() => {});
  await wait(1200);
  bumpVersion(plain, '1.1');
  r = await run(plainLink, '--no-tabs');
  check(`manifest edit after Chrome's last full load, no dev hook: exit 3 (${r.ms} ms)`, r.code === 3 && /manifest\.json changed at/.test(r.out), r.out);

  // A build rewrites manifest.json with the same contents, so its time changes but Chrome's copy is still current.
  const rebuild = () => fs.writeFileSync(path.join(plain, 'manifest.json'), fs.readFileSync(path.join(plain, 'manifest.json')));
  await (await workerOf('plain')).evaluate(() => chrome.runtime.reload()).catch(() => {});
  await wait(1200);
  rebuild();
  r = await run(plainLink, '--no-tabs');
  check(`first rebuild after a full load, same manifest: exit 0, not 3 (${r.ms} ms)`, r.code === 0 && !/manifest\.json changed/.test(r.out), r.out);
  await wait(50);
  rebuild();
  r = await run(plainLink, '--no-tabs');
  check('  and every rebuild after it', r.code === 0 && !/manifest\.json changed/.test(r.out), r.out);
  await wait(50);
  bumpVersion(plain, '1.2');
  r = await run(plainLink, '--no-tabs');
  check('  a real manifest change after them still exits 3', r.code === 3 && /manifest\.json changed at/.test(r.out), r.out);

  writeCode(hooked, 'hooked', 'b', true);
  bumpVersion(hooked, '1.1');
  r = await run(hooked);
  await wait(800);
  check(`manifest edit with the dev hook: full reload, new version, exit 0 (${r.ms} ms)`, r.code === 0 && /hooked 1\.1: a full reload/.test(r.out), r.out);
  check('  the reloaded tab runs its new content script', (await marks()).hooked === 'b', JSON.stringify(await marks()));

  const stranger = path.join(tmp, 'stranger');
  fs.mkdirSync(stranger);
  fs.writeFileSync(path.join(stranger, 'manifest.json'), JSON.stringify({ manifest_version: 3, name: 'plain', version: '1.0' }));
  r = await run(stranger);
  check(`folder Chrome did not load, same name as a loaded one: exit 2, says it is loaded from a different folder (${r.ms} ms)`, r.code === 2 && /different folder/.test(r.out) && /worktree, or a build folder/.test(r.out), r.out);

  // The red dot: the worker reads update.json every 20 s; calling its check directly skips the wait. A drawing
  // or setIcon failure rejects, which fails the check.
  const helper = ctx.serviceWorkers().find(sw => sw.url().includes(HELPER_ID));
  const updateFile = path.join(tool, 'extension', 'update.json');
  const dot = async status => {
    fs.writeFileSync(updateFile, JSON.stringify({ status, current: '1.0.0', latest: '9.0.0' }));
    return helper.evaluate(() => updateDot()).catch(e => `threw: ${e.message}`);
  };
  let d = await dot('available');
  check('update available: the toolbar icon gets the red dot', d === true, String(d));
  d = await dot('current');
  check('  and loses it once up to date', d === false, String(d));
  fs.rmSync(updateFile);

  let helperStarts = 0;
  ctx.on('serviceworker', sw => { if (sw.url().includes(HELPER_ID)) helperStarts++; });
  r = await run('--self');
  await wait(3000);
  check(`--self: exit 0 and the helper restarts exactly once (${r.ms} ms)`, r.code === 0 && helperStarts === 1, `${r.out}\nhelper starts: ${helperStarts}`);
  r = await run('--ping');
  check('  and answers again afterwards', r.code === 0, r.out);
} finally {
  await ctx.close();
  server.close();
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log(failures ? `\n${failures} failed` : '\nAll passed');
process.exitCode = failures ? 1 : 0;
