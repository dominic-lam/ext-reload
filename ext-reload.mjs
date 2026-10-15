#!/usr/bin/env node
// Reload an unpacked extension in your running Chrome through the ext-reload helper extension, then reload
// the tabs its content scripts run on. Setup, the dev hook and exit codes: README.md.

import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const INBOX = path.join(HERE, 'extension', 'inbox');
const EXIT = { ok: 0, failed: 1, notLoaded: 2, staleManifest: 3, noHelper: 4 };
const NOTICE_MS = 3000;
const WAKE_MS = 35_000;  // the helper's alarm restarts a stopped worker every 30 s

const USAGE = `Usage: ext-reload.mjs [extension folder] [options]

Reloads the unpacked extension in that folder (default: the current one, or the nearest parent with a
manifest.json), then reloads the tabs its content scripts match.

  --tabs <pattern>   reload tabs matching this pattern instead (repeatable)
  --no-tabs          reload no tabs
  --id <id>          reload this extension id instead of the folder's (repeatable)
  --all              reload every unpacked extension that is turned on
  --ping             check the helper answers, and list the unpacked extensions Chrome has
  --self             reload the helper itself, after editing its code
  --timeout <s>      how long to wait for the result once the helper has the request (default 20)`;

function parseArgs(argv) {
  const opts = { dir: null, tabs: null, noTabs: false, ids: [], all: false, ping: false, self: false, timeout: 20 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--tabs') (opts.tabs ??= []).push(argv[++i]);
    else if (a === '--no-tabs') opts.noTabs = true;
    else if (a === '--id') opts.ids.push(argv[++i]);
    else if (a === '--all') opts.all = true;
    else if (a === '--ping') opts.ping = true;
    else if (a === '--self') opts.self = true;
    else if (a === '--timeout') opts.timeout = Number(argv[++i]);
    else if (a === '-h' || a === '--help') { console.log(USAGE); process.exit(EXIT.ok); }
    else if (a.startsWith('-')) fail(EXIT.failed, `Unknown option ${a}\n\n${USAGE}`);
    else opts.dir = a;
  }
  return opts;
}

function fail(code, message) {
  console.error(message);
  process.exit(code);
}

function findExtension(start) {
  for (let dir = path.resolve(start); ; dir = path.dirname(dir)) {
    const file = path.join(dir, 'manifest.json');
    if (fs.existsSync(file)) {
      const manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (manifest.manifest_version != null) return { dir, file, manifest };
    }
    if (dir === path.dirname(dir)) return null;
  }
}

// Chrome's id for an unpacked extension: from the manifest's key if it has one, else from the folder's
// real path (symlinks resolved), hashed and written with the letters a-p.
function extensionId(dir, manifest) {
  const source = manifest.key ? Buffer.from(manifest.key, 'base64') : Buffer.from(fs.realpathSync(dir));
  const hex = crypto.createHash('sha256').update(source).digest('hex').slice(0, 32);
  return [...hex].map(d => String.fromCharCode(97 + parseInt(d, 16))).join('');
}

function displayName({ dir, manifest }) {
  const msg = /^__MSG_(\w+)__$/.exec(manifest.name ?? '');
  if (!msg) return manifest.name;
  try {
    const file = path.join(dir, '_locales', manifest.default_locale, 'messages.json');
    const messages = JSON.parse(fs.readFileSync(file, 'utf8'));
    const key = Object.keys(messages).find(k => k.toLowerCase() === msg[1].toLowerCase());
    return messages[key]?.message ?? manifest.name;
  } catch {
    return manifest.name;
  }
}

// Patterns for any host (<all_urls>, *://*/*) would reload every tab the user has open, so they are left out.
function contentScriptTabs(manifest) {
  const all = [...new Set((manifest.content_scripts ?? []).flatMap(cs => cs.matches ?? []))];
  const anyHost = p => p === '<all_urls>' || /^[^:]+:\/\/\*\//.test(p);
  return { patterns: all.filter(p => !anyHost(p)), leftOut: all.filter(anyHost) };
}

