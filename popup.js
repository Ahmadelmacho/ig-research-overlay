// Toolbar popup: asks the local updater helper (native host) about new releases.
// The extension itself makes no network requests; the helper talks to GitHub.
const HOST = 'com.igro.updater';
const loaded = chrome.runtime.getManifest().version;
const $ = (id) => document.getElementById(id);
$('ver').textContent = loaded;

// The installer writes a random marker into the folder; the helper reports its own copy.
// Same marker = the loaded extension is the folder the helper updates. (Packaged file, not network.)
const ownId = fetch(chrome.runtime.getURL('updater/install-id.txt'))
  .then((r) => (r.ok ? r.text() : null))
  .then((t) => (t ? t.trim() : null))
  .catch(() => null);

function say(text) { $('status').textContent = text; }

try {
  const updated = localStorage.getItem('igro-updated');
  if (updated) {
    localStorage.removeItem('igro-updated');
    if (updated === loaded) say(`Updated to ${loaded}. Refresh your Instagram tabs.`);
  }
} catch {}

function ask(cmd) {
  return new Promise((resolve) => {
    chrome.runtime.sendNativeMessage(HOST, { cmd }, (reply) => {
      const err = chrome.runtime.lastError;
      resolve(err ? { hostError: err.message } : reply || { ok: false, error: 'no reply' });
    });
  });
}

function hostMissing(r) {
  if (!r.hostError) return false;
  if (/not found/i.test(r.hostError)) {
    say('');
    $('install').hidden = false;
  } else {
    say('Updater error: ' + r.hostError);
  }
  return true;
}

$('check').addEventListener('click', async () => {
  $('check').disabled = true;
  $('update').hidden = true;
  $('install').hidden = true;
  say('Checking…');
  const r = await ask('check');
  const own = await ownId;
  $('check').disabled = false;
  if (hostMissing(r)) return;
  if (r.error) return say('Could not check: ' + r.error);
  const avail = r.updateAvailable ? `Version ${r.latest} is available.` : 'Up to date.';
  if (r.devCopy) return say(`${avail} Developer copy: update with git pull.`);
  if (!own || own !== r.installId) {
    return say(`The loaded copy (${loaded}) is from another folder than the updater's (${r.current}). ` +
      'Load the installed folder in chrome://extensions, or update this copy by hand.');
  }
  say(avail);
  if (r.updateAvailable) {
    $('update').textContent = `Update to v${r.latest}`;
    $('update').hidden = false;
  }
});

$('update').addEventListener('click', async () => {
  $('update').disabled = true;
  $('check').disabled = true;
  say('Updating…');
  const r = await ask('update');
  $('update').disabled = false;
  $('check').disabled = false;
  if (hostMissing(r)) return;
  if (r.devCopy) return say('Developer copy: update with git pull.');
  if (!r.ok) return say('Update failed: ' + (r.error || 'unknown error'));
  // Reload now (a timer would die if the popup closes); the next popup shows the result.
  try { localStorage.setItem('igro-updated', r.version); } catch {}
  chrome.runtime.reload();
});

$('copy').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText($('cmd').textContent);
    $('copy').textContent = 'Copied';
  } catch {
    $('copy').textContent = 'Select the text and copy it';
  }
});
