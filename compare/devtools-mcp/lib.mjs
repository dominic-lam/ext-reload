// Shared helpers: toy extensions, a local test page, Chrome launch with a temp profile, and an MCP client
// that drives chrome-devtools-mcp over stdio.
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

export const HERE = path.dirname(fileURLToPath(import.meta.url));
export const WORK = path.join(HERE, 'work');
// macOS only. On Linux or Windows, point this at your branded Chrome binary.
export const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
export const LOCAL_BIN = path.join(HERE, 'node_modules/chrome-devtools-mcp/build/src/bin/chrome-devtools-mcp.js');
export const wait = ms => new Promise(r => setTimeout(r, ms));

export function freshDir(name) {
  const dir = path.join(WORK, name);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// sw.js records MARK, every onInstalled reason, and keeps a storage key so a wipe would show.
export function writeToy(dir, { name = 'toy', version = '1.0', mark = 'a', extraCs = false, key } = {}) {
  fs.mkdirSync(dir, { recursive: true });
  const cs = [{ matches: ['http://127.0.0.1/*'], js: extraCs ? ['cs.js', 'cs2.js'] : ['cs.js'] }];
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({
    manifest_version: 3, name, version, ...(key ? { key } : {}),
    background: { service_worker: 'sw.js' },
    permissions: ['storage'],
    content_scripts: cs,
  }, null, 2));
  fs.writeFileSync(path.join(dir, 'sw.js'), `self.MARK = '${mark}';
chrome.runtime.onInstalled.addListener(async d => {
  const { events = [] } = await chrome.storage.local.get('events');
  events.push({ reason: d.reason, previousVersion: d.previousVersion ?? null, mark: '${mark}', at: Date.now() });
  await chrome.storage.local.set({ events });
});
`);
  // The content script stamps its mark, and keeps reporting whether its extension context is still alive.
  fs.writeFileSync(path.join(dir, 'cs.js'), `document.documentElement.dataset.toy = '${mark}';
setInterval(() => { document.documentElement.dataset.alive = (globalThis.chrome?.runtime?.id ? 'yes' : 'orphaned') + ':${mark}'; }, 100);
`);
  if (extraCs) fs.writeFileSync(path.join(dir, 'cs2.js'), `document.documentElement.dataset.toy2 = '${mark}';\n`);
}

export async function startPageServer() {
  const server = http.createServer((q, r) => {
    r.setHeader('content-type', 'text/html');
    r.end(`<html><head><title>page ${q.url}</title></head><body>test page ${q.url}</body></html>`);
  }).listen(0, '127.0.0.1');
  await new Promise(r => server.on('listening', r));
  return { server, url: p => `http://127.0.0.1:${server.address().port}${p}` };
}

// A Chrome WE start, never the user's: always its own temp --user-data-dir.
export async function launchChrome({ profile, port, unsafeExtDebugging = false, headless = true, extraArgs = [] }) {
  if (!profile) throw new Error('profile required');
  // Never talk to a browser we did not start: refuse a port that already answers.
  const taken = await fetch(`http://127.0.0.1:${port}/json/version`).then(() => true, () => false);
  if (taken) throw new Error(`port ${port} already answers; refusing to touch a browser this script did not start`);
  const args = [
    `--user-data-dir=${profile}`, `--remote-debugging-port=${port}`,
    '--no-first-run', '--no-default-browser-check', '--disable-sync', '--password-store=basic', '--use-mock-keychain',
    ...(headless ? ['--headless=new'] : []),
    ...(unsafeExtDebugging ? ['--enable-unsafe-extension-debugging'] : []),
    ...extraArgs, 'about:blank',
  ];
  const proc = spawn(CHROME, args, { stdio: ['ignore', 'ignore', 'pipe'] });
  let err = '';
  proc.stderr.on('data', d => { err += d; });
  for (let i = 0; i < 100; i++) {
    try {
      const v = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
      return { proc, version: v, stderr: () => err, close: () => killChrome(proc) };
    } catch { await wait(100); }
  }
  proc.kill('SIGKILL');
  throw new Error(`Chrome did not open port ${port}:\n${err}`);
}

export async function killChrome(proc) {
  if (proc.exitCode != null) return;
  const done = new Promise(r => proc.on('exit', r));
  proc.kill('SIGTERM');
  await Promise.race([done, wait(5000)]);
  if (proc.exitCode == null) proc.kill('SIGKILL');
}

// Raw CDP over the browser websocket (Node 22+ has WebSocket).
export async function cdp(port) {
  const { webSocketDebuggerUrl } = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
  const ws = new WebSocket(webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  let id = 0;
  const pending = new Map();
  ws.onmessage = e => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  };
  return {
    send: (method, params = {}, sessionId) => new Promise(res => {
      const i = ++id;
      pending.set(i, res);
      ws.send(JSON.stringify({ id: i, method, params, ...(sessionId ? { sessionId } : {}) }));
    }),
    close: () => ws.close(),
  };
}

// MCP client. via: 'npx' runs `npx -y chrome-devtools-mcp@latest`, 'local' runs the copy in node_modules.
export async function startMcp(serverArgs, { via = 'npx', log } = {}) {
  const [command, args] = via === 'npx'
    ? ['npx', ['-y', 'chrome-devtools-mcp@latest', ...serverArgs]]
    : [process.execPath, [LOCAL_BIN, ...serverArgs]];
  const transport = new StdioClientTransport({
    command, args, stderr: 'pipe',
    env: { ...process.env, CHROME_DEVTOOLS_MCP_NO_USAGE_STATISTICS: '1' },
  });
  let stderr = '';
  transport.stderr?.on('data', d => { stderr += d; });
  const client = new Client({ name: 'probe', version: '0.0.1' });
  await client.connect(transport);
  const call = async (name, args = {}) => {
    const t = Date.now();
    try {
      const r = await client.callTool({ name, arguments: args }, undefined, { timeout: 60_000 });
      const text = (r.content ?? []).filter(c => c.type === 'text').map(c => c.text).join('\n');
      if (log) log(`→ ${name} ${JSON.stringify(args)} (${Date.now() - t} ms)${r.isError ? ' ERROR' : ''}\n${indent(text)}`);
      return { text, isError: !!r.isError, structured: r.structuredContent, ms: Date.now() - t };
    } catch (e) {
      if (log) log(`→ ${name} ${JSON.stringify(args)} THREW (${Date.now() - t} ms): ${e.message}`);
      return { text: String(e.message), isError: true, threw: true, ms: Date.now() - t };
    }
  };
  return { client, call, stderr: () => stderr, close: () => client.close() };
}

export const indent = s => String(s).split('\n').map(l => '    ' + l).join('\n');

// Pull "N: url" page lines and the "sw-N: chrome-extension://..." worker lines out of a tool's text answer.
export function pagesFrom(text) {
  return [...text.matchAll(/^(\d+): (.*)$/gm)].map(m => ({ id: Number(m[1]), url: m[2] }));
}
export function workersFrom(text) {
  return [...text.matchAll(/^(sw-\d+): (\S+)/gm)].map(m => ({ id: m[1], url: m[2] }));
}