// A quick look at the process list, so a closed Chrome fails at once instead of after the 35 s wait.
// true or false where it can tell; null where it cannot (no pgrep, another platform), and then the wait
// reports exit 4 by itself. EXT_RELOAD_SKIP_CHROME_CHECK=1 skips it: test.mjs drives Playwright's Chromium,
// and a Chrome channel or Chromium-based browser under another process name would fail it.
function chromeIsRunning() {
  if (process.env.EXT_RELOAD_SKIP_CHROME_CHECK) return null;
  try {
    if (process.platform === 'win32') {
      const out = execFileSync('tasklist', ['/FI', 'IMAGENAME eq chrome.exe', '/FO', 'CSV', '/NH'],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
      return /^"chrome\.exe"/im.test(out);
    }
    // Linux truncates process names to 15 characters: chromium-browser shows as chromium-browse.
    const names = { darwin: ['Google Chrome'], linux: ['chrome', 'chromium', 'chromium-browse'] }[process.platform];
    if (!names) return null;
    for (const name of names) {
      try {
        execFileSync('pgrep', ['-x', name], { stdio: 'ignore' });
        return true;
      } catch (err) {
        if (err.status !== 1) return null;  // 1 is "no match"; anything else, pgrep missing included, is unknown
      }
    }
    return false;
  } catch {
    return null;
  }
}

function time(ms) {
  return new Date(ms).toLocaleTimeString('en-GB');
}

// Write the request where the helper polls for it, and collect its two answers: "received" as soon as it
// sees the request, then "done" with the result.
function send(request, timeoutSec) {
  return new Promise((resolve, reject) => {
    const nonce = crypto.randomUUID();
    let notice = null;
    let deadline = null;
    const server = http.createServer((req, res) => {
      let body = '';
      req.on('data', d => { body += d; });
      req.on('end', () => {
        // Without close, Node before 19 keeps the helper's keep-alive socket, and the process, open 5 s more.
        res.writeHead(204, { Connection: 'close' }).end();
        let msg;
        try { msg = JSON.parse(body); } catch { return; }
        if (msg.nonce !== nonce) return;
        if (msg.phase === 'received') {
          clearTimeout(notice);
          clearTimeout(deadline);
          deadline = setTimeout(() => finish(new Error(`The helper took the request but sent no result within ${timeoutSec} s.`)), timeoutSec * 1000);
        } else if (msg.phase === 'done') {
          finish(null, msg);
        }
      });
    });
    const finish = (err, msg) => {
      clearTimeout(notice);
      clearTimeout(deadline);
      server.close();
      fs.rmSync(path.join(INBOX, 'request.json'), { force: true });
      err ? reject(err) : resolve(msg);
    };
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      const expires = Date.now() + WAKE_MS + timeoutSec * 1000;
      fs.mkdirSync(INBOX, { recursive: true });
      const tmp = path.join(INBOX, 'request.json.tmp');
      fs.writeFileSync(tmp, JSON.stringify({ ...request, nonce, port, expires }));
      fs.renameSync(tmp, path.join(INBOX, 'request.json'));  // atomic: the helper never reads half a file
      notice = setTimeout(() => console.error('No answer from the helper yet. If Chrome stopped its worker, it wakes within 30 s...'), NOTICE_MS);
      deadline = setTimeout(() => {
        const err = new Error(`No answer from the ext-reload helper in ${WAKE_MS / 1000} s. Either Chrome is not running, or the helper is not loaded in it. One-time setup: ${path.join(HERE, 'README.md')}`);
        err.code = EXIT.noHelper;
        finish(err);
      }, WAKE_MS);
    });
  });
}

