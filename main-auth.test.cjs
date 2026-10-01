'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { pathToFileURL } = require('node:url');
const source = fs.readFileSync(path.join(__dirname, 'main.cjs'), 'utf8');

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

function profile(name) {
  return {
    issuer: 'https://auth.openai.com', client_id: `client-${name}`, subject: name,
    can_call_api: true, accountLabel: name, access_token: `${name}-access`,
    refresh_token: `${name}-refresh`, expires_at: 0,
  };
}

// Run the real IPC handlers in an isolated VM. Electron, disk writes, browser
// opening, speech, inference and OAuth are mocked; network modules are denied.
function harness(t, oauth) {
  const handlers = new Map(), events = [], writes = [], requests = [], revocations = [];
  const timers = new Set();
  t.after(() => { for (const timer of timers) clearTimeout(timer); });
  const webContents = { send: (_, event) => events.push(event) };
  const window = { webContents, isDestroyed: () => false, isContentProtected: () => true };
  const electron = {
    app: {
      getPath: () => path.join(__dirname, 'mock-user-data'), setPath() {}, setName() {},
      whenReady: () => ({ then: () => ({ catch() {} }) }), on() {},
    },
    ipcMain: { handle: (name, handler) => handlers.set(name, handler), on() {} },
    safeStorage: { isEncryptionAvailable: () => true, encryptString: value => Buffer.from(value) },
    globalShortcut: { isRegistered: () => true },
    shell: { openExternal: async () => { throw new Error('Unexpected browser request.'); } },
  };
  const mocks = {
    electron,
    './provider-adapters.cjs': { streamProviderAnswer: async value => { requests.push(value); return { text: 'Test answer.' }; },
      validateBaseUrl: require('./provider-adapters.cjs').validateBaseUrl,
      listProviderModels: async () => { throw new Error('Unexpected non-plan catalog request.'); } },
    './speech.cjs': { SpeechSession: class { constructor() { throw new Error('Unexpected speech session.'); } } },
    './turns.cjs': require('./turns.cjs'),
    './routing.cjs': require('./routing.cjs'),
    './oauth.cjs': {
      beginSignIn: async () => { throw new Error('Unexpected sign-in.'); },
      refreshProfile: async () => { throw new Error('Unexpected refresh.'); },
      listModels: async () => [],
      revokeProfile: async value => { revocations.push(value); return { revoked: true }; },
      ...oauth,
    },
    'node:fs': {
      mkdirSync() {}, writeFileSync: (_, content) => writes.push(JSON.parse(content)), renameSync() {},
    },
    'node:crypto': require('node:crypto'),
    'node:path': path,
    'node:url': require('node:url'),
  };
  const context = vm.createContext({
    require: id => {
      if (!Object.hasOwn(mocks, id)) throw new Error(`Unmocked module denied: ${id}`);
      return mocks[id];
    },
    process: { argv: [], env: {} }, __dirname, Buffer, URL, AbortController, AbortSignal,
    setTimeout: (callback, delay) => { const timer = setTimeout(callback, delay); timers.add(timer); return timer; },
    clearTimeout: timer => { timers.delete(timer); clearTimeout(timer); },
    windowForTest: window,
  });
  vm.runInContext(source + `
    win = windowForTest;
    registerIPC();
    globalThis.probe = {
      setProfile(value) { chatgptProfile = value; },
      state() { return { profile: chatgptProfile, authController, generation: authGeneration, model: settings.model, catalog: publicCatalog() }; }
    };
  `, context, { filename: 'main.cjs' });
  const invoke = (name, ...args) => handlers.get(name)({
    sender: webContents,
    senderFrame: { url: pathToFileURL(path.join(__dirname, 'index.html')).href },
  }, ...args);
  return {
    invoke, events, writes, requests, revocations,
    state: () => context.probe.state(), setProfile: value => context.probe.setProfile(value),
  };
}

test('cancel sign-in rejects late replacement while preserving an existing account', { timeout: 2000 }, async t => {
  const gate = deferred();
  const previous = profile('previous');
  const h = harness(t, { beginSignIn: async ({ persist }) => { await gate.promise; const next = profile('late'); await persist(next); return next; } });
  h.setProfile(previous);
  const signingIn = h.invoke('auth:connect');
  const controller = h.state().authController;
  await h.invoke('auth:cancel');
  assert.equal(controller.signal.aborted, true);
  assert.equal(h.state().authController, null);
  assert.equal(h.state().profile, previous);
  assert.equal(h.revocations.length, 0);
  gate.resolve(); await signingIn;
  assert.equal(h.state().profile, previous);
  assert.equal(h.events.some(event => event.type === 'auth-complete'), false);
});

