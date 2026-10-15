#!/usr/bin/env node
// Reload an unpacked extension in your running Chrome through the ext-reload helper extension, then reload
// the tabs its content scripts run on. Setup, the dev hook, updates and exit codes: README.md.

import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SCRIPT = fileURLToPath(import.meta.url);
const HERE = path.dirname(SCRIPT);
const INBOX = path.join(HERE, 'extension', 'inbox');
const EXIT = { ok: 0, failed: 1, notLoaded: 2, staleManifest: 3, noHelper: 4 };
const NOTICE_MS = 3000;
const WAKE_MS = 35_000;  // the helper's alarm restarts a stopped worker every 30 s
const UPDATE_FILE = path.join(HERE, 'extension', 'update.json');  // the helper's popup reads it too
const UPDATE_LOCK = path.join(HERE, 'extension', 'update.lock');
const CHECK_EVERY_MS = 24 * 60 * 60 * 1000;
const FETCH_MS = 15_000;
const LOCK_STALE_MS = 60_000;
const BACKGROUND = '--update-check-background';  // internal: the detached daily check

const USAGE = `Usage: ext-reload.mjs [extension folder] [options]

Reloads the unpacked extension in that folder (default: the current one, or the nearest parent with a
manifest.json), then reloads the tabs its content scripts match.

  --tabs <pattern>   reload tabs matching this pattern instead (repeatable)
  --no-tabs          reload no tabs
  --id <id>          reload this extension id instead of the folder's (repeatable)
  --all              reload every unpacked extension that is turned on
  --ping             check the helper answers, and list the unpacked extensions Chrome has
  --self             reload the helper itself, after editing its code
  --timeout <s>      how long to wait for the result once the helper has the request (default 20)
  --check-update     check now whether a newer ext-reload is out
  --update           update ext-reload (git pull, fast-forward only), then reload the helper if it changed`;

function parseArgs(argv) {
  const opts = { dir: null, tabs: null, noTabs: false, ids: [], all: false, ping: false, self: false, timeout: 20,
    checkUpdate: false, update: false, background: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--tabs') (opts.tabs ??= []).push(argv[++i]);
    else if (a === '--no-tabs') opts.noTabs = true;
    else if (a === '--id') opts.ids.push(argv[++i]);
    else if (a === '--all') opts.all = true;
    else if (a === '--ping') opts.ping = true;
    else if (a === '--self') opts.self = true;
    else if (a === '--timeout') opts.timeout = Number(argv[++i]);
    else if (a === '--check-update') opts.checkUpdate = true;
    else if (a === '--update') opts.update = true;
    else if (a === BACKGROUND) opts.background = true;
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

// Updates. A git clone asks its own remote whether it is behind, at most once a day, in a detached process
// started after a command has finished. The answer lives in extension/update.json, where the helper's popup
// reads it as well; the helper itself never contacts the network.

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function localVersion() {
  return readJson(path.join(HERE, 'package.json'))?.version
    ?? readJson(path.join(HERE, 'extension', 'manifest.json'))?.version ?? null;
}

// Whether version a is newer than version b, compared as dotted numbers.
function newer(a, b) {
  const pa = String(a).split('.').map(Number);
  const pb = String(b).split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d > 0;
  }
  return false;
}

function git(args, { timeout, background = false } = {}) {
  return execFileSync('git', ['-C', HERE, ...args], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout,
    // In the background nobody can answer a password prompt, so git must fail instead of waiting for one.
    env: background ? { ...process.env, GIT_TERMINAL_PROMPT: '0' } : process.env,
  }).trimEnd();
}

function gitError(err, what) {
  if (err.code === 'ETIMEDOUT') return `${what} took longer than ${FETCH_MS / 1000} s`;
  const first = String(err.stderr ?? '').split('\n').map(l => l.trim()).find(Boolean);
  return `${what} failed: ${first ?? err.message}`;
}

// Only a folder that is the top of its own git clone has anything to update: not a copy (the tests make one),
// and not a copy vendored inside another project's repo.
function cloneProblem() {
  try {
    const top = git(['rev-parse', '--show-toplevel']);
    return fs.realpathSync(top) === fs.realpathSync(HERE) ? null : 'this copy of ext-reload is not a git clone';
  } catch (err) {
    return err.code === 'ENOENT' ? 'git is not installed' : 'this copy of ext-reload is not a git clone';
  }
}

