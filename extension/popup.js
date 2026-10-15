// The popup's version line under the name, and a footer only when a newer ext-reload is out. The CLI's daily
// check writes update.json next to this page, and an unpacked extension reads its own files fresh from disk. The
// helper never goes online.

const ver = document.getElementById('ver');
const line = document.getElementById('update');
// Guarded so popup.html still renders opened as a plain file, where there is no chrome.runtime.
const installed = globalThis.chrome?.runtime?.getManifest?.()?.version;

function sub(version, text) {
  ver.textContent = version ? `v${version} · ${text}` : text;
  ver.hidden = false;
}

function show(...parts) {
  for (const part of parts) {
    if (typeof part === 'string') line.append(part);
    else line.append(Object.assign(document.createElement(part.tag), { className: part.cls ?? '', textContent: part.text }));
  }
  line.hidden = false;
}

function render(state) {
  const version = state?.current ?? installed;
  if (state?.status === 'available') {
    sub(version, 'Update available');
    show({ tag: 'strong', text: `Update available: v${state.latest}.` }, ' Ask your coding agent to run ',
      { tag: 'span', cls: 'cmd', text: 'ext-reload.mjs --update' }, '.');
  } else if (state?.status === 'current') {
    sub(version, 'Up to date');
  } else if (state?.status === 'failed') {
    sub(version, 'Could not check for updates');
  } else {
    sub(installed, installed ? 'Not checked yet' : 'Not checked for updates yet');
  }
}

fetch('update.json', { cache: 'no-store' })
  .then(r => (r.ok ? r.json() : null))
  .catch(() => null)
  .then(render);
