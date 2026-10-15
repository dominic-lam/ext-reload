// The popup's version line under the name, and, when a newer ext-reload is out, a prompt to copy for your
// agent in place of the green note. The CLI's daily check writes update.json next to this page, and an unpacked
// extension reads its own files fresh from disk. The helper never goes online.

const ver = document.getElementById('ver');
// Guarded so popup.html still renders opened as a plain file, where there is no chrome.runtime.
const installed = globalThis.chrome?.runtime?.getManifest?.()?.version;

function sub(version, text) {
  ver.textContent = version ? `v${version} · ${text}` : text;
  ver.hidden = false;
}

function offerUpdate(state) {
  // update.json from 1.6.0 on carries the CLI's own path; older ones fall back to the bare name.
  document.getElementById('prompt').textContent = `Run ${state.cli ?? 'ext-reload.mjs'} --update to update ext-reload.`;
  document.getElementById('upd-title').textContent = `Update available: v${state.latest}`;
  document.getElementById('ok').hidden = true;
  document.getElementById('upd').hidden = false;
}

function render(state) {
  const version = state?.current ?? installed;
  if (state?.status === 'available') {
    sub(version, 'Update available');
    offerUpdate(state);
  } else if (state?.status === 'current') {
    sub(version, 'Up to date');
  } else if (state?.status === 'failed') {
    sub(version, 'Could not check for updates');
  } else {
    sub(installed, installed ? 'Not checked yet' : 'Not checked for updates yet');
  }
}

const copy = document.getElementById('copy');
copy.addEventListener('click', async () => {
  const prompt = document.getElementById('prompt');
  const label = copy.querySelector('span');
  try {
    await navigator.clipboard.writeText(prompt.textContent);
    label.textContent = 'Copied';
  } catch {
    getSelection().selectAllChildren(prompt);  // so ⌘C or Ctrl+C still works
    label.textContent = 'Selected';
  }
  setTimeout(() => { label.textContent = 'Copy'; }, 1500);
});

fetch('update.json', { cache: 'no-store' })
  .then(r => (r.ok ? r.json() : null))
  .catch(() => null)
  .then(render);