test('refresh finishing after disconnect cannot restore the account or start inference', { timeout: 2000 }, async t => {
  const gate = deferred();
  let refresh;
  const h = harness(t, { refreshProfile: (_, options) => { refresh = options; return gate.promise; } });
  const original = profile('old');
  h.setProfile(original);
  const answer = h.invoke('answer:ask', { question: 'Explain a mutex.' });
  await h.invoke('auth:disconnect');
  refresh.persist(profile('rotated'));
  gate.resolve(profile('rotated'));
  await answer;
  assert.equal(h.state().profile, null);
  assert.equal(h.writes.at(-1).chatgpt, null);
  assert.equal(h.requests.length, 0);
  assert.equal(h.revocations[0], original);
});

test('refresh from an earlier account generation cannot overwrite a successful replacement', { timeout: 2000 }, async t => {
  const gate = deferred();
  let refresh;
  const replacement = profile('replacement');
  replacement.expires_at = Date.now() + 3600000;
  const h = harness(t, {
    refreshProfile: (_, options) => { refresh = options; return gate.promise; },
    beginSignIn: async options => { options.persist(replacement); return replacement; },
  });
  h.setProfile(profile('old'));
  const answer = h.invoke('answer:ask', { question: 'Explain a mutex.' });
  await h.invoke('auth:connect');
  refresh.persist(profile('stale-rotation'));
  gate.resolve(profile('stale-rotation'));
  await answer;
  assert.equal(h.state().profile, replacement);
  assert.equal(h.requests.length, 0);
});

test('cancelled sign-in cannot persist or clear a newer controller; listening waits for sign-in', { timeout: 2000 }, async t => {
  const attempts = [];
  const h = harness(t, {
    beginSignIn: options => {
      const gate = deferred();
      attempts.push({ options, gate });
      return gate.promise;
    },
  });
  const first = h.invoke('auth:connect');
  await assert.rejects(h.invoke('listen:start', { sampleRate: 16000 }), /sign-in/);
  await h.invoke('auth:disconnect');
  const second = h.invoke('auth:connect');
  const secondController = h.state().authController;
  attempts[0].options.persist(profile('stale-signin'));
  attempts[0].gate.resolve(profile('stale-signin'));
  await first;
  assert.equal(h.state().profile, null);
  assert.equal(h.state().authController, secondController);
  await assert.rejects(h.invoke('listen:start', { sampleRate: 16000 }), /sign-in/);
  const current = profile('current');
  attempts[1].options.persist(current);
  attempts[1].gate.resolve(current);
  await second;
  assert.equal(h.state().profile, current);
  assert.equal(h.state().authController, null);
  assert.equal(h.events.filter(event => event.type === 'auth-complete').length, 1);
});

test('model discovery finishing after disconnect cannot change model or report a connection', { timeout: 2000 }, async t => {
  const models = deferred(), started = deferred();
  const current = profile('current');
  const h = harness(t, {
    beginSignIn: async options => { options.persist(current); return current; },
    listModels: () => { started.resolve(); return models.promise; },
  });
  const modelBefore = h.state().model;
  const connecting = h.invoke('auth:connect');
  await started.promise;
  await h.invoke('auth:disconnect');
  models.resolve([{ slug: 'stale-model' }]);
  await connecting;
  assert.equal(h.state().profile, null);
  assert.equal(h.state().model, modelBefore);
  assert.equal(h.events.some(event => event.type === 'auth-complete'), false);
});

test('model catalog refresh rotates an expired plan token safely and never starts inference', async t => {
  let listedProfile;
  const rotated = { ...profile('same'), expires_at: Date.now() + 3600000 };
  const h = harness(t, {
    refreshProfile: async (_old, { persist }) => { persist(rotated); return rotated; },
    listModels: async value => { listedProfile = value; return [{ slug: 'gpt-6-luna', display_name: 'Luna' }]; },
  });
  h.setProfile(profile('same'));
  const catalog = await h.invoke('models:refresh');
  assert.equal(listedProfile, rotated);
  assert.equal(h.state().profile, rotated);
  assert.equal(catalog.status, 'ready');
  assert.deepEqual(Array.from(catalog.models, model => model.slug), ['gpt-6-luna']);
  assert.equal(JSON.stringify(catalog).includes('same-access'), false);
  assert.equal(h.requests.length, 0);
});

test('catalog refresh completing after disconnect cannot restore profile or catalog', async t => {
  const gate = deferred();
  let rotation, listCalls = 0;
  const h = harness(t, {
    refreshProfile: (_profile, options) => { rotation = options; return gate.promise; },
    listModels: async () => { listCalls++; return [{ slug: 'gpt-6-luna' }]; },
  });
  h.setProfile(profile('previous'));
  const refreshing = h.invoke('models:refresh');
  await h.invoke('auth:disconnect');
  const rotated = { ...profile('previous'), expires_at: Date.now() + 3600000 };
  rotation.persist(rotated); gate.resolve(rotated); await refreshing;
  assert.equal(h.state().profile, null);
  assert.equal(h.state().catalog.status, 'unavailable');
  assert.equal(h.state().catalog.models.length, 0);
  assert.equal(listCalls, 0);
  assert.equal(h.requests.length, 0);
});