function listExtensions(extensions) {
  return extensions.map(e => `  ${e.name} ${e.version}  ${e.id}${e.enabled ? '' : '  (turned off)'}`).join('\n') || '  (none)';
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (chromeIsRunning() === false) {
    fail(EXIT.noHelper, 'Chrome is not running. If it is, under a process name this check does not know (another channel, or another Chromium-based browser), set EXT_RELOAD_SKIP_CHROME_CHECK=1.');
  }

  let request;
  let target = null;
  if (opts.ping) request = { action: 'ping' };
  else if (opts.self) request = { action: 'reload-self' };
  else {
    target = findExtension(opts.dir ?? process.cwd());
    if (target == null && !opts.all && opts.ids.length === 0) {
      fail(EXIT.failed, `No manifest.json in ${path.resolve(opts.dir ?? '.')} or any folder above it. Pass the extension folder, --id or --all.`);
    }
    const ids = opts.ids.length ? opts.ids : target && !opts.all ? [extensionId(target.dir, target.manifest)] : [];
    let tabs = [];
    if (opts.tabs) tabs = opts.tabs;
    else if (!opts.noTabs && target) {
      const found = contentScriptTabs(target.manifest);
      tabs = found.patterns;
      if (found.leftOut.length) console.log(`Not reloading tabs for ${found.leftOut.join(', ')}: that is every site. Pass --tabs to choose.`);
    }
    request = { action: 'reload', all: opts.all, ids, tabs };
  }

  let reply;
  try {
    reply = await send(request, opts.timeout);
  } catch (err) {
    fail(err.code ?? EXIT.failed, err.message);
  }

  if (opts.ping) {
    console.log(`Helper ${reply.helperVersion} is answering. Unpacked extensions in Chrome:\n${listExtensions(reply.extensions)}`);
    return EXIT.ok;
  }
  if (opts.self) {
    console.log('Helper is reloading itself.');
    return EXIT.ok;
  }
  if (reply.error === 'not-loaded') {
    const lines = [`Chrome has no unpacked extension with id ${request.ids.join(', ')}${target ? `, the id for ${target.dir}` : ''}.`];
    const name = target && displayName(target);
    const sameName = reply.extensions.find(e => e.name === name);
    if (sameName) lines.push(`${name} is loaded from a different folder (id ${sameName.id}). A worktree? Chrome runs that folder's code, not this one's.`);
    lines.push(`Unpacked extensions in Chrome:\n${listExtensions(reply.extensions)}`);
    fail(EXIT.notLoaded, lines.join('\n'));
  }
  if (reply.results == null) fail(EXIT.failed, `The helper failed: ${reply.error}`);

  let code = reply.ok ? EXIT.ok : EXIT.failed;
  for (const r of reply.results) {
    if (!r.ok) {
      console.log(`Failed: ${r.name}: ${r.error}`);
    } else if (r.method === 'self') {
      console.log(`Reloaded ${r.name} ${r.version}: a full reload, manifest.json included.`);
    } else {
      console.log(`Reloaded ${r.name} ${r.version}: service worker and content scripts read again from disk.`);
      if (target == null || r.id !== extensionId(target.dir, target.manifest)) continue;
      const edited = fs.statSync(target.file).mtimeMs;
      if (r.lastFullLoad == null) {
        console.log(`Not checked: whether Chrome has the current manifest.json. The helper has not seen ${r.name} load since it was installed.`);
      } else if (edited > r.lastFullLoad) {
        console.log(`manifest.json changed at ${time(edited)}, after Chrome last read it at ${time(r.lastFullLoad)}; this reload does not pick that up. It needs the Reload button on ${r.name}'s card at chrome://extensions, or the dev hook in the README.`);
        if (code === EXIT.ok) code = EXIT.staleManifest;
      }
    }
  }
  if (reply.tabs) {
    const { reloaded, skipped } = reply.tabs;
    console.log(reloaded.length ? `Reloaded ${reloaded.length} tab(s):` : 'No matching tabs were open.');
    for (const t of reloaded) console.log(`  ${t.title} | ${t.url}`);
    for (const t of skipped) console.log(`Left alone (${t.why}), so it still runs the old content scripts: ${t.title} | ${t.url}`);
  }
  return code;
}

process.exitCode = await main();
