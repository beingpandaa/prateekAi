'use strict';

// Main-process storage only. Never send this module's decrypted values to a renderer.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const SECRET_NAMES = Object.freeze(['openai', 'anthropic', 'gemini', 'compatible', 'deepgram']);
const MAX_CONFIG_BYTES = 2 * 1024 * 1024;
const READ_ERROR = 'Saved settings could not be read or decrypted. The existing profile has been preserved. Close other versions, restore the profile if needed, and restart; saving is disabled until it can be read.';
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const emptySecrets = () => Object.fromEntries(SECRET_NAMES.map(name => [name, '']));
const failure = (message, code) => Object.assign(new Error(message), { code });

function resolveProfileDirectory({ appData, env = process.env, fileSystem = fs }) {
  const override = env.PRATEEKAI_DATA_DIR || env.CALLSIDE_DATA_DIR;
  if (override) {
    if (typeof override !== 'string' || !path.isAbsolute(override)) throw failure('The profile directory override must be an absolute path.', 'PROFILE_PATH_INVALID');
    return path.normalize(override);
  }
  if (typeof appData !== 'string' || !path.isAbsolute(appData)) throw failure('The application data directory is unavailable.', 'PROFILE_PATH_INVALID');
  const current = path.join(appData, 'prateekAi'), legacy = path.join(appData, 'Callside');
  // An empty new directory must not hide an established legacy installation.
  // Select paths by presence only; parsing/decryption happens after app ready.
  if (fileSystem.existsSync(path.join(current, 'settings.json'))) return current;
  if (fileSystem.existsSync(path.join(legacy, 'settings.json'))) return legacy;
  return current;
}

function createProfileStore({ directory, safeStorage, fileSystem = fs }) {
  if (typeof directory !== 'string' || !path.isAbsolute(directory)) throw failure('The profile directory must be an absolute path.', 'PROFILE_PATH_INVALID');
  const configPath = path.join(directory, 'settings.json');
  let status = 'unloaded', savedDocument = {}, diskFingerprint = null;
  const fingerprint = text => crypto.createHash('sha256').update(text).digest('hex');
  const read = () => {
    const text = fileSystem.readFileSync(configPath, 'utf8');
    if (Buffer.byteLength(text, 'utf8') > MAX_CONFIG_BYTES) throw new Error('Oversized configuration');
    return text;
  };
  const decrypt = value => {
    if (typeof value !== 'string' || !value.length || value.length > MAX_CONFIG_BYTES || !/^[A-Za-z0-9+/]+={0,2}$/.test(value) || value.length % 4 !== 0) throw new Error('Invalid encrypted field');
    if (!safeStorage.isEncryptionAvailable()) throw new Error('Encrypted storage unavailable');
    return safeStorage.decryptString(Buffer.from(value, 'base64'));
  };
  function load() {
    let text;
    try { text = read(); }
    catch (error) {
      if (error.code === 'ENOENT') { status = 'missing'; diskFingerprint = null; savedDocument = {}; return { status, settings: {}, secrets: emptySecrets(), chatgptProfile: null, hostId: null, message: '' }; }
      status = 'error'; return { status, settings: {}, secrets: emptySecrets(), chatgptProfile: null, hostId: null, message: READ_ERROR };
    }
    let parsed;
    try {
      parsed = JSON.parse(text.replace(/^\uFEFF/, ''));
      if (!object(parsed) || (parsed.settings !== undefined && !object(parsed.settings)) || (parsed.keys !== undefined && !object(parsed.keys))) throw new Error('Invalid profile structure');
      const secrets = emptySecrets();
      for (const name of SECRET_NAMES) if (parsed.keys?.[name]) secrets[name] = decrypt(parsed.keys[name]);
      const chatgptProfile = parsed.chatgpt ? JSON.parse(decrypt(parsed.chatgpt)) : null;
      if (chatgptProfile !== null && !object(chatgptProfile)) throw new Error('Invalid saved account');
      status = 'loaded'; diskFingerprint = fingerprint(text); savedDocument = parsed;
      return { status, settings: parsed.settings || {}, secrets, chatgptProfile, hostId: parsed.hostId || null, message: '' };
    } catch {
      // Return useful non-secret preferences, but no partially decrypted accounts.
      status = 'error';
      return { status, settings: object(parsed?.settings) ? parsed.settings : {}, secrets: emptySecrets(), chatgptProfile: null, hostId: parsed?.hostId || null, message: READ_ERROR };
    }
  }
  function assertWritable() {
    if (status !== 'loaded' && status !== 'missing') throw failure(READ_ERROR, 'PROFILE_READ_ONLY');
    // Refuse to overwrite a profile changed by another running version/process.
    let current = null;
    try { current = fingerprint(read()); } catch (error) { if (error.code !== 'ENOENT') throw failure('The profile cannot be checked safely. Nothing was saved.', 'PROFILE_WRITE_FAILED'); }
    if (current !== diskFingerprint) { status = 'error'; throw failure('The saved profile changed outside this app. Nothing was overwritten. Close other versions and restart.', 'PROFILE_CHANGED'); }
  }
  function save({ settings, secrets, chatgptProfile = null, hostId }) {
    assertWritable();
    if (!object(settings) || !object(secrets) || (chatgptProfile !== null && !object(chatgptProfile))) throw failure('Invalid settings supplied for saving.', 'PROFILE_INVALID');
    const keys = { ...(savedDocument.keys || {}) };
    const encrypt = value => {
      if (!safeStorage.isEncryptionAvailable()) throw failure('Windows encrypted storage is unavailable. Credentials were not saved.', 'PROFILE_ENCRYPTION_UNAVAILABLE');
      try { return safeStorage.encryptString(value).toString('base64'); }
      catch { throw failure('Windows could not encrypt the credentials. The existing profile was preserved.', 'PROFILE_ENCRYPTION_FAILED'); }
    };
    for (const name of SECRET_NAMES) {
      const value = secrets[name];
      if (value !== undefined && typeof value !== 'string') throw failure('Invalid credential supplied for saving.', 'PROFILE_INVALID');
      if (value) keys[name] = encrypt(value); else delete keys[name];
    }
    const chatgpt = chatgptProfile ? encrypt(JSON.stringify(chatgptProfile)) : null;
    const document = { ...savedDocument, settings, keys, hostId, chatgpt };
    const text = JSON.stringify(document);
    if (Buffer.byteLength(text, 'utf8') > MAX_CONFIG_BYTES) throw failure('The settings file is too large to save.', 'PROFILE_INVALID');
    fileSystem.mkdirSync(directory, { recursive: true });
    const temporary = `${configPath}.${process.pid}.${crypto.randomUUID()}.tmp`;
    try {
      fileSystem.writeFileSync(temporary, text, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
      assertWritable();
      fileSystem.renameSync(temporary, configPath);
    } catch (error) {
      try { fileSystem.unlinkSync(temporary); } catch { /* No original profile is removed. */ }
      if (error.code === 'PROFILE_CHANGED') throw error;
      throw failure('The settings could not be saved. The existing profile was preserved.', 'PROFILE_WRITE_FAILED');
    }
    savedDocument = document; diskFingerprint = fingerprint(text); status = 'loaded';
  }
  return { load, save, get status() { return status; }, get canSave() { return status === 'loaded' || status === 'missing'; }, configPath };
}

module.exports = { resolveProfileDirectory, createProfileStore, SECRET_NAMES };