// The current branch's upstream, else origin/main.
function upstream() {
  try {
    const ref = git(['rev-parse', '--symbolic-full-name', '@{u}']);
    const remote = git(['config', `branch.${git(['symbolic-ref', '--short', 'HEAD'])}.remote`]);
    return { remote, ref, name: ref.replace(/^refs\/remotes\//, '') };
  } catch {
    return { remote: 'origin', ref: 'refs/remotes/origin/main', name: 'origin/main' };
  }
}

// This file's path the way the popup's prompt shows it, with the home folder as ~.
const SELF = fileURLToPath(import.meta.url);
function shownPath(p) {
  const home = os.homedir();
  return p.startsWith(home + path.sep) ? `~${p.slice(home.length)}` : p;
}

function compare(up) {
  return {
    latest: JSON.parse(git(['show', `${up.ref}:package.json`])).version,
    behind: Number(git(['rev-list', '--count', `HEAD..${up.ref}`])),
  };
}

// Fetch (unless the caller just did), compare HEAD with the upstream, and write update.json. A failed fetch is
// recorded, never thrown. Returns { skipped } and writes nothing when this copy cannot be checked at all.
function checkForUpdate({ background = false, fetchFirst = true } = {}) {
  const skipped = cloneProblem();
  if (skipped) return { skipped };
  const up = upstream();
  const current = localVersion();
  const state = {
    checkedAt: new Date().toISOString(), current, latest: null, behind: null, upstream: up.name, cli: shownPath(SELF),
  };
  let error = null;
  if (fetchFirst) {
    try {
      git(['fetch', '--quiet', up.remote], { timeout: FETCH_MS, background });
    } catch (err) {
      error = gitError(err, `git fetch ${up.remote}`);
    }
  }
  try {
    Object.assign(state, compare(up));  // after a failed fetch, from what the last good one brought
  } catch (err) {
    error ??= gitError(err, `reading ${up.name}`);
  }
  state.status = state.latest != null && newer(state.latest, current) ? 'available' : error ? 'failed' : 'current';
  if (error) state.error = error;
  try {
    const tmp = `${UPDATE_FILE}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`);
    fs.renameSync(tmp, UPDATE_FILE);  // atomic, like the inbox: the popup never reads half a file
  } catch {}
  return state;
}

function commits(n) {
  return `${n} commit${n === 1 ? '' : 's'}`;
}

// A background check may be fetching right now, and two fetches at once can trip over git's ref locks.
async function waitForBackgroundCheck() {
  const end = Date.now() + FETCH_MS + 5000;
  while (Date.now() < end) {
    try {
      if (Date.now() - fs.statSync(UPDATE_LOCK).mtimeMs >= LOCK_STALE_MS) return;
    } catch {
      return;  // no lock: nothing running
    }
    await new Promise(r => setTimeout(r, 200));
  }
}

async function printCheck() {
  await waitForBackgroundCheck();
  const s = checkForUpdate();
  if (s.skipped) fail(EXIT.failed, `Could not check for updates: ${s.skipped}.`);
  if (s.error) fail(EXIT.failed, `Could not check for updates: ${s.error}.`);
  if (s.status === 'available') {
    console.log(`ext-reload ${s.latest} is available (you have ${s.current}; ${commits(s.behind)} behind ${s.upstream}). Run ext-reload.mjs --update.`);
  } else if (s.behind > 0) {
    console.log(`ext-reload ${s.current} is up to date. ${s.upstream} has ${commits(s.behind)} more but no new version; --update pulls them anyway.`);
  } else {
    console.log(`ext-reload ${s.current} is up to date with ${s.upstream}.`);
  }
  return EXIT.ok;
}

async function update(opts) {
  const problem = cloneProblem();
  if (problem) fail(EXIT.failed, `Cannot update: ${problem}. Get the current version from https://github.com/dominic-lam/ext-reload.`);
  const dirty = git(['status', '--porcelain', '--untracked-files=no']);
  if (dirty) {
    fail(EXIT.failed, `Not updating: these tracked files have uncommitted changes, which the update could overwrite.\n${dirty}\nCommit or discard them, then run --update again.`);
  }
  const up = upstream();
  await waitForBackgroundCheck();
  try {
    git(['fetch', '--quiet', up.remote], { timeout: FETCH_MS });
  } catch (err) {
    fail(EXIT.failed, `Could not update: ${gitError(err, `git fetch ${up.remote}`)}.`);
  }
  const before = localVersion();
  let behind;
  try {
    behind = compare(up).behind;
  } catch (err) {
    fail(EXIT.failed, `Could not update: ${gitError(err, `reading ${up.name}`)}.`);
  }
  if (behind === 0) {
    checkForUpdate({ fetchFirst: false });
    console.log(`ext-reload ${before} is already up to date with ${up.name}.`);
    return EXIT.ok;
  }
  // git pull --ff-only, in two steps: the fetch above, so this one can say why it cannot fast-forward.
  try {
    git(['merge-base', '--is-ancestor', 'HEAD', up.ref]);
  } catch {
    fail(EXIT.failed, `Not updating: this clone has commits that ${up.name} does not, so it cannot fast-forward. Move them to a branch of their own, or reset to ${up.name} if you do not need them.`);
  }
  const oldHead = git(['rev-parse', 'HEAD']);
  try {
    git(['merge', '--ff-only', '--quiet', up.ref]);
  } catch (err) {
    fail(EXIT.failed, `Could not update: ${gitError(err, `git merge --ff-only ${up.name}`)}.`);
  }
  const after = localVersion();
  const helperChanged = git(['diff', '--name-only', oldHead, 'HEAD', '--', 'extension']) !== '';
  console.log(before === after
    ? `Updated ext-reload ${after} (${commits(behind)}, same version).`
    : `Updated ext-reload ${before} → ${after} (${commits(behind)}).`);
  console.log(helperChanged ? await reloadHelper(opts) : 'The helper did not change; nothing to reload.');
  checkForUpdate({ fetchFirst: false });
  return EXIT.ok;
}

// Chrome runs the old helper until a full reload, the one --self asks for. Not reaching it is reported, but
// the update itself has worked.
async function reloadHelper(opts) {
  const still = 'Run ext-reload.mjs --self once --ping answers, or press Reload on the helper\'s card at chrome://extensions.';
  if (chromeIsRunning() === false) return 'Chrome is not running; it loads the new helper when it next starts.';
  try {
    await send({ action: 'reload-self' }, opts.timeout);
  } catch {
    return `Reload still needed: the helper did not answer, so Chrome still runs the old one. ${still}`;
  }
  await new Promise(r => setTimeout(r, 1000));  // the helper reloads 300 ms after answering
  try {
    const reply = await send({ action: 'ping' }, opts.timeout);
    return `Helper reloaded: Chrome now runs helper ${reply.helperVersion}.`;
  } catch {
    return 'The helper reloaded itself but has not answered since. Look for an error on its card at chrome://extensions.';
  }
}

// Due when there is no answer yet, the last check is over a day old (or in the future: the clock moved), or
// the version changed since it, after a git pull by hand.
function checkDue(state, mine) {
  const age = Date.now() - Date.parse(state?.checkedAt);
  return !(age >= 0 && age < CHECK_EVERY_MS) || state.current !== mine;
}

// One check at a time: an agent reloading every few seconds would otherwise start one per run.
function takeLock() {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      fs.closeSync(fs.openSync(UPDATE_LOCK, 'wx'));
      return true;
    } catch (err) {
      if (err.code !== 'EEXIST') return false;
      try {
        if (Date.now() - fs.statSync(UPDATE_LOCK).mtimeMs < LOCK_STALE_MS) return false;
      } catch {}
      fs.rmSync(UPDATE_LOCK, { force: true });  // left by a check that died
    }
  }
  return false;
}

