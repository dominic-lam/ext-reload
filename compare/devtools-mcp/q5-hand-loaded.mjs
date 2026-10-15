// Q5, the everyday case, done properly: an unpacked extension installed through chrome://extensions' own
// code path (not CDP), so it survives a browser restart the way a Load-unpacked extension does. Then:
// does the server list and reload it, and does it still exist after the next browser restart?
//
// Getting a non-CDP install without a native folder picker: load over CDP, break the manifest, let
// chrome://extensions reload it (developerPrivate.reload fails and hands back a retryGuid for that folder), fix
// the manifest, and load it with developerPrivate.loadUnpacked({retryGuid}) — the "Retry" button's path, which
// is the page's own UnpackedInstaller, without the INSTALLED_VIA_CDP mark.
import fs from 'node:fs';
import path from 'node:path';
import { WORK, freshDir, writeToy, launchChrome, cdp, startMcp, wait, workersFrom } from './lib.mjs';

const headless = process.env.HEADLESS !== '0';
const log = s => console.log(s);
const root = freshDir('hand-loaded');
const toy = path.join(root, 'toy');
writeToy(toy, { mark: 'a' });
const profile = path.join(root, 'profile');
const PORT = 9345;
const VIA_CDP = 1 << 15;  // Extension::INSTALLED_VIA_CDP; Chrome deletes such extensions at startup
let ch;

async function page(c, url = 'chrome://extensions') {
  const { targetId } = (await c.send('Target.createTarget', { url })).result;
  const { sessionId } = (await c.send('Target.attachToTarget', { targetId, flatten: true })).result;
  await wait(1000);
  return {
    targetId,
    ev: async expr => {
      const r = await c.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }, sessionId);
      return r.result?.result?.value ?? r.result?.exceptionDetails?.exception?.description ?? r.error;
    },
  };
}
const installed = p => p.ev(`chrome.developerPrivate.getExtensionsInfo({includeDisabled: true}).then(l => l.filter(e => e.location !== 'COMPONENT').map(e => e.name + ' ' + e.version + ' ' + e.location + ' ' + e.state))`);

async function restart(label) {
  const c = await cdp(PORT);
  await c.send('Browser.close');
  c.close();
  await new Promise(r => ch.proc.exitCode != null ? r() : ch.proc.on('exit', r));
  const flags = ['Preferences', 'Secure Preferences'].map(f => {
    try { return JSON.parse(fs.readFileSync(path.join(profile, 'Default', f), 'utf8')).extensions?.settings?.[id]?.creation_flags; } catch { return undefined; }
  }).find(v => v != null);
  log(`[${label}] saved creation_flags for the toy: ${flags} (INSTALLED_VIA_CDP bit ${flags != null && (flags & VIA_CDP) ? 'SET' : 'clear'})`);
  ch = await launchChrome({ profile, port: PORT, headless });
  await wait(1500);
  const c2 = await cdp(PORT);
  const p = await page(c2);
  log(`[${label}] after restart, chrome://extensions has: ${JSON.stringify(await installed(p))}`);
  c2.close();
}

let id;
try {
  ch = await launchChrome({ profile, port: PORT, headless });
  log(`browser: ${ch.version.Browser}, no --enable-unsafe-extension-debugging, headless=${headless}`);
  let c = await cdp(PORT);
  id = (await c.send('Extensions.loadUnpacked', { path: toy })).result?.id;
  const p = await page(c);
  await p.ev('chrome.developerPrivate.updateProfileConfiguration({inDeveloperMode: true})');
  fs.writeFileSync(path.join(toy, 'manifest.json'), '{ broken');
  const err = await p.ev(`chrome.developerPrivate.reload('${id}', {failQuietly: true, populateErrorForUnpacked: true})`);
  log(`developerPrivate.reload with a broken manifest -> retryGuid ${err?.retryGuid}`);
  writeToy(toy, { mark: 'a' });
  const ok = await p.ev(`chrome.developerPrivate.loadUnpacked({failQuietly: true, populateError: true, retryGuid: '${err?.retryGuid}'}).then(r => r ?? 'loaded')`);
  log(`developerPrivate.loadUnpacked({retryGuid}) -> ${JSON.stringify(ok)}`);
  await wait(1000);
  log(`installed: ${JSON.stringify(await installed(p))}`);
  c.close();

  await restart('A: after the chrome://extensions install');

  log('\n--- chrome-devtools-mcp --browserUrl --categoryExtensions, on the hand-loaded extension ---');
  const m = await startMcp(['--categoryExtensions', `--browserUrl=http://127.0.0.1:${PORT}`, `--filesystemRoot=${WORK}`], { via: process.env.VIA ?? 'npx', log });
  try {
    await m.call('list_extensions');
    writeToy(toy, { mark: 'b' });
    await m.call('reload_extension', { id });
    await wait(1000);
    const sw = workersFrom((await m.call('list_pages')).text).filter(w => w.url.includes(id)).at(-1);
    if (sw) await m.call('evaluate_script', { serviceWorkerId: sw.id, function: 'async () => ({ MARK: self.MARK, ...(await chrome.storage.local.get(null)) })' });
  } finally { await m.close(); }

  await restart('B: after reload_extension');
} finally {
  await ch?.close();
}
