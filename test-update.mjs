#!/usr/bin/env node
// The update check, --check-update and --update, against a local bare repo standing in for GitHub: no network.
// The user's install is a clone of it; the --update that reloads the helper runs in Playwright's own Chromium,
// as test.mjs does. Nothing here touches your clone or your Chrome.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ext-reload-update-test-')));
const BASE = JSON.parse(fs.readFileSync(path.join(HERE, 'package.json'), 'utf8')).version;
const NEXT = BASE.replace(/\d+$/, n => Number(n) + 1);

// git with no user or system config of yours, so a signing or hook setting cannot change the result.
fs.writeFileSync(path.join(tmp, 'gitconfig'), '');
const ENV = {
  ...process.env, GIT_CONFIG_GLOBAL: path.join(tmp, 'gitconfig'), GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'test', GIT_AUTHOR_EMAIL: 'test@example.com',
  GIT_COMMITTER_NAME: 'test', GIT_COMMITTER_EMAIL: 'test@example.com',
  EXT_RELOAD_SKIP_CHROME_CHECK: '1',
};
for (const name of ['EXT_RELOAD_NO_UPDATE_CHECK', 'GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE']) delete ENV[name];
const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { env: ENV, encoding: 'utf8' }).trim();

function copyTool(dir) {
  fs.mkdirSync(dir);
  for (const f of ['ext-reload.mjs', 'package.json', '.gitignore']) fs.copyFileSync(path.join(HERE, f), path.join(dir, f));
  const helper = path.join(HERE, 'extension');
  fs.cpSync(helper, path.join(dir, 'extension'), {
    recursive: true,
    filter: src => !/^(inbox|update\.)/.test(path.relative(helper, src).split(path.sep)[0]),
  });
}

// The publisher's working copy, the bare repo playing GitHub, and the user's clone of it.
const src = path.join(tmp, 'src');
const remote = path.join(tmp, 'remote.git');
const clone = path.join(tmp, 'clone');
copyTool(src);
git(src, 'init', '-q', '-b', 'main');
git(src, 'add', '-A');
git(src, 'commit', '-qm', 'base');
git(tmp, 'clone', '-q', '--bare', src, remote);
git(src, 'remote', 'add', 'origin', remote);
git(tmp, 'clone', '-q', remote, clone);

function publish(message, edit) {
  edit(src);
  git(src, 'add', '-A');
  git(src, 'commit', '-qm', message);
  git(src, 'push', '-q', 'origin', 'main');
}

function setVersion(dir, version) {
  for (const f of ['package.json', 'extension/manifest.json']) {
    const file = path.join(dir, f);
    fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(file, 'utf8')), version }, null, 2));
  }
}

function run(dir, args, env = {}) {
  return new Promise(resolve => {
    const started = Date.now();
    const child = spawn(process.execPath, [path.join(dir, 'ext-reload.mjs'), ...args], { cwd: tmp, env: { ...ENV, ...env } });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', d => { stdout += d; });
    child.stderr.on('data', d => { stderr += d; });
    // 'close' waits for every holder of the pipes: a background check that kept them open would show in ms.
    child.on('close', code => resolve({ code, stdout, stderr, out: stdout + stderr, ms: Date.now() - started }));
  });
}

const wait = ms => new Promise(r => setTimeout(r, ms));
const stateFile = dir => path.join(dir, 'extension', 'update.json');
const lockFile = dir => path.join(dir, 'extension', 'update.lock');
const readState = dir => {
  try { return JSON.parse(fs.readFileSync(stateFile(dir), 'utf8')); } catch { return null; }
};
const show = r => `exit ${r.code}\n--- stdout\n${r.stdout}--- stderr\n${r.stderr}`;

// The background check is detached, so wait for it to write a new answer and let go of its lock.
async function waitForCheck(dir, since) {
  for (const end = Date.now() + 15_000; Date.now() < end; await wait(100)) {
    const s = readState(dir);
    if (s && s.checkedAt !== since && !fs.existsSync(lockFile(dir))) return s;
  }
  return null;
}

function backdate(dir, hours) {
  const s = readState(dir);
  s.checkedAt = new Date(Date.now() - hours * 3600_000).toISOString();
  fs.writeFileSync(stateFile(dir), JSON.stringify(s));
  return s.checkedAt;
}