// Runs as the process exits, whatever the command did: one line on stderr when a newer version is out, and
// the daily check, detached so this process exits without waiting for it. Stdout and the exit code are left
// alone; agents act on them.
function afterRun() {
  if (process.env.EXT_RELOAD_NO_UPDATE_CHECK) return;
  try {
    const state = readJson(UPDATE_FILE);
    const mine = localVersion();
    if (state?.status === 'available' && newer(state.latest, mine)) {
      console.error(`ext-reload ${state.latest} is available (you have ${mine}). Run ext-reload.mjs --update.`);
    }
    if (checkDue(state, mine) && fs.existsSync(path.join(HERE, '.git')) && takeLock()) {
      const child = spawn(process.execPath, [SCRIPT, BACKGROUND], { detached: true, stdio: 'ignore', windowsHide: true });
      child.on('error', () => {});
      child.unref();
    }
  } catch {}
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.background) {
    try {
      checkForUpdate({ background: true });
    } finally {
      fs.rmSync(UPDATE_LOCK, { force: true });
    }
    return EXIT.ok;
  }
  if (opts.checkUpdate) return await printCheck();
  if (opts.update) return await update(opts);
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
    if (sameName) lines.push(`${name} is loaded from a different folder (id ${sameName.id}). A worktree, or a build folder? Chrome runs that folder's code, not this one's.`);
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

// Registered before anything can exit: --help and every failure exit through process.exit.
if (!['--update', '--check-update', BACKGROUND].some(a => process.argv.includes(a))) process.on('exit', afterRun);
process.exitCode = await main();
