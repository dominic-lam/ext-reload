#!/usr/bin/env node
// Rebuilds assets/demo.gif and assets/demo.mp4 with one command:  node demo/record-demo.mjs
//
// Needs the dev dependencies (npm install, npx playwright install chromium), ffmpeg, and the `diff` command.
//
// What is real: a throwaway copy of the CLI and the helper extension runs in Playwright's own Chromium with a temp
// profile (the way test.mjs does it), next to a toy extension. The script takes a screenshot of a demo page, edits
// the toy's content.js on disk, runs the copied CLI for real, and takes a screenshot of the reloaded page. The
// CLI's stdout, its exit code, the elapsed time and the diff in the video all come from that run.
//
// What is staged: the terminal panel is drawn in HTML from those captured values (typed command, lines revealed
// one by one, the agent's task line), and the browser window is drawn around the real screenshots. The opening
// "without ext-reload" beat is staged entirely: AGENT_REPLY is a line written for the video, not an agent's output;
// the edit it follows and the light page next to it are the real ones. The only
// rewrites of captured text are in display(): the temp path of the CLI becomes ~/ext-reload, other temp paths are
// trimmed. The script logs each rewrite it made.
//
// Environment: DEMO_KEEP=1 keeps the work folder (frames, screenshots, ffmpeg list); TMPDIR chooses where it goes.

import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const ASSETS = path.join(ROOT, 'assets');
const GIF = path.join(ASSETS, 'demo.gif');
const MP4 = path.join(ASSETS, 'demo.mp4');

const W = 1200, H = 675;           // canvas
const VIEW_W = 600, VIEW_H = 493;  // the page area inside the drawn browser window
const FPS = 12.5, TICK = 1 / FPS;  // 80 ms per tick, a whole number of GIF centiseconds
const SHOWN_CLI = '~/ext-reload/ext-reload.mjs';

const work = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ext-reload-demo-')));
const framesDir = path.join(work, 'frames');
fs.mkdirSync(framesDir);
const rewrites = [];
const wait = ms => new Promise(r => setTimeout(r, ms));
const esc = s => s.replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]);
const log = (...a) => console.log('[demo]', ...a);

// ---------------------------------------------------------------- 1. the real run

const tool = path.join(work, 'tool');
fs.mkdirSync(tool);
fs.copyFileSync(path.join(ROOT, 'ext-reload.mjs'), path.join(tool, 'ext-reload.mjs'));
const helperSrc = path.join(ROOT, 'extension');
fs.cpSync(helperSrc, path.join(tool, 'extension'), {
  recursive: true,
  filter: src => !/^(inbox|update\.)/.test(path.relative(helperSrc, src).split(path.sep)[0]),
});

const toy = path.join(work, 'dark-mode-demo');
fs.mkdirSync(toy);
fs.writeFileSync(path.join(toy, 'manifest.json'), JSON.stringify({
  manifest_version: 3, name: 'Dark Mode Demo', version: '1.0',
  background: { service_worker: 'background.js' },
  content_scripts: [{ matches: ['http://localhost/*'], js: ['content.js'] }],
}, null, 2));
fs.writeFileSync(path.join(toy, 'background.js'), '// nothing to do; the content script does the work\n');
const CONTENT_V1 = `const badge = document.createElement('div');
badge.id = 'dm-badge';
badge.textContent = 'Dark Mode Demo';
badge.style.cssText = 'position:fixed;top:12px;right:12px;z-index:99;padding:6px 14px;border-radius:99px;background:#6d5efc;color:#fff;font:600 16px system-ui';
document.body.append(badge);
`;
const CONTENT_V2 = CONTENT_V1 + `const { style } = document.body;
style.background = '#14141c';
style.color = '#e8e8f0';
`;
fs.writeFileSync(path.join(toy, 'content.js'), CONTENT_V1);

