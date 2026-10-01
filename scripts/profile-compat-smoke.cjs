'use strict';
// Uses only a synthetic credential and an isolated temporary profile. No network.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
if (process.versions.electron) {
  const { app, safeStorage } = require('electron');
  const { createProfileStore } = require('../profile.cjs');
  const [stage, directory] = process.argv.slice(2);
  app.setName(stage === 'write' ? 'Callside' : 'prateekAi'); app.setPath('userData', directory);
  app.whenReady().then(() => {
    const store = createProfileStore({ directory, safeStorage }), loaded = store.load();
    if (stage === 'write') { if (loaded.status !== 'missing') throw new Error('Expected isolated fresh profile'); store.save({ settings: { answerFontSize: 22 }, secrets: { deepgram: 'synthetic-compatibility-fixture' }, chatgptProfile: { client_id: 'synthetic-saved-client', refresh_token: 'synthetic-refresh-token' }, hostId: 'urn:uuid:00000000-0000-0000-0000-000000000002' }); }
    else if (loaded.status !== 'loaded' || loaded.secrets.deepgram !== 'synthetic-compatibility-fixture' || loaded.chatgptProfile.client_id !== 'synthetic-saved-client' || loaded.settings.answerFontSize !== 22) throw new Error('Renamed application could not read the synthetic profile');
    app.quit(); // Flush Electron's profile encryption metadata before reopening it.
  }).catch(() => app.exit(1));
} else {
  const { spawnSync } = require('node:child_process');
  const parent = fs.realpathSync(os.tmpdir()), directory = fs.mkdtempSync(path.join(parent, 'prateekai-compat-'));
  try {
    const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
    for (const stage of ['write', 'read']) {
      const result = spawnSync(require('electron'), [__filename, stage, directory], { env, windowsHide: true, timeout: 20000, stdio: 'pipe' });
      if (result.status !== 0) throw new Error(`Isolated profile compatibility ${stage} failed (${result.error?.code || result.signal || result.status}); no user profile was accessed.`);
    }
    console.log('PASS: real Windows encrypted profile survives Callside → prateekAi app-name change.');
  } finally { if (path.dirname(directory) === parent && path.basename(directory).startsWith('prateekai-compat-')) fs.rmSync(directory, { recursive: true, force: true }); }
}