let failures = 0;
function check(label, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `\n      ${detail.replace(/\n/g, '\n      ')}`}`);
  if (!ok) failures++;
}

const notice = `ext-reload ${NEXT} is available (you have ${BASE}). Run ext-reload.mjs --update.\n`;
const empty = path.join(tmp, 'empty');  // no manifest.json here or above: the CLI fails at once with exit 1
fs.mkdirSync(empty);
let ctx;

try {
  const usage = (await run(clone, ['--help'], { EXT_RELOAD_NO_UPDATE_CHECK: '1' })).stdout;

  const plain = path.join(tmp, 'plain');
  copyTool(plain);
  let r = await run(plain, ['--help']);
  await wait(1500);
  const plainCheck = await run(plain, ['--check-update']);
  check('not a git clone: --help unchanged, nothing on stderr, nothing written',
    r.code === 0 && r.stdout === usage && r.stderr === '' && !fs.existsSync(stateFile(plain)) && !fs.existsSync(lockFile(plain)),
    show(r));
  check('  --check-update says why it cannot check, exit 1',
    plainCheck.code === 1 && /not a git clone/.test(plainCheck.stderr), show(plainCheck));

  r = await run(clone, ['--help']);
  let state = await waitForCheck(clone, undefined);
  check(`first run in a clone: --help unchanged, exit 0 (${r.ms} ms)`, r.code === 0 && r.stdout === usage && r.stderr === '', show(r));
  check('  the background check finds it up to date',
    state?.status === 'current' && state.behind === 0 && state.latest === BASE && state.current === BASE, JSON.stringify(state));

  const first = state.checkedAt;
  await run(clone, ['--help']);
  await wait(1500);
  check('  within 24 hours, no second check', readState(clone).checkedAt === first, JSON.stringify(readState(clone)));
  const old = backdate(clone, 25);
  await run(clone, ['--help']);
  state = await waitForCheck(clone, old);
  check('  after 24 hours, it checks again', state != null && state.checkedAt !== first, JSON.stringify(readState(clone)));

  r = await run(clone, ['--check-update']);
  check('--check-update, up to date: exit 0', r.code === 0 && /is up to date with origin\/main/.test(r.stdout), show(r));

  publish(`v${NEXT}`, dir => {
    setVersion(dir, NEXT);
    fs.appendFileSync(path.join(dir, 'extension', 'sw.js'), `// ${NEXT}\n`);
  });
  await run(clone, ['--help']);  // checked moments ago: nothing to see yet
  await run(clone, ['--help']);
  check('  a newer version is not reported before the next check', readState(clone).status === 'current');
  const before = backdate(clone, 25);
  await run(clone, ['--help']);
  state = await waitForCheck(clone, before);
  check(`newer version upstream: the check records ${NEXT}, 1 commit behind`,
    state?.status === 'available' && state.latest === NEXT && state.behind === 1, JSON.stringify(state));
  r = await run(clone, ['--help']);
  check('  --help: stdout and exit 0 unchanged, the notice alone on stderr',
    r.code === 0 && r.stdout === usage && r.stderr === notice, show(r));
  r = await run(clone, [empty]);
  check('  a failing command: still exit 1, its message, then the notice',
    r.code === 1 && r.stdout === '' && /^No manifest\.json/.test(r.stderr) && r.stderr.endsWith(notice), show(r));
  r = await run(clone, ['--check-update']);
  check('  --check-update reports it, exit 0',
    r.code === 0 && r.stdout.includes(`ext-reload ${NEXT} is available (you have ${BASE}; 1 commit behind origin/main)`), show(r));

  const optOut = { EXT_RELOAD_NO_UPDATE_CHECK: '1' };
  r = await run(clone, ['--help'], optOut);
  const stale = backdate(clone, 25);
  await run(clone, ['--help'], optOut);
  await wait(1500);
  check('EXT_RELOAD_NO_UPDATE_CHECK=1: no notice, and no check after 24 hours',
    r.code === 0 && r.stderr === '' && readState(clone).checkedAt === stale && !fs.existsSync(lockFile(clone)), show(r));

  const head = git(clone, 'rev-parse', 'HEAD');
  fs.appendFileSync(path.join(clone, '.gitignore'), '# a local edit\n');
  r = await run(clone, ['--update']);
  check('--update refuses on uncommitted changes to tracked files: exit 1, HEAD unchanged',
    r.code === 1 && /uncommitted changes/.test(r.stderr) && /\.gitignore/.test(r.stderr) && git(clone, 'rev-parse', 'HEAD') === head, show(r));
  git(clone, 'checkout', '-q', '--', '.gitignore');

  fs.writeFileSync(path.join(clone, 'local.txt'), 'mine\n');
  git(clone, 'add', 'local.txt');
  git(clone, 'commit', '-qm', 'local');
  const diverged = git(clone, 'rev-parse', 'HEAD');
  r = await run(clone, ['--update']);
  check('--update refuses when it cannot fast-forward: exit 1, HEAD unchanged',
    r.code === 1 && /cannot fast-forward/.test(r.stderr) && git(clone, 'rev-parse', 'HEAD') === diverged, show(r));
  git(clone, 'reset', '-q', '--hard', head);

  // The user's Chrome, played by Playwright's Chromium with the clone's helper loaded, as in test.mjs.
  ctx = await chromium.launchPersistentContext(path.join(tmp, 'profile'), {
    channel: 'chromium', headless: true, ignoreDefaultArgs: ['--disable-extensions'],
    args: ['--enable-unsafe-extension-debugging'],
  });
  const settings = await ctx.newPage();
  await settings.goto('chrome://extensions');
  await settings.evaluate(() => chrome.developerPrivate.updateProfileConfiguration({ inDeveloperMode: true }));
  await settings.close();
  const cdp = await ctx.browser().newBrowserCDPSession();
  const { id: helperId } = await cdp.send('Extensions.loadUnpacked', { path: path.join(clone, 'extension') });
  await wait(1500);
  r = await run(clone, ['--ping'], optOut);
  check(`the clone's helper ${BASE} is answering in Chromium`, r.code === 0 && r.stdout.includes(`Helper ${BASE} is answering`), show(r));

  let helperStarts = 0;
  ctx.on('serviceworker', sw => { if (sw.url().includes(helperId)) helperStarts++; });
  r = await run(clone, ['--update']);
  await wait(1000);
  state = readState(clone);
  check(`--update fast-forwards: exit 0, ${BASE} → ${NEXT} (${r.ms} ms)`,
    r.code === 0 && r.stdout.includes(`Updated ext-reload ${BASE} → ${NEXT} (1 commit).`)
      && git(clone, 'rev-parse', 'HEAD') === git(remote, 'rev-parse', 'main'), show(r));
  check(`  the helper's files changed, so it reloaded once and Chrome runs ${NEXT}`,
    r.stdout.includes(`Helper reloaded: Chrome now runs helper ${NEXT}.`) && helperStarts === 1, `${show(r)}\nhelper starts: ${helperStarts}`);
  check('  update.json refreshed: up to date, no notice afterwards',
    state?.status === 'current' && state.current === NEXT && state.latest === NEXT && state.behind === 0
      && (await run(clone, ['--help'])).stderr === '', JSON.stringify(state));

  publish('docs only', dir => fs.writeFileSync(path.join(dir, 'README.md'), 'docs\n'));
  r = await run(clone, ['--update']);
  const again = await run(clone, ['--update']);
  check('--update with no helper change: says so, contacts no helper; a second run is already up to date',
    r.code === 0 && r.stdout === `Updated ext-reload ${NEXT} (1 commit, same version).\nThe helper did not change; nothing to reload.\n`
      && again.code === 0 && /already up to date/.test(again.stdout), `${show(r)}\n${show(again)}`);

  // Offline, slowly: an ssh "connection" that hangs 2 s, then fails. The CLI must not wait for it.
  git(clone, 'remote', 'set-url', 'origin', 'ssh://ext-reload.invalid/ext-reload.git');
  const offline = { GIT_SSH_COMMAND: 'sleep 2 #' };
  const lastGood = backdate(clone, 25);
  r = await run(clone, ['--help'], offline);
  state = await waitForCheck(clone, lastGood);
  check(`unreachable remote: exit 0, stdout unchanged, nothing on stderr, no wait for the fetch (${r.ms} ms)`,
    r.code === 0 && r.stdout === usage && r.stderr === '' && r.ms < 1500, show(r));
  check('  recorded as a failed check', state?.status === 'failed' && /git fetch origin failed/.test(state.error), JSON.stringify(state));
  r = await run(clone, ['--check-update'], offline);
  check('  --check-update says it could not check, exit 1',
    r.code === 1 && /Could not check for updates: git fetch origin failed/.test(r.stderr), show(r));
} finally {
  await ctx?.close();
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log(failures ? `\n${failures} failed` : '\nAll passed');
process.exitCode = failures ? 1 : 0;