// Every colour in the page is either the page's own mid-tone or transparent, so a dark body background and light
// text from the content script turn the whole page dark.
const PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Demo page</title>
<style>
  body { margin: 0; font: 17px/1.5 -apple-system, system-ui, sans-serif; background: #fff; color: #1f2430; }
  header { display: flex; align-items: center; gap: 12px; padding: 16px 28px; border-bottom: 1px solid rgba(127,127,127,.35); }
  .logo { width: 28px; height: 28px; border-radius: 8px; background: #3b82f6; }
  header b { font-size: 18px; }
  main { padding: 26px 28px; }
  h1 { margin: 0 0 4px; font-size: 30px; line-height: 1.2; }
  p { margin: 0 0 20px; opacity: .72; }
  .card { display: flex; align-items: center; gap: 14px; margin-bottom: 12px; padding: 14px 16px; border: 1px solid rgba(127,127,127,.35); border-radius: 12px; background: rgba(127,127,127,.1); }
  .box { width: 20px; height: 20px; border-radius: 6px; border: 2px solid rgba(127,127,127,.7); flex: none; }
  .box.done { background: #3b82f6; border-color: #3b82f6; }
  .row { display: flex; align-items: center; gap: 22px; margin-top: 22px; }
  a { color: #3b82f6; font-weight: 600; text-decoration: none; }
  button { font: 600 16px system-ui; color: #fff; background: #3b82f6; border: 0; border-radius: 10px; padding: 10px 18px; }
</style></head><body>
<header><span class="logo"></span><b>Notes</b></header>
<main>
  <h1>Today</h1>
  <p>Three things on the list.</p>
  <div class="card"><span class="box done"></span>Write the release notes</div>
  <div class="card"><span class="box"></span>Review the open pull requests</div>
  <div class="card"><span class="box"></span>Reply to the design feedback</div>
  <div class="row"><button>New note</button><a href="#">View all notes</a></div>
</main></body></html>`;

// Port 3000 reads as a dev server; fall back to any free port.
const server = http.createServer((q, r) => { r.setHeader('content-type', 'text/html'); r.end(PAGE); });
const port = await new Promise(resolve => {
  server.once('error', () => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
  server.listen(3000, '127.0.0.1', () => resolve(3000));
});

function runCli() {
  return new Promise(resolve => {
    const started = process.hrtime.bigint();
    // cwd is the toy's folder and there are no arguments, exactly like the command the video shows.
    // EXT_RELOAD_SKIP_CHROME_CHECK: the CLI otherwise looks for a process named "Google Chrome", and this
    // browser is Playwright's Chromium.
    const child = spawn(process.execPath, [path.join(tool, 'ext-reload.mjs')],
      { cwd: toy, env: { ...process.env, EXT_RELOAD_SKIP_CHROME_CHECK: '1' } });
    let stdout = '', stderr = '';
    child.stdout.on('data', d => { stdout += d; });
    child.stderr.on('data', d => { stderr += d; });
    child.on('close', code => resolve({ code, stdout, stderr, ms: Number(process.hrtime.bigint() - started) / 1e6 }));
  });
}

const ctx = await chromium.launchPersistentContext(path.join(work, 'profile'), {
  channel: 'chromium', headless: true, ignoreDefaultArgs: ['--disable-extensions'],
  args: ['--enable-unsafe-extension-debugging'], viewport: { width: VIEW_W, height: VIEW_H }, deviceScaleFactor: 1,
});
let real;
try {
  const settings = await ctx.newPage();
  await settings.goto('chrome://extensions');
  await settings.evaluate(() => chrome.developerPrivate.updateProfileConfiguration({ inDeveloperMode: true }));
  await settings.close();
  const cdp = await ctx.browser().newBrowserCDPSession();
  await cdp.send('Extensions.loadUnpacked', { path: path.join(tool, 'extension') });
  const { id: toyId } = await cdp.send('Extensions.loadUnpacked', { path: toy });
  await wait(1500);

  // Setup, not shown: one full reload of the toy (what the Reload button does) so the helper has seen it load,
  // as it has for any extension in a Chrome that has been running a while. Without this the CLI adds a
  // "Not checked: whether Chrome has the current manifest.json" line, which is true only for a just-installed helper.
  const worker = () => ctx.serviceWorkers().filter(sw => sw.url().includes(toyId)).at(-1);
  await worker().evaluate(() => chrome.runtime.reload()).catch(() => {});
  await wait(1500);

  const page = await ctx.newPage();
  await page.goto(`http://localhost:${port}/`);
  await page.waitForSelector('#dm-badge');
  const lightBg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  if (lightBg !== 'rgb(255, 255, 255)') throw new Error(`before: page should be light, body is ${lightBg}`);
  await page.screenshot({ path: path.join(work, 'before.png') });
  const originId = await page.evaluate(() => performance.timeOrigin);

  // The edit, on disk, as the agent would make it.
  const oldFile = path.join(work, 'content.old.js');
  fs.copyFileSync(path.join(toy, 'content.js'), oldFile);
  fs.writeFileSync(path.join(toy, 'content.js'), CONTENT_V2);
  const diff = spawnSync('diff', ['-U1', oldFile, path.join(toy, 'content.js')], { encoding: 'utf8' }).stdout;

  // The reload, for real.
  const cli = await runCli();
  log(`CLI exit ${cli.code} in ${cli.ms.toFixed(0)} ms`);
  log(`stdout:\n${cli.stdout}`);
  if (cli.stderr) log(`stderr:\n${cli.stderr}`);
  if (cli.code !== 0) throw new Error(`CLI exited ${cli.code}`);

  await page.waitForFunction(() => getComputedStyle(document.body).backgroundColor === 'rgb(20, 20, 28)', null, { timeout: 10000 });
  await wait(300);
  if (await page.evaluate(() => performance.timeOrigin) === originId) throw new Error('the tab was not reloaded');
  await page.screenshot({ path: path.join(work, 'after.png') });
  real = { cli, diff, port };
} finally {
  await ctx.close();
  server.close();
}

// ---------------------------------------------------------------- 2. what the video shows from the run

// Cosmetic rewrites only: the CLI's temp path becomes the install path in the README, other temp paths are trimmed.
function display(text) {
  let out = text;
  for (const [from, to] of [[tool, '~/ext-reload'], [toy, '~/my-extension'], [work, '~']]) {
    if (out.includes(from)) { rewrites.push(`${from} -> ${to}`); out = out.split(from).join(to); }
  }
  return out;
}
const cliLines = display(real.cli.stdout + real.cli.stderr).trimEnd().split('\n');
const seconds = (real.cli.ms / 1000).toFixed(2);
const url = `localhost:${real.port}`;

// The diff, parsed from `diff -U1`: context and added lines with their numbers in the new file.
const diffRows = [];
{
  let n = 0;
  for (const line of real.diff.split('\n')) {
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)/.exec(line);
    if (hunk) { n = Number(hunk[1]); continue; }
    if (/^(---|\+\+\+)/.test(line) || line === '') continue;
    const kind = line[0] === '+' ? 'add' : line[0] === '-' ? 'del' : 'ctx';
    diffRows.push({ kind, n: kind === 'del' ? '' : n, text: line.slice(1) });
    if (kind !== 'del') n++;
  }
}
const added = diffRows.filter(r => r.kind === 'add').length;
const removed = diffRows.filter(r => r.kind === 'del').length;

const b64 = f => fs.readFileSync(path.join(work, f)).toString('base64');
const IMG = { before: `data:image/png;base64,${b64('before.png')}`, after: `data:image/png;base64,${b64('after.png')}` };
const iconSvg = fs.readFileSync(path.join(ASSETS, 'icon.svg'), 'utf8');

// ---------------------------------------------------------------- 3. the frames

// Beat 0, "without ext-reload", is PRE_TICKS ticks long (2.48 s) and comes before the beats below, whose times
// count from the end of it.
const PRE_TICKS = 31;
const BEATS = { before: 0, edit: 2.0, reload: 4.5, after: 7.0, end: 9.5, total: 11.5 };
const MAIN_TICKS = Math.round(BEATS.total / TICK);
const TOTAL_SECONDS = (PRE_TICKS + MAIN_TICKS) * TICK;
const AGENT_REPLY = 'Done. Open chrome://extensions, press Reload on Dark Mode Demo, then refresh the page.';

const CAPTIONS = {
  x: 'Without ext-reload, your agent stops and asks you',
  a: '<em>With ext-reload,</em> your coding agent changes your extension',
  b: '&hellip;then reloads it itself',
  c: 'No trip to chrome://extensions. <em>Nobody pressed Reload.</em>',
};

// Terminal rows visible at time t (seconds). Each row: { cls, html }.
function terminalAt(t) {
  const rows = [];
  const at = s => t >= s;
  const tick = Math.floor(t / TICK);
  rows.push({ cls: 'dim', html: '<span class="p">&rsaquo;</span> make the extension turn pages dark' });

  if (at(BEATS.edit)) {
    rows.push({ cls: 'gap' });
    rows.push({ cls: 'head', html: `<span class="dot">&#9679;</span> Edit <b>content.js</b> <span class="stat"><span class="g">+${added}</span>${removed ? ` <span class="r">&minus;${removed}</span>` : ''}</span>` });
    diffRows.forEach((r, i) => {
      if (!at(BEATS.edit + 0.35 + i * 0.3)) return;
      const mark = r.kind === 'add' ? '+' : r.kind === 'del' ? '&minus;' : '&nbsp;';
      rows.push({ cls: `diff ${r.kind}`, html: `<span class="n">${String(r.n).padStart(2, ' ')}</span><span class="m">${mark}</span>${esc(r.text)}` });
    });
  }

  if (at(BEATS.reload)) {
    rows.push({ cls: 'gap' });
    const typed = Math.min(SHOWN_CLI.length, Math.ceil((t - BEATS.reload) / 0.64 * SHOWN_CLI.length));
    const done = typed >= SHOWN_CLI.length;
    rows.push({ cls: 'head', html: `<span class="dot">&#9679;</span> Run <span class="cmd">${esc(SHOWN_CLI.slice(0, typed))}</span>`, typing: !done });
    if (done) {
      const out = BEATS.reload + 0.64 + 0.4;
      cliLines.forEach((line, i) => {
        if (!at(out + i * 0.4)) return;
        rows.push({ cls: 'out', html: esc(line) });
      });
      if (at(out + cliLines.length * 0.4)) {
        rows.push({ cls: 'exit', html: `<span class="ok">&#10003;</span> exit ${real.cli.code} &middot; ${seconds}&thinsp;s` });
      }
    }
  }
  // blinking cursor on the last row (steady while typing)
  const last = rows[rows.length - 1];
  const blinkOn = last.typing || Math.floor(tick / 6) % 2 === 0;
  if (blinkOn) last.html = (last.html || '') + '<span class="cur"></span>';
  return rows;
}

// Beat 0: the same request, the edit collapsed to its header, then the agent handing the reload back to the human.
// The page is the real light screenshot, unchanged.
function problemState(tick) {
  const rows = [
    { cls: 'dim', html: '<span class="p">&rsaquo;</span> make the extension turn pages dark' },
    { cls: 'gap' },
    { cls: 'head', html: `<span class="dot">&#9679;</span> Edit <b>content.js</b> <span class="stat"><span class="g">+${added}</span></span>` },
  ];
  if (tick >= 4) {
    rows.push({ cls: 'gap' });
    rows.push({ cls: 'reply', html: `<span class="dot">&#9679;</span> ${esc(AGENT_REPLY)}` });
    rows.push({ cls: 'gap' });
    // the prompt waits for the human; the cursor blinks
    rows.push({ cls: 'dim', html: `<span class="p dimp">&rsaquo;</span>${Math.floor(tick / 6) % 2 === 0 ? '<span class="cur dimcur"></span>' : ''}` });
  }
  return { scene: 'main', caption: 'x', after: false, rows };
}

function stateAt(t) {
  if (t >= BEATS.end) return { scene: 'end' };
  const caption = t < BEATS.reload ? 'a' : t < BEATS.after ? 'b' : 'c';
  // A hard cut to the screenshot taken after the reload: the page itself reloads in one step too.
  return { scene: 'main', caption, after: t >= BEATS.after, rows: terminalAt(t) };
}

const FONT_MONO = '"SF Mono", Menlo, "DejaVu Sans Mono", monospace';
const CSS = `
* { box-sizing: border-box; }
html, body { margin: 0; width: ${W}px; height: ${H}px; background: #0d1117; overflow: hidden;
  font-family: -apple-system, "SF Pro Display", system-ui, sans-serif; }
.cap { position: absolute; left: 0; top: 0; width: ${W}px; height: 68px; background: #161b22; border-bottom: 1px solid #2a313c;
  display: flex; align-items: center; justify-content: center; color: #f0f3f6; font-size: 31px; font-weight: 700; letter-spacing: -.2px; }
.cap em { font-style: normal; color: #3ddc97; }
.cap.bad span { color: #e5a050; }
.cap.bad { border-bottom-color: #5a4220; }
.term { position: absolute; left: 20px; top: 84px; width: 540px; height: 575px; background: #161b22; border: 1px solid #2a313c;
  border-radius: 12px; overflow: hidden; font: 18px/28px ${FONT_MONO}; color: #e6edf3; }
.term .bar { height: 34px; border-bottom: 1px solid #2a313c; display: flex; align-items: center; gap: 8px; padding: 0 14px; background: #1c222b; }
.term .bar i { width: 12px; height: 12px; border-radius: 6px; background: #3a4150; }
.rows { padding: 14px 0; }
.rows > div { padding: 0 20px; white-space: pre-wrap; overflow-wrap: anywhere; }
.gap { height: 14px; }
.dim { color: #8b949e; }
.p { color: #3ddc97; margin-right: 6px; }
.head { font-weight: 400; }
.head b { font-weight: 700; }
.dot { color: #3ddc97; margin-right: 4px; }
.stat { color: #8b949e; margin-left: 6px; }
.g { color: #3fb950; } .r { color: #f85149; }
.cmd { color: #f0f3f6; }
.diff { display: flex; }
.diff .n { color: #6e7681; width: 3ch; flex: none; text-align: right; margin-right: 1ch; }
.diff .m { width: 2ch; flex: none; }
.diff.add { background: rgba(63,185,80,.18); } .diff.add .m { color: #3fb950; }
.diff.del { background: rgba(248,81,73,.18); } .diff.del .m { color: #f85149; }
.diff.ctx { color: #8b949e; }
.out { padding-left: 42px !important; text-indent: -22px; color: #c9d1d9; }
.out:first-of-type { }
.exit { color: #8b949e; }
.ok { color: #3fb950; margin-right: 4px; }
.reply { padding-left: 42px !important; text-indent: -22px; color: #e6edf3; }
.reply .dot { color: #e6edf3; margin-right: 0; }
.dimp { color: #6e7681; }
.cur { display: inline-block; width: 10px; height: 21px; margin-left: 2px; background: #e6edf3; vertical-align: -4px; }
.cur.dimcur { background: #6e7681; }
.win { position: absolute; left: 580px; top: 84px; width: ${VIEW_W}px; height: 575px; border-radius: 12px; overflow: hidden;
  background: #fff; border: 1px solid #3a4150; }
.win.ok { border-color: #3ddc97; }
.tabs { height: 38px; background: #dee1e6; display: flex; align-items: flex-end; padding-left: 14px; gap: 14px; }
.lights { display: flex; gap: 7px; align-self: center; margin-bottom: 2px; }
.lights i { width: 12px; height: 12px; border-radius: 6px; }
.tab { height: 30px; width: 190px; background: #fff; border-radius: 9px 9px 0 0; display: flex; align-items: center; gap: 8px;
  padding: 0 12px; font: 14px system-ui; color: #202124; }
.fav { width: 14px; height: 14px; border-radius: 4px; background: #3b82f6; flex: none; }
.tab .x { margin-left: auto; color: #5f6368; font-size: 16px; }
.tool { height: 44px; background: #fff; border-bottom: 1px solid #dadce0; display: flex; align-items: center; gap: 14px; padding: 0 14px; }
.tool svg { width: 20px; height: 20px; flex: none; stroke: #5f6368; fill: none; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; }
.url { flex: 1; height: 30px; border-radius: 15px; background: #f1f3f4; display: flex; align-items: center; padding: 0 14px;
  font: 15px system-ui; color: #202124; }
.view { position: relative; width: ${VIEW_W}px; height: ${VIEW_H}px; }
.view img { position: absolute; left: 0; top: 0; display: block; }
.end { position: absolute; inset: 0; background: #0d1117; display: flex; flex-direction: column; align-items: center; justify-content: center; }
.end svg { width: 132px; height: 132px; }
.end h1 { margin: 22px 0 14px; font-size: 104px; line-height: 1; font-weight: 800; letter-spacing: -2px; color: #f0f3f6; }
.end p { margin: 0 0 34px; font-size: 33px; color: #c9d1d9; }
.end code { font: 600 32px ${FONT_MONO}; color: #3ddc97; }
`;

function html(s) {
  if (s.scene === 'end') {
    return `<!doctype html><meta charset="utf-8"><style>${CSS}</style><div class="end">${iconSvg}<h1>ext-reload</h1><p>Your coding agent reloads your Chrome extension itself.</p><code>github.com/dominic-lam/ext-reload</code></div>`;
  }
  const rows = s.rows.map(r => `<div class="${r.cls}">${r.html ?? ''}</div>`).join('');
  const back = '<svg viewBox="0 0 24 24"><path d="M19 12H5M11 6l-6 6 6 6"/></svg>';
  const fwd = '<svg viewBox="0 0 24 24"><path d="M5 12h14M13 6l6 6-6 6"/></svg>';
  const reload = '<svg viewBox="0 0 24 24"><path d="M20 12a8 8 0 1 1-2.3-5.7M20 4v5h-5"/></svg>';
  return `<!doctype html><meta charset="utf-8"><style>${CSS}</style>
<div class="cap${s.caption === 'x' ? ' bad' : ''}"><span>${CAPTIONS[s.caption]}</span></div>
<div class="term"><div class="bar"><i></i><i></i><i></i></div><div class="rows">${rows}</div></div>
<div class="win${s.after ? ' ok' : ''}">
  <div class="tabs"><span class="lights"><i style="background:#ff5f57"></i><i style="background:#febc2e"></i><i style="background:#28c840"></i></span>
    <div class="tab"><span class="fav"></span>Demo page<span class="x">&times;</span></div></div>
  <div class="tool">${back}${fwd}${reload}<div class="url">${url}</div></div>
  <div class="view"><img src="${s.after ? IMG.after : IMG.before}"></div>
</div>`;
}

const renderer = await chromium.launch();
const rpage = await renderer.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
const cache = new Map();  // state -> png path
const sequence = [];
try {
  for (let i = 0; i < PRE_TICKS + MAIN_TICKS; i++) {
    const s = i < PRE_TICKS ? problemState(i) : stateAt((i - PRE_TICKS) * TICK + 1e-6);
    const key = JSON.stringify(s);
    if (!cache.has(key)) {
      const file = path.join(framesDir, `f${String(cache.size).padStart(3, '0')}.png`);
      await rpage.setContent(html(s), { waitUntil: 'load' });
      await rpage.screenshot({ path: file });
      cache.set(key, file);
    }
    sequence.push(cache.get(key));
  }
} finally {
  await renderer.close();
}
log(`${sequence.length} ticks, ${cache.size} distinct frames`);

// ---------------------------------------------------------------- 4. encode

// concat list with run lengths, so a held frame is one entry. The last entry is repeated, as ffmpeg's docs ask.
const list = [];
for (let i = 0; i < sequence.length;) {
  let j = i;
  while (j < sequence.length && sequence[j] === sequence[i]) j++;
  list.push(`file '${sequence[i]}'`, `duration ${((j - i) * TICK).toFixed(3)}`);
  i = j;
}
list.push(list[list.length - 2]);
const listFile = path.join(work, 'frames.txt');
fs.writeFileSync(listFile, list.join('\n') + '\n');

function ffmpeg(...args) {
  const r = spawnSync('ffmpeg', ['-y', '-v', 'error', '-f', 'concat', '-safe', '0', '-i', listFile, ...args], { stdio: 'inherit' });
  if (r.status !== 0) throw new Error(`ffmpeg failed: ${args.join(' ')}`);
}
ffmpeg('-vf', `fps=${FPS},split[a][b];[a]palettegen=max_colors=256:stats_mode=diff[p];[b][p]paletteuse=dither=none:diff_mode=rectangle`, '-t', TOTAL_SECONDS.toFixed(2), '-loop', '0', GIF);
ffmpeg('-vf', 'fps=25,pad=ceil(iw/2)*2:ceil(ih/2)*2:0:0:color=0x0d1117,format=yuv420p', '-c:v', 'libx264', '-preset', 'slow', '-crf', '20', '-movflags', '+faststart', '-an', '-t', TOTAL_SECONDS.toFixed(2), MP4);

const kb = f => (fs.statSync(f).size / 1024).toFixed(0);
log(`wrote ${GIF} (${kb(GIF)} KB) and ${MP4} (${kb(MP4)} KB)`);
log(`rewrites of captured text: ${rewrites.length ? rewrites.join('; ') : 'none'}`);
if (process.env.DEMO_KEEP) log(`kept ${work}`);
else fs.rmSync(work, { recursive: true, force: true });