test('a catalog from an older account cannot replace the newly connected account catalog', async t => {
  const gate = deferred();
  const replacement = { ...profile('replacement'), expires_at: Date.now() + 3600000 };
  const h = harness(t, {
    beginSignIn: async options => { options.persist(replacement); return replacement; },
    listModels: value => value.subject === 'previous' ? gate.promise : Promise.resolve([{ slug: 'gpt-5.6-luna' }]),
  });
  h.setProfile({ ...profile('previous'), expires_at: Date.now() + 3600000 });
  const refreshing = h.invoke('models:refresh');
  await h.invoke('auth:connect');
  gate.resolve([{ slug: 'gpt-6-luna' }]); await refreshing;
  assert.equal(h.state().profile, replacement);
  assert.deepEqual(Array.from(h.state().catalog.models, model => model.slug), ['gpt-5.6-luna']);
  assert.equal(h.state().model, 'gpt-5.6-luna');
  assert.equal(h.requests.length, 0);
});

test('connecting ChatGPT does not replace a selected API provider or its model', async t => {
  const replacement = { ...profile('new-plan'), expires_at: Date.now() + 3600000 };
  const h = harness(t, {
    beginSignIn: async options => { options.persist(replacement); return replacement; },
    listModels: async () => [{ slug: 'gpt-6-luna' }],
  });
  h.invoke('settings:save', { answerProvider: 'anthropic', anthropicKey: 'claude-test-key', model: 'claude-sonnet-5-5' });
  await h.invoke('auth:connect');
  const setup = h.invoke('settings:get');
  assert.equal(setup.answerProvider, 'anthropic');
  assert.equal(setup.model, 'claude-sonnet-5-5');
  assert.equal(setup.chatgptCanCall, true);
  assert.equal(setup.providerModels.chatgpt, 'gpt-6-luna');
  await h.invoke('answer:ask', { question: 'What is a closure?' });
  assert.equal(h.requests[0].provider, 'anthropic');
  assert.equal(h.requests[0].apiKey, 'claude-test-key');
});

test('an answer token rotation persists after switching providers without starting the cancelled plan answer', async t => {
  const gate = deferred();
  let options;
  const h = harness(t, { refreshProfile: (_profile, value) => { options = value; return gate.promise; } });
  h.setProfile(profile('same-account'));
  const answer = h.invoke('answer:ask', { question: 'What is a closure?' });
  h.invoke('settings:save', { answerProvider: 'anthropic', anthropicKey: 'claude-test-key' });
  assert.equal(options.signal.aborted, true);
  const rotated = { ...profile('same-account'), access_token: 'rotated-access', refresh_token: 'rotated-refresh', expires_at: Date.now() + 3600000 };
  options.persist(rotated); gate.resolve(rotated); await answer;
  assert.equal(h.state().profile, rotated);
  assert.equal(h.requests.length, 0);
  assert.equal(h.events.some(event => event.type === 'answer-cancelled'), true);
  const savedProfile = JSON.parse(Buffer.from(h.writes.at(-1).chatgpt, 'base64').toString());
  assert.equal(savedProfile.refresh_token, 'rotated-refresh');
  h.invoke('settings:save', { answerProvider: 'chatgpt' });
  await h.invoke('answer:ask', { question: 'What is a stack?' });
  assert.equal(h.requests[0].apiKey, 'rotated-access');
});

test('a catalog token rotation persists after switching providers but cannot publish the old catalog', async t => {
  const gate = deferred();
  let options, listCalls = 0;
  const h = harness(t, {
    refreshProfile: (_profile, value) => { options = value; return gate.promise; },
    listModels: async () => { listCalls++; return [{ slug: 'gpt-6-luna' }]; },
  });
  h.setProfile(profile('same-account'));
  const catalog = h.invoke('models:refresh');
  h.invoke('settings:save', { answerProvider: 'anthropic', anthropicKey: 'claude-test-key' });
  const rotated = { ...profile('same-account'), refresh_token: 'rotated-refresh', expires_at: Date.now() + 3600000 };
  options.persist(rotated); gate.resolve(rotated); await catalog;
  assert.equal(h.state().profile, rotated);
  assert.equal(listCalls, 0);
  assert.equal(h.state().catalog.provider, 'anthropic');
  assert.equal(h.state().catalog.models.length, 0);
});
