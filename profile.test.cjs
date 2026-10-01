'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { resolveProfileDirectory, createProfileStore, SECRET_NAMES } = require('./profile.cjs');
const fakeStorage = { isEncryptionAvailable: () => true, encryptString: text => Buffer.from(`fixture:${text}`), decryptString: bytes => { const text = bytes.toString(); if (!text.startsWith('fixture:')) throw new Error('Synthetic decryption failure'); return text.slice(8); } };
function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'prateekai-profile-test-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return { directory, configPath: path.join(directory, 'settings.json'), store: createProfileStore({ directory, safeStorage: fakeStorage }) };
}
const payload = () => ({ settings: { answerProvider: 'anthropic', roleTitle: 'Synthetic role' }, secrets: { anthropic: 'synthetic-provider-key', deepgram: 'synthetic-speech-key' }, hostId: 'urn:uuid:00000000-0000-0000-0000-000000000001', chatgptProfile: { client_id: 'saved-client-id', refresh_token: 'synthetic-refresh', ext_agent_host_id: 'same-host' } });
test('new installations select the exact-case new profile', t => { const f = fixture(t); assert.equal(resolveProfileDirectory({ appData: f.directory, env: {} }), path.join(f.directory, 'prateekAi')); });
test('legacy profile remains in place even when an empty new directory exists', t => {
  const f = fixture(t), legacy = path.join(f.directory, 'Callside'); fs.mkdirSync(legacy); fs.writeFileSync(path.join(legacy, 'settings.json'), 'not read during resolution'); fs.mkdirSync(path.join(f.directory, 'prateekAi'));
  assert.equal(resolveProfileDirectory({ appData: f.directory, env: {} }), legacy);
});
test('existing new settings take precedence when both profiles exist without merging', t => {
  const f = fixture(t); for (const name of ['Callside', 'prateekAi']) { fs.mkdirSync(path.join(f.directory, name)); fs.writeFileSync(path.join(f.directory, name, 'settings.json'), '{}'); }
  assert.equal(resolveProfileDirectory({ appData: f.directory, env: {} }), path.join(f.directory, 'prateekAi'));
});
test('new environment override wins, legacy alias remains supported', t => {
  const f = fixture(t), one = path.join(f.directory, 'one'), two = path.join(f.directory, 'two');
  assert.equal(resolveProfileDirectory({ appData: f.directory, env: { PRATEEKAI_DATA_DIR: one, CALLSIDE_DATA_DIR: two } }), one);
  assert.equal(resolveProfileDirectory({ appData: f.directory, env: { CALLSIDE_DATA_DIR: two } }), two);
});
test('relative profile overrides are rejected without filesystem writes', t => { const f = fixture(t); assert.throws(() => resolveProfileDirectory({ appData: f.directory, env: { PRATEEKAI_DATA_DIR: 'relative' } }), { code: 'PROFILE_PATH_INVALID' }); assert.deepEqual(fs.readdirSync(f.directory), []); });
test('fresh store loads before saving encrypted credentials and stable OAuth identity', t => {
  const f = fixture(t); assert.throws(() => f.store.save(payload()), { code: 'PROFILE_READ_ONLY' }); assert.equal(f.store.load().status, 'missing'); f.store.save(payload());
  const text = fs.readFileSync(f.configPath, 'utf8'); assert.ok(!text.includes('synthetic-provider-key')); assert.ok(!text.includes('synthetic-refresh'));
  const loaded = createProfileStore({ directory: f.directory, safeStorage: fakeStorage }).load();
  assert.equal(loaded.status, 'loaded'); assert.equal(loaded.secrets.anthropic, 'synthetic-provider-key'); assert.equal(loaded.chatgptProfile.client_id, 'saved-client-id'); assert.equal(loaded.hostId, payload().hostId); assert.equal(loaded.settings.roleTitle, 'Synthetic role');
});
for (const [label, text] of [['malformed JSON', '{broken'], ['invalid document', '[]'], ['invalid settings', '{"settings":[]}'], ['invalid keys', '{"keys":[]}'], ['invalid ciphertext', '{"keys":{"openai":"!invalid!"}}'], ['unreadable encrypted value', '{"keys":{"openai":"YmFk"}}']]) {
  test(`${label} locks writes and preserves the original file`, t => { const f = fixture(t); fs.writeFileSync(f.configPath, text); assert.equal(f.store.load().status, 'error'); assert.equal(f.store.canSave, false); assert.throws(() => f.store.save(payload()), { code: 'PROFILE_READ_ONLY' }); assert.equal(fs.readFileSync(f.configPath, 'utf8'), text); });
}
test('decryption failure never returns partially decrypted credentials', t => {
  const f = fixture(t); const text = JSON.stringify({ settings: { model: 'saved-model' }, keys: { openai: fakeStorage.encryptString('synthetic-good').toString('base64'), anthropic: Buffer.from('bad').toString('base64') } }); fs.writeFileSync(f.configPath, text);
  const loaded = f.store.load(); assert.equal(loaded.status, 'error'); assert.equal(loaded.settings.model, 'saved-model'); for (const name of SECRET_NAMES) assert.equal(loaded.secrets[name], ''); assert.ok(!loaded.message.includes('synthetic-good'));
});
test('unavailable encrypted storage preserves an established profile', t => {
  const f = fixture(t); f.store.load(); f.store.save(payload()); const original = fs.readFileSync(f.configPath, 'utf8');
  const locked = createProfileStore({ directory: f.directory, safeStorage: { ...fakeStorage, isEncryptionAvailable: () => false } }); assert.equal(locked.load().status, 'error'); assert.throws(() => locked.save(payload()), { code: 'PROFILE_READ_ONLY' }); assert.equal(fs.readFileSync(f.configPath, 'utf8'), original);
});
test('file access errors are not treated as first run', t => { const f = fixture(t); const store = createProfileStore({ directory: f.directory, safeStorage: fakeStorage, fileSystem: { readFileSync: () => { throw Object.assign(new Error('private path'), { code: 'EACCES' }); } } }); const result = store.load(); assert.equal(result.status, 'error'); assert.ok(!result.message.includes('private path')); assert.throws(() => store.save(payload()), { code: 'PROFILE_READ_ONLY' }); });
test('external profile edits cannot be overwritten by a stale app', t => {
  const f = fixture(t); f.store.load(); f.store.save(payload()); fs.writeFileSync(f.configPath, '{"settings":{"external":true}}'); assert.throws(() => f.store.save(payload()), { code: 'PROFILE_CHANGED' }); assert.equal(fs.readFileSync(f.configPath, 'utf8'), '{"settings":{"external":true}}');
});
test('encryption errors leave the previous bytes untouched', t => {
  const f = fixture(t); f.store.load(); f.store.save(payload()); const original = fs.readFileSync(f.configPath, 'utf8'); const broken = createProfileStore({ directory: f.directory, safeStorage: { ...fakeStorage, encryptString: () => { throw new Error('do not expose key'); } } }); broken.load(); assert.throws(() => broken.save(payload()), { code: 'PROFILE_ENCRYPTION_FAILED' }); assert.equal(fs.readFileSync(f.configPath, 'utf8'), original); assert.equal(fs.readdirSync(f.directory).length, 1);
});
test('rename failure preserves the old profile and removes only its temporary write', t => {
  const f = fixture(t); f.store.load(); f.store.save(payload()); const original = fs.readFileSync(f.configPath, 'utf8'); const broken = createProfileStore({ directory: f.directory, safeStorage: fakeStorage, fileSystem: { ...fs, renameSync: () => { throw new Error('synthetic failure'); } } }); broken.load(); assert.throws(() => broken.save(payload()), { code: 'PROFILE_WRITE_FAILED' }); assert.equal(fs.readFileSync(f.configPath, 'utf8'), original); assert.deepEqual(fs.readdirSync(f.directory), ['settings.json']);
});
test('unknown encrypted fields are preserved and known keys may be explicitly cleared', t => {
  const f = fixture(t); fs.writeFileSync(f.configPath, JSON.stringify({ settings: {}, keys: { futureProvider: 'opaque-future-field', openai: fakeStorage.encryptString('synthetic').toString('base64') }, futureVersion: 2 })); f.store.load(); f.store.save({ settings: {}, secrets: {}, hostId: 'host' }); const document = JSON.parse(fs.readFileSync(f.configPath, 'utf8')); assert.equal(document.keys.futureProvider, 'opaque-future-field'); assert.equal(document.keys.openai, undefined); assert.equal(document.futureVersion, 2);
});
