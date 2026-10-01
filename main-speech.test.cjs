'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { pathToFileURL } = require('node:url');
const source = fs.readFileSync(path.join(__dirname, 'main.cjs'), 'utf8');

const settle = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
const enableVoice = (h, values = {}) => h.invoke('settings:save', { voiceFallbackEnabled: true, ...values });
function deferred() {
  let resolve, reject;
  const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

// Real IPC and TurnAssembler with a deterministic clock. No Electron window,
// account credentials, filesystem writes, audio capture or network requests.
function harness(t, { credentials = true, holdAnswers = false, oauth = {}, fetchImpl, catalogImpl, savedConfig, contentLoad, workArea = { x: 0, y: 0, width: 1440, height: 900 } } = {}) {
  let now = 0, nextTimer = 0;
  const timers = new Map(), handlers = new Map(), listeners = new Map();
  const events = [], writes = [], connections = [], requests = [], fetches = [], catalogRequests = [];
  const setTimer = (callback, delay) => { const id = ++nextTimer; timers.set(id, { callback, at: now + delay }); return id; };
  const clearTimer = id => timers.delete(id);
  const windows = [], appEvents = new Map(), hotkeys = new Map(), appState = { quitCalls: 0, quitting: false };
  const browserSession = {
    setPermissionRequestHandler(value) { this.permissionRequest = value; },
    setPermissionCheckHandler(value) { this.permissionCheck = value; },
    setDisplayMediaRequestHandler(value) { this.displayMedia = value; },
  };
  class MockWindow {
    constructor(options = {}) {
      this.options = options; this.destroyed = false; this.visible = false; this.focused = false; this.protected = false;
      this.bounds = { x: options.x ?? 0, y: options.y ?? 0, width: options.width ?? 1000, height: options.height ?? 760 };
      this.handlers = new Map(); this.events = []; this.calls = [];
      this.webContents = { mainFrame: { url: pathToFileURL(path.join(__dirname, 'index.html')).href }, session: browserSession,
        isDestroyed: () => this.destroyed, on() {}, setWindowOpenHandler: callback => { this.openHandler = callback; },
        send: (_, event) => { this.events.push(event); if (!events.some(previous => previous.seq === event.seq)) events.push(event); },
      };
      windows.push(this);
    }
    on(name, callback) { const callbacks = this.handlers.get(name) || []; callbacks.push(callback); this.handlers.set(name, callbacks); }
    emit(name, event) { for (const callback of this.handlers.get(name) || []) callback(event); }
    setContentProtection(value) { this.protected = value; this.calls.push('protect'); }
    isContentProtected() { return this.protected; }
    isDestroyed() { return this.destroyed; }
    isVisible() { return this.visible; }
    async loadURL(url) { this.calls.push('load'); this.webContents.mainFrame.url = url; if (url.endsWith('/content.html') && contentLoad) await contentLoad; }
    show() { this.calls.push('show'); this.visible = true; }
    showInactive() { this.calls.push('show-inactive'); this.visible = true; }
    hide() { this.visible = false; this.focused = false; }
    focus() { this.focused = true; }
    minimize() { this.visible = false; }
    getBounds() { return { ...this.bounds }; }
    setBounds(value) { Object.assign(this.bounds, value); this.emit('resize'); }
    setMinimumSize(width, height) { this.minimumSize = [width, height]; }
    close() { const event = { prevented: false, preventDefault() { this.prevented = true; } }; this.emit('close', event); if (!event.prevented) this.destroy(); }
    destroy() { if (this.destroyed) return; this.destroyed = true; this.visible = false; this.emit('closed'); }
  }
  const window = new MockWindow(); window.setContentProtection(true);
  const quit = () => {
    if (appState.quitting) return;
    appState.quitting = true; appState.quitCalls++;
    appEvents.get('before-quit')?.();
    for (const target of windows) target.destroy();
  };
  let profileDisk = savedConfig ? JSON.stringify(savedConfig) : null;
  const profileTemps = new Map();
  const mocks = {
    electron: {
      app: { getPath: () => path.join(__dirname, 'mock-user-data'), setPath() {}, setName() {}, whenReady: () => ({ then: () => ({ catch() {} }) }), on: (name, callback) => appEvents.set(name, callback), quit },
      BrowserWindow: MockWindow, Menu: { setApplicationMenu() {} },
      screen: { getPrimaryDisplay: () => ({ workArea }), getDisplayMatching: () => ({ workArea }) },
      desktopCapturer: { getSources: async () => [{ id: 'test-screen' }] },
      ipcMain: { handle: (name, fn) => handlers.set(name, fn), on: (name, fn) => listeners.set(name, fn) },
      safeStorage: { isEncryptionAvailable: () => true, encryptString: text => Buffer.from(text), decryptString: value => value.toString() },
      globalShortcut: { isRegistered: () => true, register: (name, callback) => hotkeys.set(name, callback), unregisterAll: () => hotkeys.clear() },
    },
    './provider-adapters.cjs': { streamProviderAnswer: options => {
      const gate = deferred();
      requests.push({ options, finish: () => gate.resolve({ text: 'A test explanation.', usage: {} }), fail: error => gate.reject(error), delta: text => options.onDelta(text) });
      if (!holdAnswers) gate.resolve({ text: 'A test explanation.', usage: {} });
      return gate.promise;
    },
    validateBaseUrl: require('./provider-adapters.cjs').validateBaseUrl,
    listProviderModels: async options => {
      catalogRequests.push(options);
      if (catalogImpl) return catalogImpl(options);
      const url = 'https://api.openai.com/v1/models';
      const request = { headers: { Authorization: `Bearer ${options.apiKey}` }, signal: options.signal, redirect: 'error' };
      fetches.push({ url, options: request });
      if (!fetchImpl) throw new Error('Unexpected model discovery.');
      const response = await fetchImpl(url, request);
      if (!response.ok) throw new Error('Discovery failed.');
      return (await response.json()).data.map(model => ({ slug: model.id }));
    } },
    './speech.cjs': { SpeechSession: class {
      constructor(options) { this.options = options; this.chunks = []; this.stops = 0; connections.push(this); }
      async start() {}
      stop() { this.stops++; this.options.onState('stopped'); }
      finalize() { this.finalizes = (this.finalizes || 0) + 1; return true; }
      sendAudio(chunk) { this.chunks.push(chunk); }
      transcript(text, extra = {}) { this.options.onTranscript({ source: this.options.source, text, isFinal: true, speechFinal: true, ...extra }); }
    } },
    './turns.cjs': require('./turns.cjs'),
    './audio-finality.cjs': require('./audio-finality.cjs'),
    './voice-fallback.cjs': require('./voice-fallback.cjs'),
    './profile.cjs': require('./profile.cjs'),
    './routing.cjs': require('./routing.cjs'),
    './oauth.cjs': oauth,
    'node:fs': {
      existsSync: () => false, mkdirSync() {},
      readFileSync() { if (profileDisk === null) throw Object.assign(new Error('Missing fixture'), {code:'ENOENT'}); return profileDisk; },
      writeFileSync(file, content) { profileTemps.set(file, content); writes.push(JSON.parse(content)); },
      renameSync(file) { profileDisk = profileTemps.get(file); profileTemps.delete(file); },
      unlinkSync(file) { profileTemps.delete(file); }
    },
    'node:crypto': require('node:crypto'), 'node:path': path, 'node:url': require('node:url'),
  };
  const context = vm.createContext({
    require: name => { if (!Object.hasOwn(mocks, name)) throw new Error(`Unmocked module denied: ${name}`); return mocks[name]; },
    process: { argv: [], env: {} }, __dirname, Buffer, URL, AbortController, AbortSignal,
    Date: class extends Date { static now() { return now; } },
    setTimeout: setTimer, clearTimeout: clearTimer, windowForTest: window,
    fetch: (url, options) => { fetches.push({ url, options }); if (!fetchImpl) throw new Error('Unexpected network request.'); return fetchImpl(url, options); },
  });
  vm.runInContext(source + `
    readConfig(); win = windowForTest; registerIPC();
    globalThis.probe = {
      initialize(hasAnswerKey) { secrets.deepgram = 'fake-speech-key'; secrets.openai = hasAnswerKey ? 'fake-answer-key' : ''; settings.answerProvider = 'openai'; },
      state() { return { live, sessionId, captureAllowed, activeSessionMode, questionSource, autoCount, answers,
        queuedAutomatic, answerQueue, pending: pendingBuffer?.snapshot(), voiceCommandStatus, requestController, history, settings, catalog: publicCatalog(), profile: chatgptProfile, speechSources: [...speech.keys()] }; },
      setProfile(profile, select) { chatgptProfile = profile; if (select) { settings.answerProvider = profile ? 'chatgpt' : 'openai'; settings.model = settings.providerModels[settings.answerProvider]; settings.fastModel = settings.providerFastModels[settings.answerProvider]; } },
      read() { readConfig(); },
      createRoot() { return createWindow(); },
      root() { return win; },
      popup() { return contentWin; },
      stop() { stopSession(); modelCatalogRequest?.controller.abort(); }
    };`, context, { filename: 'main.cjs' });
  context.probe.initialize(credentials);
  t.after(() => context.probe.stop());
  const senderFor = target => ({ sender: target.webContents, senderFrame: target.webContents.mainFrame });
  const invoke = (name, ...args) => handlers.get(name)(senderFor(context.probe.root()), ...args);
  return {
    invoke, events, writes, connections, requests, fetches, catalogRequests, windows, browserSession, appState, hotkeys,
    invokeContent: (name, ...args) => handlers.get(name)(senderFor(context.probe.popup()), ...args),
    invokeRaw: (name, event, ...args) => handlers.get(name)(event, ...args),
    createRoot: () => context.probe.createRoot(), root: () => context.probe.root(), popup: () => context.probe.popup(),
    state: () => context.probe.state(),
    setProfile: (profile, select = true) => context.probe.setProfile(profile, select),
    readConfig: () => context.probe.read(),
    emitAudio: (which, buffer = Buffer.from([0, 1, 2, 3])) => listeners.get('audio:chunk')(senderFor(context.probe.root()), which, buffer),
    emitContentAudio: (which, buffer = Buffer.from([0, 1, 2, 3])) => listeners.get('audio:chunk')(senderFor(context.probe.popup()), which, buffer),
    connection: which => connections.findLast(connection => connection.options.source === which),
    async start(mode = 'call', autoAnswer = true, microphone = false) {
      invoke('session:preferences', { sessionMode: mode, autoAnswer });
      return invoke('listen:start', { sampleRate: 16000, microphone });
    },
    async tick(milliseconds) {
      const end = now + milliseconds;
      for (;;) {
        const due = [...timers.entries()].filter(([, item]) => item.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        now = due[1].at; timers.delete(due[0]); due[1].callback(); await settle();
      }
      now = end; await settle();
    },
  };
}

test('Practice captures only the microphone and merges a paused prompt into one automatic answer', async t => {
  const h = harness(t);
  const started = await h.start('practice');
  assert.deepEqual([...started.sources], ['you']);
  assert.equal(h.state().captureAllowed, false);
  const microphone = h.connection('you');
  microphone.transcript('Can you explain me');
  await h.tick(2000);
  assert.equal(h.requests.length, 0);
  microphone.transcript('what are closures?');
  await h.tick(1600);
  assert.equal(h.requests.length, 1);
  assert.match(h.requests[0].options.question, /Can you explain me.*what are closures\?/i);
  assert.equal(h.state().history.length, 1);
  assert.equal(h.state().autoCount, 1);
  const transcript = h.events.filter(event => event.type === 'transcript' && event.isFinal);
  assert.equal(new Set(transcript.map(event => event.turnId)).size, 1);
  assert.equal(transcript.at(-1).pending, false);
});

test('Call mode uses the other speaker for questions even when the microphone is included', async t => {
  const h = harness(t);
  await h.start('call', true, true);
  assert.equal(h.state().captureAllowed, true);
  h.connection('you').transcript('What is a closure?');
  await h.tick(1700);
  assert.equal(h.requests.length, 0);
  assert.equal(h.events.some(event => event.type === 'question'), false);
  h.connection('remote').transcript('Explain a database index.');
  await h.tick(1700);
  assert.equal(h.requests.length, 1);
  assert.equal(h.requests[0].options.question, 'Explain a database index.');
  assert.match(h.requests[0].options.transcript, /You: What is a closure\?/);
});

test('three consecutive microphone questions each answer after the previous stream finishes without speech-final markers', async t => {
  const h = harness(t, { holdAnswers: true });
  await h.start('practice');
  const microphone = h.connection('you');
  const questions = ['What are closures?', 'What is a promise?', 'Explain the event loop.'];
  for (const [index, question] of questions.entries()) {
    const start = index * 3;
    microphone.transcript('', { isFinal: false, speechFinal: false, speechStarted: true, start, duration: 0 });
    microphone.transcript(question.slice(0, 10), { isFinal: false, speechFinal: false, start, duration: 0.5 });
    microphone.transcript(question, { speechFinal: false, start, duration: 1 });
    await h.tick(799);
    assert.equal(h.requests.length, index);
    await h.tick(1);
    assert.equal(h.requests.length, index + 1);
    assert.equal(h.requests[index].options.question, question);
    h.requests[index].delta(`Answer ${index + 1}.`);
    h.requests[index].finish(); await settle();
    assert.equal(h.state().requestController, null, 'Completed requests must release the next automatic turn');
    assert.equal(h.state().queuedAutomatic, null);
    assert.equal(h.state().settings.autoAnswer, true);
    // Replayed final packets from an already answered audio span do not reopen it.
    microphone.transcript(question, { speechFinal: true, start, duration: 1 });
    await h.tick(1000);
    assert.equal(h.requests.length, index + 1);
  }
  assert.equal(h.state().autoCount, 3);
  assert.equal(h.events.filter(event => event.type === 'answer-done').length, 3);
  assert.equal(new Set(h.events.filter(event => event.type === 'question').map(event => event.turnId)).size, 3);
  assert.match(h.requests[2].options.transcript, /Previous assistant suggestions/);
});

test('acknowledgments do not block intentional repeated questions or the next question', async t => {
  const h = harness(t); await h.start('practice'); const mic = h.connection('you');
  mic.transcript('Explain closures.', {start:0,duration:1}); await h.tick(800);
  mic.transcript('Thank you.', {start:2,duration:1}); await h.tick(800);
  mic.transcript('Explain closures.', {start:4,duration:1}); await h.tick(800);
  assert.equal(h.requests.length, 2, 'A distinct spoken repetition is an intentional request');
  mic.transcript('Explain closures.', {start:4,duration:1}); await h.tick(800);
  assert.equal(h.requests.length, 2, 'The same audio packet is still deduplicated');
  mic.transcript('Explain promises.', {start:6,duration:1}); await h.tick(800);
  assert.equal(h.requests.length, 3); assert.equal(h.requests[2].options.question, 'Explain promises.');
  assert.equal(h.state().settings.autoAnswer, true);
});

test('unexpected audio/transcript sources cannot create extra streams or questions', async t => {
  const h = harness(t);
  await h.start('practice');
  h.emitAudio('remote'); h.emitAudio('you');
  const mic = h.connection('you');
  mic.transcript('What is an index?', { source: 'remote' });
  await h.tick(1700);
  assert.equal(mic.chunks.length, 1);
  assert.equal(h.connections.length, 1);
  assert.equal(h.requests.length, 0);
  assert.equal(h.state().history.length, 0);
});

test('manual mode detects a full question but does not generate until requested', async t => {
  const h = harness(t);
  await h.start('practice', false);
  h.connection('you').transcript('What are closures?');
  await h.tick(1700);
  assert.equal(h.requests.length, 0);
  assert.equal(h.events.filter(event => event.type === 'question').at(-1).text, 'What are closures?');
  await h.invoke('answer:ask', {});
  assert.equal(h.requests.length, 1);
  assert.equal(h.state().autoCount, 0);
});

test('manually submitting a pending transcript prevents a duplicate automatic answer while allowing manual repeats', async t => {
  const h = harness(t);
  await h.start('practice');
  h.connection('you').transcript('What are closures?');
  await h.invoke('answer:ask', { question: '  what   are closures  ' });
  await h.tick(1700);
  assert.equal(h.requests.length, 1);
  assert.equal(h.state().autoCount, 0);
  await h.invoke('answer:ask', { question: 'What are closures?' });
  assert.equal(h.requests.length, 2);
  await h.tick(12000);
  h.connection('you').transcript('What are closures?'); await h.tick(1700);
  assert.equal(h.requests.length, 3);
  assert.equal(h.state().autoCount, 1);
});

test('automatic turns wait for a manual answer and preserve every independent queued question', async t => {
  const h = harness(t, { holdAnswers: true });
  await h.start('practice');
  const manual = h.invoke('answer:ask', { question: 'Explain a mutex.' });
  h.connection('you').transcript('What is a closure?'); await h.tick(1700);
  h.connection('you').transcript('Explain a queue.'); await h.tick(1700);
  assert.equal(h.requests.length, 1);
  assert.equal(h.requests[0].options.signal.aborted, false);
  assert.equal(h.state().autoCount, 0);
  h.requests[0].finish(); await manual; await settle();
  assert.equal(h.requests.length, 2);
  assert.equal(h.requests[1].options.question, 'What is a closure?');
  assert.equal(h.state().autoCount, 1);
  h.requests[1].finish(); await settle();
  assert.equal(h.requests.length, 3);
  assert.equal(h.requests[2].options.question, 'Explain a queue.');
  h.requests[2].finish(); await settle();
});

test('a new automatic turn does not interrupt an automatic answer already streaming', async t => {
  const h = harness(t, { holdAnswers: true });
  await h.start('practice');
  h.connection('you').transcript('Explain closures.'); await h.tick(1700);
  h.connection('you').transcript('What is a queue?'); await h.tick(1700);
  assert.equal(h.requests.length, 1);
  assert.equal(h.requests[0].options.signal.aborted, false);
  h.requests[0].finish(); await settle();
  assert.equal(h.requests.length, 2);
  assert.equal(h.state().autoCount, 2);
  h.requests[1].finish(); await settle();
});

test('turning Auto off while busy clears queued work without discarding the active answer', async t => {
  const h = harness(t, { holdAnswers: true });
  await h.start('practice');
  h.connection('you').transcript('Explain closures.'); await h.tick(1700);
  h.connection('you').transcript('Explain a queue.'); await h.tick(1700);
  h.invoke('session:preferences', { autoAnswer: false });
  assert.equal(h.state().queuedAutomatic, null);
  assert.equal(h.requests[0].options.signal.aborted, false);
  h.requests[0].finish(); await settle();
  assert.equal(h.requests.length, 1);
});

test('a manual question supersedes active work and drops the pending automatic question', async t => {
  const h = harness(t, { holdAnswers: true });
  await h.start('practice');
  h.connection('you').transcript('Explain closures.'); await h.tick(1700);
  h.connection('you').transcript('Explain a queue.'); await h.tick(1700);
  const manual = h.invoke('answer:ask', { question: 'Compare two sorting algorithms.' });
  assert.equal(h.requests.length, 2);
  assert.equal(h.requests[0].options.signal.aborted, true);
  assert.equal(h.state().queuedAutomatic, null);
  h.requests[0].finish(); h.requests[1].finish(); await manual; await settle();
  assert.equal(h.requests.length, 2);
  assert.equal(h.state().autoCount, 1);
});

test('the automatic cap is rechecked when queued work is dispatched', async t => {
  const h = harness(t, { holdAnswers: true });
  h.invoke('settings:save', { maxAutoAnswers: 1 });
  await h.start('practice');
  h.connection('you').transcript('Explain closures.'); await h.tick(1700);
  h.connection('you').transcript('Explain a queue.'); await h.tick(1700);
  assert.equal(h.state().autoCount, 1);
  h.requests[0].finish(); await settle();
  assert.equal(h.requests.length, 1);
  assert.equal(h.state().autoCount, 1);
  assert.equal(h.events.filter(event => event.type === 'notice' && /limit reached/.test(event.message || '')).length, 1);
});

test('missing answer credentials disable Auto visibly once and do not consume its cap', async t => {
  const h = harness(t, { credentials: false });
  await h.start('practice');
  h.connection('you').transcript('Explain closures.'); await h.tick(1700);
  h.connection('you').transcript('Explain a queue.'); await h.tick(1700);
  assert.equal(h.requests.length, 0);
  assert.equal(h.state().autoCount, 0);
  assert.equal(h.state().settings.autoAnswer, false);
  assert.equal(h.events.filter(event => /Automatic answers paused/.test(event.message || '')).length, 1);
  assert.equal(h.events.filter(event => event.type === 'session-preferences').at(-1).settings.autoAnswer, false);
  assert.equal(h.writes.at(-1).settings.autoAnswer, false);
});

test('a provider quota error pauses Auto and drops pending requests rather than retrying every question', async t => {
  const h = harness(t, { holdAnswers: true });
  await h.start('practice');
  h.connection('you').transcript('Explain closures.'); await h.tick(1700);
  h.connection('you').transcript('Explain a queue.'); await h.tick(1700);
  h.requests[0].fail(Object.assign(new Error('Usage limit reached.'), { status: 429 })); await settle();
  assert.equal(h.state().settings.autoAnswer, false);
  assert.equal(h.state().queuedAutomatic, null);
  assert.equal(h.requests.length, 1);
  assert.equal(h.state().autoCount, 1);
  assert.match(h.events.find(event => event.type === 'answer-error').message, /Usage limit/);
});

test('stop/start discards old turn deadlines, transcripts and stopped callbacks', async t => {
  const h = harness(t);
  await h.start('practice');
  const old = h.connection('you');
  old.transcript('Can you explain me');
  h.invoke('listen:stop');
  await h.start('call');
  old.transcript('What are closures?'); old.options.onState('stopped');
  await h.tick(7000);
  assert.equal(h.state().live, true);
  assert.equal(h.state().activeSessionMode, 'call');
  assert.equal(h.requests.length, 0);
  assert.equal(h.state().history.length, 0);
  h.connection('remote').transcript('Explain a stack.'); await h.tick(1700);
  assert.equal(h.requests.length, 1);
});

test('a transcription reconnect discards a pending prompt and preserves unique IDs for later turns', async t => {
  const h = harness(t);
  await h.start('practice');
  const mic = h.connection('you');
  mic.transcript('Explain closures.'); await h.tick(1700);
  mic.transcript('Can you explain me');
  mic.options.onState('reconnecting'); await h.tick(7000);
  assert.equal(h.requests.length, 1);
  mic.options.onState('listening');
  mic.transcript('Explain a queue.'); await h.tick(1700);
  assert.equal(h.requests.length, 2);
  assert.equal(h.requests[1].options.question, 'Explain a queue.');
  assert.equal(h.state().history.length, 3);
  assert.equal(new Set(h.state().history.map(turn => turn.turnId)).size, 3);
});

test('an old provider completion cannot dispatch queued work after a new session starts', async t => {
  const h = harness(t, { holdAnswers: true });
  await h.start('practice');
  h.connection('you').transcript('Explain closures.'); await h.tick(1700);
  h.connection('you').transcript('Explain a queue.'); await h.tick(1700);
  h.invoke('listen:stop'); await h.start('call');
  h.requests[0].finish(); await settle();
  assert.equal(h.requests[0].options.signal.aborted, true);
  assert.equal(h.requests.length, 1);
  assert.equal(h.state().autoCount, 0);
  assert.equal(h.events.some(event => event.type === 'answer-done'), false);
});

test('session preferences validate atomically; mode cannot change while listening', async t => {
  const h = harness(t);
  for (const value of [null, [], { sessionMode: 'invalid' }, { autoAnswer: 1 }, { model: 'wrong-route' }]) {
    assert.throws(() => h.invoke('session:preferences', value), /Invalid session/);
  }
  assert.equal(h.writes.length, 0);
  await h.start('practice', false);
  assert.throws(() => h.invoke('session:preferences', { sessionMode: 'call', autoAnswer: true }), /Stop listening/);
  assert.equal(h.state().settings.autoAnswer, false);
  assert.equal(h.state().settings.sessionMode, 'practice');
  h.invoke('session:preferences', { autoAnswer: true });
  assert.equal(h.state().settings.autoAnswer, true);
  h.invoke('listen:stop');
  assert.equal(h.invoke('settings:save', {}).sessionMode, 'practice');
  assert.equal(h.invoke('settings:save', { sessionMode: 'invalid' }).sessionMode, 'practice');
});

test('renderer cannot impersonate an automatic request to bypass manual handling', async t => {
  const h = harness(t);
  await h.start('practice');
  await h.invoke('answer:ask', { question: 'What is a closure?', automatic: true, candidate: {} });
  assert.equal(h.requests.length, 1);
  assert.equal(h.state().autoCount, 0);
  assert.equal(h.events.filter(event => event.type === 'answer-start').at(-1).automatic, false);
});

test('adaptive model preference defaults on and preserves the saved choice when missing or invalid', t => {
  const h = harness(t);
  assert.equal(h.invoke('settings:get').adaptiveModels, true);
  assert.equal(h.invoke('settings:save', { adaptiveModels: false }).adaptiveModels, false);
  assert.equal(h.invoke('settings:save', {}).adaptiveModels, false);
  assert.equal(h.invoke('settings:save', { adaptiveModels: 'true' }).adaptiveModels, false);
  assert.equal(h.invoke('settings:save', { adaptiveModels: true }).adaptiveModels, true);
});

test('API model discovery sanitizes, caches metadata for ten minutes and makes no inference request', async t => {
  const h = harness(t, { fetchImpl: async () => ({ ok: true, json: async () => ({ data: [
    { id: 'gpt-5.6-sol' }, { id: 'gpt-6-luna' }, { id: 'gpt-6-luna' }, { id: '<script>' }, { id: 'x'.repeat(151) }, { id: 4 },
  ] }) }) });
  const first = await h.invoke('models:refresh');
  assert.equal(first.status, 'ready');
  assert.deepEqual(Array.from(first.models, model => model.slug), ['gpt-5.6-sol', 'gpt-6-luna']);
  assert.equal(h.fetches[0].url, 'https://api.openai.com/v1/models');
  assert.equal(h.fetches[0].options.headers.Authorization, 'Bearer fake-answer-key');
  assert.equal(h.fetches[0].options.redirect, 'error');
  assert.equal(JSON.stringify(first).includes('fake-answer-key'), false);
  await h.invoke('models:refresh', { force: false });
  assert.equal(h.fetches.length, 1);
  await h.invoke('models:refresh', { force: true });
  assert.equal(h.fetches.length, 2);
  await h.tick(600001);
  assert.equal(h.fetches.length, 2);
  await h.invoke('models:refresh');
  assert.equal(h.fetches.length, 3);
  assert.equal(h.requests.length, 0);
});

test('routing uses only catalog-confirmed lighter models and retains the selected model for complex work', async t => {
  const h = harness(t, { fetchImpl: async () => ({ ok: true, json: async () => ({ data: [{ id: 'gpt-6-luna' }, { id: 'gpt-5.6-sol' }] }) }) });
  h.invoke('settings:save', { model: 'gpt-5.6-sol' });
  await h.invoke('models:refresh');
  await h.invoke('answer:ask', { question: 'What are closures?' });
  assert.equal(h.requests[0].options.model, 'gpt-6-luna');
  assert.equal(h.requests[0].options.reasoningEffort, 'none');
  assert.equal(h.requests[0].options.concise, true);
  assert.equal(h.events.filter(event => event.type === 'answer-start').at(-1).routeKind, 'quick');
  await h.invoke('answer:ask', { question: 'Design a distributed order system with idempotency and concurrent stock reservation.' });
  assert.equal(h.requests[1].options.model, 'gpt-5.6-sol');
  assert.equal(h.requests[1].options.concise, false);
  h.invoke('settings:save', { adaptiveModels: false });
  await h.invoke('answer:ask', { question: 'What is a closure?' });
  assert.equal(h.requests[2].options.model, 'gpt-5.6-sol');
  assert.equal(h.events.filter(event => event.type === 'answer-done').at(-1).routeKind, 'fixed');
});

test('model discovery never blocks an answer and failures retry only on an explicit refresh', async t => {
  const gate = deferred();
  const h = harness(t, { fetchImpl: () => gate.promise });
  h.invoke('settings:save', { model: 'gpt-5.6-sol' });
  const discovering = h.invoke('models:refresh');
  assert.equal(h.state().catalog.status, 'loading');
  await h.invoke('answer:ask', { question: 'What is a closure?' });
  assert.equal(h.requests.length, 1);
  assert.equal(h.requests[0].options.model, 'gpt-5.6-sol');
  assert.equal(h.requests[0].options.reasoningEffort, 'low');
  gate.reject(new Error('Network offline.')); await discovering;
  assert.equal(h.state().catalog.status, 'unavailable');
  await h.invoke('answer:ask', { question: 'What is a stack?' });
  assert.equal(h.requests.length, 2);
  assert.equal(h.fetches.length, 1);
  await h.invoke('models:refresh', { force: true });
  assert.equal(h.fetches.length, 2);
});

test('model discovery is bounded and request validation cannot change settings', async t => {
  const h = harness(t, { fetchImpl: (_url, options) => new Promise((_resolve, reject) => {
    options.signal.addEventListener('abort', () => reject(new Error('Timed out.')), { once: true });
  }) });
  for (const value of [null, [], { force: 'yes' }, { url: 'https://unexpected.test' }]) {
    assert.throws(() => h.invoke('models:refresh', value), /Invalid model refresh/);
  }
  const discovering = h.invoke('models:refresh');
  await h.tick(12000); await discovering;
  assert.equal(h.fetches[0].options.signal.aborted, true);
  assert.equal(h.state().catalog.status, 'unavailable');
  assert.equal(h.requests.length, 0);
  assert.equal(h.writes.length, 0);
});

test('changing an API key invalidates cached models and ignores the previous key discovery result', async t => {
  const old = deferred();
  const h = harness(t, { fetchImpl: (_url, options) => options.headers.Authorization === 'Bearer fake-answer-key'
    ? old.promise : Promise.resolve({ ok: true, json: async () => ({ data: [{ id: 'gpt-5.6-luna' }] }) }) });
  const discoveringOld = h.invoke('models:refresh');
  h.invoke('settings:save', { openai: 'fake-new-key' });
  assert.equal(h.fetches[0].options.signal.aborted, true);
  assert.equal(h.state().catalog.status, 'unavailable');
  await h.invoke('models:refresh');
  old.resolve({ ok: true, json: async () => ({ data: [{ id: 'gpt-6-luna' }] }) });
  await discoveringOld;
  assert.deepEqual(Array.from(h.state().catalog.models, model => model.slug), ['gpt-5.6-luna']);
  await h.invoke('answer:ask', { question: 'What are closures?' });
  assert.equal(h.requests[0].options.apiKey, 'fake-new-key');
  assert.equal(h.requests[0].options.model, 'gpt-5.6-luna');
  h.invoke('settings:save', { clearKeys: true });
  const empty = await h.invoke('models:refresh');
  assert.equal(empty.status, 'unavailable');
  assert.equal(empty.models.length, 0);
  assert.equal(h.fetches.length, 2);
});

test('answer timing separates turn settlement, first visible text and total generation', async t => {
  const h = harness(t, { holdAnswers: true });
  await h.start('practice');
  h.connection('you').transcript('What are closures?');
  await h.tick(800);
  const start = h.events.find(event => event.type === 'answer-start');
  assert.equal(start.settleMs, 800);
  assert.equal(start.queueWaitMs, 0);
  assert.equal(h.events.find(event => event.type === 'question').settleMs, 800);
  assert.equal(h.events.find(event => event.type === 'answer-phase').phase, 'waiting-first-text');
  await h.tick(350); h.requests[0].delta('  ');
  assert.equal(h.events.some(event => event.type === 'answer-timing'), false);
  await h.tick(100); h.requests[0].delta('A closure');
  await h.tick(200); h.requests[0].delta(' retains scope.'); h.requests[0].finish(); await settle();
  const timing = h.events.filter(event => event.type === 'answer-timing');
  assert.equal(timing.length, 1);
  assert.equal(timing[0].firstTextMs, 450);
  const done = h.events.find(event => event.type === 'answer-done');
  assert.equal(done.firstTextMs, 450);
  assert.equal(done.elapsedMs, 650);
  assert.equal(done.settleMs, 800);
  assert.equal(done.routeKind, 'quick');
  assert.equal(done.model, start.model);
});

test('queued answers report the wait separately and first-text latency includes authentication refresh', async t => {
  const refresh = deferred();
  const h = harness(t, { holdAnswers: true, oauth: { refreshProfile: () => refresh.promise } });
  h.setProfile({ can_call_api: true, issuer: 'test', client_id: 'client', subject: 'person', access_token: 'old', expires_at: 0 });
  const answer = h.invoke('answer:ask', { question: 'What is a closure?' });
  assert.equal(h.requests.length, 0);
  assert.equal(h.events.find(event => event.type === 'answer-phase').phase, 'refreshing-auth');
  await h.tick(200);
  refresh.resolve({ can_call_api: true, issuer: 'test', client_id: 'client', subject: 'person', access_token: 'rotated', expires_at: 3600000 }); await settle();
  assert.equal(h.requests[0].options.apiKey, 'rotated');
  assert.deepEqual(Array.from(h.events.filter(event => event.type === 'answer-phase'), event => event.phase), ['refreshing-auth', 'waiting-first-text']);
  await h.tick(300); h.requests[0].delta('A closure retains its lexical scope.');
  await h.tick(400); h.requests[0].finish(); await answer;
  assert.equal(h.events.find(event => event.type === 'answer-done').firstTextMs, 500);
  assert.equal(h.events.find(event => event.type === 'answer-done').elapsedMs, 900);
  h.setProfile(null);
  await h.start('practice');
  const manual = h.invoke('answer:ask', { question: 'Explain a mutex.' });
  await h.tick(100); h.connection('you').transcript('What is a queue?');
  await h.tick(800); await h.tick(600);
  h.requests[1].finish(); await manual; await settle();
  const queuedStart = h.events.filter(event => event.type === 'answer-start').at(-1);
  assert.equal(queuedStart.queueWaitMs, 600);
  assert.equal(queuedStart.settleMs, 800);
  h.requests[2].finish(); await settle();
});

test('selected provider receives only its own credential, model and provider identity', async t => {
  const h = harness(t);
  h.setProfile({ can_call_api: true, issuer: 'test', client_id: 'client', subject: 'person', access_token: 'plan-token', expires_at: 3600000 }, false);
  h.invoke('settings:save', { answerProvider: 'anthropic', anthropicKey: 'claude-test-key', geminiKey: 'gemini-test-key', model: 'claude-sonnet-5-5' });
  await h.invoke('answer:ask', { question: 'What is a closure?' });
  assert.equal(h.requests[0].options.provider, 'anthropic');
  assert.equal(h.requests[0].options.apiKey, 'claude-test-key');
  assert.equal(h.requests[0].options.model, 'claude-sonnet-5-5');
  assert.equal(h.requests[0].options.reasoningEffort, undefined);
  h.invoke('settings:save', { answerProvider: 'gemini' });
  await h.invoke('answer:ask', { question: 'What is a queue?' });
  assert.equal(h.requests[1].options.provider, 'gemini');
  assert.equal(h.requests[1].options.apiKey, 'gemini-test-key');
  assert.equal(h.requests[1].options.model, 'gemini-3.8-flash');
  h.invoke('settings:save', { answerProvider: 'openai' });
  await h.invoke('answer:ask', { question: 'What is a stack?' });
  assert.equal(h.requests[2].options.provider, 'openai');
  assert.equal(h.requests[2].options.apiKey, 'fake-answer-key');
  h.invoke('settings:save', { answerProvider: 'chatgpt' });
  await h.invoke('answer:ask', { question: 'What is a deque?' });
  assert.equal(h.requests[3].options.provider, 'chatgpt');
  assert.equal(h.requests[3].options.apiKey, 'plan-token');
});

test('an unconfigured selected provider never falls back to another saved key or account', async t => {
  const h = harness(t);
  h.setProfile({ can_call_api: true, issuer: 'test', client_id: 'client', subject: 'person', access_token: 'plan-token', expires_at: 3600000 }, false);
  const setup = h.invoke('settings:save', { answerProvider: 'anthropic' });
  assert.equal(setup.hasAnswerProvider, false);
  assert.equal(setup.hasOpenAI, true);
  assert.equal(setup.chatgptConnected, true);
  await assert.rejects(h.invoke('answer:ask', { question: 'What is a closure?' }), /Claude API key/);
  const catalog = await h.invoke('models:refresh');
  assert.equal(catalog.status, 'unavailable');
  assert.equal(h.catalogRequests.length, 0);
  assert.equal(h.requests.length, 0);
});

test('main and fast model selections are restored independently for each provider', t => {
  const h = harness(t);
  h.invoke('settings:save', { model: 'gpt-5.6-sol', fastModel: 'gpt-6-luna' });
  h.invoke('settings:save', { answerProvider: 'anthropic', model: 'claude-sonnet-5-5', fastModel: 'claude-haiku-4-5' });
  const openai = h.invoke('settings:save', { answerProvider: 'openai' });
  assert.equal(openai.model, 'gpt-5.6-sol');
  assert.equal(openai.fastModel, 'gpt-6-luna');
  assert.equal(openai.providerModels.anthropic, 'claude-sonnet-5-5');
  const claude = h.invoke('settings:save', { answerProvider: 'anthropic' });
  assert.equal(claude.model, 'claude-sonnet-5-5');
  assert.equal(claude.fastModel, 'claude-haiku-4-5');
});

test('provider validation is atomic and never saves credentials with invalid endpoint or model settings', t => {
  const h = harness(t);
  const before = h.invoke('settings:get');
  for (const invalid of [
    { answerProvider: 'other', anthropicKey: 'must-not-save' },
    { answerProvider: 'anthropic', model: 'bad model name', anthropicKey: 'must-not-save' },
    { fastModel: 'x'.repeat(151), geminiKey: 'must-not-save' },
    { answerProvider: 'compatible', compatibleBaseUrl: 'http://remote.example/v1', compatibleKey: 'must-not-save' },
    { compatibleBaseUrl: 'https://user:password@example.com/v1', compatibleKey: 'must-not-save' },
    { compatibleBaseUrl: 'https://example.com/v1?key=secret', compatibleKey: 'must-not-save' },
    { anthropicKey: 'one\ntwo' },
  ]) assert.throws(() => h.invoke('settings:save', invalid));
  assert.equal(h.writes.length, 0);
  assert.equal(h.invoke('settings:get').answerProvider, before.answerProvider);
  assert.equal(h.invoke('settings:get').hasAnthropic, false);
  assert.equal(h.invoke('settings:get').hasGemini, false);
  assert.equal(h.invoke('settings:get').hasCompatible, false);
});

test('each API credential is stored separately and only connection flags reach the renderer', t => {
  const h = harness(t);
  const setup = h.invoke('settings:save', { anthropicKey: 'claude-test-key', geminiKey: 'gemini-test-key', compatibleKey: 'custom-test-key' });
  const publicText = JSON.stringify(setup);
  for (const key of ['fake-answer-key', 'claude-test-key', 'gemini-test-key', 'custom-test-key']) assert.equal(publicText.includes(key), false);
  assert.equal(setup.hasAnthropic, true);
  assert.equal(setup.hasGemini, true);
  assert.equal(setup.hasCompatible, true);
  const saved = h.writes.at(-1);
  assert.equal(Buffer.from(saved.keys.anthropic, 'base64').toString(), 'claude-test-key');
  assert.equal(Buffer.from(saved.keys.gemini, 'base64').toString(), 'gemini-test-key');
  assert.equal(Buffer.from(saved.keys.compatible, 'base64').toString(), 'custom-test-key');
  const cleared = h.invoke('settings:save', { clearAnthropic: true, geminiKey: '' });
  assert.equal(cleared.hasAnthropic, false);
  assert.equal(cleared.hasGemini, true);
  assert.equal(cleared.hasOpenAI, true);
  assert.equal(h.writes.at(-1).keys.anthropic, undefined);
});

test('local compatible APIs may omit a key; remote compatible APIs require one and model IDs may contain slashes', async t => {
  const h = harness(t);
  let setup = h.invoke('settings:save', { answerProvider: 'compatible', compatibleBaseUrl: 'http://localhost:11434/v1/', model: 'org/local-model:latest' });
  assert.equal(setup.hasAnswerProvider, true);
  assert.equal(setup.hasCompatible, false);
  assert.equal(setup.compatibleBaseUrl, 'http://localhost:11434/v1');
  await h.invoke('answer:ask', { question: 'What is a closure?' });
  assert.equal(h.requests[0].options.provider, 'compatible');
  assert.equal(h.requests[0].options.apiKey, '');
  assert.equal(h.requests[0].options.baseUrl, 'http://localhost:11434/v1');
  assert.equal(h.requests[0].options.model, 'org/local-model:latest');
  setup = h.invoke('settings:save', { compatibleBaseUrl: 'https://api.example.com/v1' });
  assert.equal(setup.hasAnswerProvider, false);
  await assert.rejects(h.invoke('answer:ask', { question: 'What is a stack?' }), /base URL.*API key/);
  assert.equal(h.requests.length, 1);
  setup = h.invoke('settings:save', { compatibleKey: 'custom-key' });
  assert.equal(setup.hasAnswerProvider, true);
});

test('switching provider cancels old work and removes transcript and answer carryover', async t => {
  const h = harness(t, { holdAnswers: true });
  await h.start('practice', false);
  h.connection('you').transcript('What is a closure?'); await h.tick(1000); h.invoke('listen:stop');
  const old = h.invoke('answer:ask', { question: 'Explain a closure.' });
  h.requests[0].finish(); await old;
  const inflight = h.invoke('answer:ask', { question: 'Explain lexical scoping.' });
  assert.equal(h.state().history.length, 1);
  const next = h.invoke('settings:save', { answerProvider: 'anthropic', anthropicKey: 'claude-test-key' });
  assert.equal(next.providerChanged, true);
  assert.equal(h.requests[1].options.signal.aborted, true);
  assert.equal(h.state().history.length, 0);
  h.requests[1].finish(); await inflight;
  const current = h.invoke('answer:ask', { question: 'What is a queue?' });
  assert.equal(h.requests[2].options.transcript, '');
  assert.equal(h.requests[2].options.provider, 'anthropic');
  h.requests[2].finish(); await current;
});

test('catalog discovery uses selected credentials and ignores a previous provider result', async t => {
  const old = deferred();
  const h = harness(t, { catalogImpl: options => options.provider === 'openai' ? old.promise : Promise.resolve([{ slug: 'claude-haiku-4-5' }]) });
  const oldCatalog = h.invoke('models:refresh');
  h.invoke('settings:save', { answerProvider: 'anthropic', anthropicKey: 'claude-test-key' });
  const current = await h.invoke('models:refresh');
  old.resolve([{ slug: 'gpt-6-luna' }]); await oldCatalog;
  assert.equal(current.provider, 'anthropic');
  assert.equal(h.catalogRequests[0].provider, 'openai');
  assert.equal(h.catalogRequests[0].apiKey, 'fake-answer-key');
  assert.equal(h.catalogRequests[0].signal.aborted, true);
  assert.equal(h.catalogRequests[1].provider, 'anthropic');
  assert.equal(h.catalogRequests[1].apiKey, 'claude-test-key');
  assert.deepEqual(Array.from(h.state().catalog.models, model => model.slug), ['claude-haiku-4-5']);
  await h.invoke('answer:ask', { question: 'What is a closure?' });
  assert.equal(h.requests[0].options.provider, 'anthropic');
  assert.equal(h.requests[0].options.model, 'claude-haiku-4-5');
});

test('compatible model catalogs are scoped to endpoint and cannot route a model from an old server', async t => {
  const old = deferred();
  const h = harness(t, { catalogImpl: options => options.baseUrl.includes('11434') ? old.promise : Promise.resolve([{ slug: 'new/quick' }]) });
  h.invoke('settings:save', { answerProvider: 'compatible', compatibleBaseUrl: 'http://localhost:11434/v1', model: 'local/main', fastModel: 'old/quick' });
  const oldCatalog = h.invoke('models:refresh');
  h.invoke('settings:save', { compatibleBaseUrl: 'http://localhost:1234/v1', fastModel: 'new/quick' });
  await h.invoke('models:refresh');
  old.resolve([{ slug: 'old/quick' }]); await oldCatalog;
  await h.invoke('answer:ask', { question: 'What is a closure?' });
  assert.equal(h.requests[0].options.model, 'new/quick');
  assert.equal(h.requests[0].options.baseUrl, 'http://localhost:1234/v1');
});

test('legacy settings migrate to the existing answer credential and preserve the chosen model', t => {
  const h = harness(t, { credentials: false, savedConfig: {
    settings: { model: 'legacy-model', context: 'Known profile facts.' },
    keys: { openai: Buffer.from('saved-openai').toString('base64'), deepgram: Buffer.from('saved-speech').toString('base64') },
  } });
  h.readConfig();
  const setup = h.invoke('settings:get');
  assert.equal(setup.answerProvider, 'openai');
  assert.equal(setup.model, 'legacy-model');
  assert.equal(setup.providerModels.openai, 'legacy-model');
  assert.equal(setup.hasAnswerProvider, true);
  assert.equal(setup.context, 'Known profile facts.');
  assert.equal(setup.adaptiveModels, true);
});

test('legacy ChatGPT configuration remains on its connected plan, and new encrypted provider keys reload separately', t => {
  const h = harness(t, { credentials: false, savedConfig: {
    settings: { model: 'legacy-plan-model' },
    chatgpt: Buffer.from(JSON.stringify({ can_call_api: true, issuer: 'test', client_id: 'client', subject: 'person', access_token: 'plan-token', expires_at: 3600000 })).toString('base64'),
    keys: { openai: Buffer.from('saved-openai').toString('base64'), anthropic: Buffer.from('saved-claude').toString('base64'), gemini: Buffer.from('saved-gemini').toString('base64'), compatible: Buffer.from('saved-custom').toString('base64') },
  } });
  h.readConfig();
  const setup = h.invoke('settings:get');
  assert.equal(setup.answerProvider, 'chatgpt');
  assert.equal(setup.model, 'legacy-plan-model');
  assert.equal(setup.hasAnswerProvider, true);
  assert.equal(setup.hasAnthropic, true);
  assert.equal(setup.hasGemini, true);
  assert.equal(setup.hasCompatible, true);
  assert.equal(JSON.stringify(setup).includes('saved-claude'), false);
});

test('changing a model while an answer streams emits an explicit cancelled transition', async t => {
  const h = harness(t, { holdAnswers: true });
  const old = h.invoke('answer:ask', { question: 'What is a closure?' });
  h.invoke('settings:save', { model: 'gpt-6-luna' });
  assert.equal(h.requests[0].options.signal.aborted, true);
  assert.equal(h.events.filter(event => event.type === 'answer-cancelled').length, 1);
  h.requests[0].delta('Stale text'); h.requests[0].finish(); await old;
  assert.equal(h.events.some(event => event.type === 'answer-done'), false);
  assert.equal(h.events.some(event => event.type === 'answer-delta'), false);
});

test('all supported loopback hosts allow a local model without a credential', async t => {
  const h = harness(t);
  for (const host of ['127.0.0.2', '[::1]']) {
    const base = `http://${host}:11434/v1`;
    const setup = h.invoke('settings:save', { answerProvider: 'compatible', compatibleBaseUrl: base, model: 'local-model' });
    assert.equal(setup.hasAnswerProvider, true);
    await h.invoke('answer:ask', { question: 'What is a closure?' });
    assert.equal(h.requests.at(-1).options.apiKey, '');
    assert.equal(h.requests.at(-1).options.baseUrl, base);
  }
});

test('changing a compatible endpoint clears conversation context before sending to the new server', async t => {
  const h = harness(t);
  h.invoke('settings:save', { answerProvider: 'compatible', compatibleBaseUrl: 'https://first.example/v1', compatibleKey: 'custom-key', model: 'custom/main' });
  await h.start('practice', false);
  h.connection('you').transcript('Explain a private scenario.'); await h.tick(1000); h.invoke('listen:stop');
  await h.invoke('answer:ask', { question: 'Explain a private scenario.' });
  const next = h.invoke('settings:save', { compatibleBaseUrl: 'https://second.example/v1' });
  assert.equal(next.providerChanged, false);
  assert.equal(next.conversationReset, true);
  assert.equal(h.state().history.length, 0);
  await h.invoke('answer:ask', { question: 'What is a queue?' });
  assert.equal(h.requests[1].options.baseUrl, 'https://second.example/v1');
  assert.equal(h.requests[1].options.transcript, '');
});

test('timing settings have bounded defaults, preserve omitted values and reject invalid numbers atomically', t => {
  const h = harness(t);
  const defaults = h.invoke('settings:get');
  assert.equal(defaults.questionPauseMs, 800);
  assert.equal(defaults.incompletePauseMs, 6500);
  assert.equal(defaults.answerTimeoutMs, 75000);
  const minimum = h.invoke('settings:save', { questionPauseMs: 0, incompletePauseMs: 0, answerTimeoutMs: 0 });
  assert.equal(minimum.questionPauseMs, 400);
  assert.equal(minimum.incompletePauseMs, 2000);
  assert.equal(minimum.answerTimeoutMs, 20000);
  const upper = h.invoke('settings:save', { questionPauseMs: 9999, incompletePauseMs: 99999, answerTimeoutMs: 999999 });
  assert.equal(upper.questionPauseMs, 2500);
  assert.equal(upper.incompletePauseMs, 10000);
  assert.equal(upper.answerTimeoutMs, 120000);
  const kept = h.invoke('settings:save', {});
  assert.equal(kept.questionPauseMs, 2500);
  assert.equal(kept.incompletePauseMs, 10000);
  assert.equal(kept.answerTimeoutMs, 120000);
  const writes = h.writes.length;
  for (const invalid of [NaN, Infinity, -Infinity, '800', null]) assert.throws(() => h.invoke('settings:save', { questionPauseMs: invalid, anthropicKey: 'must-not-save' }), /finite numbers/);
  assert.equal(h.writes.length, writes);
  assert.equal(h.invoke('settings:get').hasAnthropic, false);
  const consistent = h.invoke('settings:save', { questionPauseMs: 2400, incompletePauseMs: 2000 });
  assert.equal(consistent.incompletePauseMs, 2500);
});

test('configured pause and incomplete-prefix waits are used by the active turn assembler', async t => {
  const h = harness(t);
  h.invoke('settings:save', { questionPauseMs: 1200, incompletePauseMs: 4500 });
  await h.start('practice');
  h.connection('you').transcript('Can you explain me');
  await h.tick(3000);
  assert.equal(h.requests.length, 0);
  h.connection('you').transcript('what are closures?');
  await h.tick(1199); assert.equal(h.requests.length, 0);
  await h.tick(1); assert.equal(h.requests.length, 1);
  assert.equal(h.events.find(event => event.type === 'answer-start').settleMs, 1200);
  assert.throws(() => h.invoke('settings:save', { questionPauseMs: 400 }), /Stop listening/);
  h.invoke('listen:stop'); await h.start('practice');
  h.connection('you').transcript('Can you explain me');
  await h.tick(4499);
  assert.equal(h.events.filter(event => event.type === 'transcript' && event.isFinal).at(-1).pending, true);
  await h.tick(1);
  assert.equal(h.events.filter(event => event.type === 'transcript' && event.isFinal).at(-1).pending, false);
  assert.equal(h.requests.length, 1);
});

test('answer timeout is captured at acceptance and is not extended by a later setup edit', async t => {
  const h = harness(t, { holdAnswers: true });
  h.invoke('settings:save', { answerTimeoutMs: 20000 });
  const answer = h.invoke('answer:ask', { question: 'What is a closure?' });
  h.invoke('settings:save', { answerTimeoutMs: 120000 });
  await h.tick(19999); assert.equal(h.requests[0].options.signal.aborted, false);
  await h.tick(1); assert.equal(h.requests[0].options.signal.aborted, true);
  h.requests[0].fail(Object.assign(new Error('Aborted.'), { name: 'AbortError' })); await answer;
  assert.match(h.events.find(event => event.type === 'answer-error').message, /timed out/);
});

test('legacy missing or invalid saved timings migrate to safe defaults', t => {
  const h = harness(t, { savedConfig: { settings: { questionPauseMs: 'bad', incompletePauseMs: null } } });
  h.readConfig();
  const setup = h.invoke('settings:get');
  assert.equal(setup.questionPauseMs, 800);
  assert.equal(setup.incompletePauseMs, 6500);
  assert.equal(setup.answerTimeoutMs, 75000);
});

test('streamed quota errors pause automatic answers while generic network failures remain retryable', async t => {
  const h = harness(t, { holdAnswers: true });
  await h.start('practice');
  h.connection('you').transcript('Explain closures.'); await h.tick(1000);
  h.requests[0].fail(Object.assign(new Error('A temporary network problem.'), { code: 'NETWORK_ERROR' })); await settle();
  assert.equal(h.state().settings.autoAnswer, true);
  h.connection('you').transcript('Explain a queue.'); await h.tick(1000);
  h.requests[1].fail(Object.assign(new Error('Plan usage limit reached.'), { code: 'subscription_sharing_usage_limit_exceeded' })); await settle();
  assert.equal(h.state().settings.autoAnswer, false);
  assert.equal(h.events.filter(event => /Automatic answers paused/.test(event.message || '')).length, 1);
});

test('configuration and content are separate protected resizable windows with different stacking rules', async t => {
  const h = harness(t);
  await h.createRoot();
  const configuration = h.root();
  assert.equal(configuration.options.transparent, false);
  assert.equal(configuration.options.alwaysOnTop, false);
  assert.equal(configuration.options.skipTaskbar, false);
  assert.equal(configuration.options.resizable, true);
  assert.equal(configuration.options.width, 1000);
  assert.equal(configuration.options.minWidth, 780);
  assert.equal(configuration.options.minHeight, 600);
  assert.ok(configuration.calls.indexOf('protect') < configuration.calls.indexOf('load'));
  assert.equal(configuration.options.webPreferences.backgroundThrottling, false);
  assert.equal(h.popup(), null);
  await h.invoke('window:show-content', { hideConfig: true });
  const popup = h.popup();
  assert.notEqual(popup, configuration);
  assert.equal(popup.webContents.mainFrame.url.endsWith('/content.html'), true);
  assert.equal(popup.options.transparent, true);
  assert.equal(popup.options.alwaysOnTop, true);
  assert.equal(popup.options.skipTaskbar, true);
  assert.equal(popup.options.resizable, true);
  assert.equal(popup.options.width, 740);
  assert.equal(popup.options.minWidth, 520);
  assert.equal(popup.options.minHeight, 420);
  assert.ok(popup.calls.indexOf('protect') < popup.calls.indexOf('load'));
  assert.ok(popup.calls.indexOf('protect') < popup.calls.indexOf('show'));
  assert.equal(popup.options.webPreferences.contextIsolation, true);
  assert.equal(popup.options.webPreferences.nodeIntegration, false);
  assert.equal(popup.options.webPreferences.sandbox, true);
  assert.equal(configuration.isVisible(), false);
  assert.equal(configuration.isDestroyed(), false);
  assert.equal(popup.isVisible(), true);
});

test('content IPC accepts only its own page and explicit non-secret capabilities', async t => {
  const h = harness(t);
  await h.createRoot(); await h.invoke('window:show-content');
  const popup = h.popup();
  assert.equal(h.invokeContent('settings:get').hasOpenAI, true);
  assert.equal(h.invokeContent('content:state').answer.state, 'idle');
  for (const method of ['settings:save', 'models:refresh', 'auth:connect', 'auth:disconnect', 'listen:start', 'session:preferences', 'capture:failed']) {
    assert.throws(() => h.invokeContent(method, {}), /Invalid app request/);
  }
  assert.throws(() => h.invokeRaw('content:state', { sender: popup.webContents, senderFrame: { url: pathToFileURL(path.join(__dirname, 'index.html')).href } }), /Invalid app request/);
  assert.throws(() => h.invokeRaw('content:state', { sender: h.root().webContents, senderFrame: { url: pathToFileURL(path.join(__dirname, 'content.html')).href } }), /Invalid app request/);
  assert.throws(() => h.invokeRaw('content:state', { sender: {}, senderFrame: popup.webContents.mainFrame }), /Invalid app request/);
  await h.start('practice', false);
  h.emitContentAudio('you');
  assert.equal(h.connection('you').chunks.length, 0);
  assert.equal(h.requests.length, 0);
  assert.equal(h.writes.some(write => JSON.stringify(write.settings).includes('fake-answer-key')), false);
});

test('only the configuration main frame receives microphone and display-capture permissions', async t => {
  const h = harness(t);
  await h.createRoot(); await h.invoke('window:show-content');
  const configuration = h.root(), popup = h.popup(), ses = h.browserSession;
  assert.equal(ses.permissionCheck(configuration.webContents, 'media'), true);
  assert.equal(ses.permissionCheck(popup.webContents, 'media'), false);
  assert.equal(ses.permissionCheck(configuration.webContents, 'notifications'), false);
  let permitted;
  ses.permissionRequest(configuration.webContents, 'media', value => { permitted = value; }, { requestingUrl: 'file:///another-app.html' });
  assert.equal(permitted, false);
  ses.permissionRequest(configuration.webContents, 'media', value => { permitted = value; }, { requestingUrl: configuration.webContents.mainFrame.url });
  assert.equal(permitted, true);
  await h.start('call', false);
  let captured;
  await ses.displayMedia({ frame: popup.webContents.mainFrame }, value => { captured = value; });
  assert.equal(Object.keys(captured).length, 0);
  await ses.displayMedia({ frame: { url: configuration.webContents.mainFrame.url } }, value => { captured = value; });
  assert.equal(Object.keys(captured).length, 0);
  await ses.displayMedia({ frame: configuration.webContents.mainFrame }, value => { captured = value; });
  assert.equal(captured.audio, 'loopback');
});

test('back to configuration and hide preserve live audio; closing content stops it before returning', async t => {
  const h = harness(t, { holdAnswers: true });
  await h.createRoot(); await h.start('practice', false); await h.invoke('window:show-content', { hideConfig: true });
  const mic = h.connection('you');
  h.invokeContent('window:hide-content');
  assert.equal(h.state().live, true);
  assert.equal(mic.stops, 0);
  await h.invoke('window:show-content', { hideConfig: true });
  h.invokeContent('window:show-config');
  assert.equal(h.state().live, true);
  assert.equal(h.root().isVisible(), true);
  assert.equal(h.popup().isVisible(), false);
  h.emitAudio('you'); assert.equal(mic.chunks.length, 1);
  await h.invoke('window:show-content', { hideConfig: true });
  const answer = h.invokeContent('answer:ask', { question: 'What is a closure?' });
  h.requests[0].delta('A closure retains');
  h.invokeContent('window:content-close');
  assert.equal(h.state().live, false);
  assert.equal(mic.stops, 1);
  assert.equal(h.requests[0].options.signal.aborted, true);
  assert.equal(h.root().isVisible(), true);
  assert.equal(h.popup().isVisible(), false);
  assert.equal(h.popup().isDestroyed(), false);
  assert.equal(h.appState.quitCalls, 0);
  const snapshot = h.invoke('content:state');
  assert.equal(snapshot.answer.state, 'cancelled');
  assert.equal(snapshot.answer.text, 'A closure retains');
  assert.equal(snapshot.sources.you, 'off');
  h.requests[0].finish(); await answer;
});

test('native content close stops listening while native configuration close quits both windows', async t => {
  const h = harness(t);
  await h.createRoot(); await h.start('practice', false); await h.invoke('window:show-content', { hideConfig: true });
  const popup = h.popup();
  popup.close();
  assert.equal(h.state().live, false);
  assert.equal(popup.isDestroyed(), false);
  assert.equal(h.root().isVisible(), true);
  await h.start('practice', false); await h.invoke('window:show-content', { hideConfig: true });
  const configuration = h.root(); configuration.close();
  assert.equal(h.state().live, false);
  assert.equal(configuration.isDestroyed(), true);
  assert.equal(popup.isDestroyed(), true);
  assert.equal(h.appState.quitCalls, 1);
});

test('popup snapshot carries complete answer lifecycle with sequenced events and does not relabel it with the next question', async t => {
  const h = harness(t, { holdAnswers: true });
  await h.createRoot(); await h.start('practice', false); await h.invoke('window:show-content');
  const answer = h.invokeContent('answer:ask', { question: 'What is a closure?' });
  h.requests[0].delta('A closure');
  const initial = h.invokeContent('content:state');
  assert.equal(initial.answer.state, 'generating');
  assert.equal(initial.answer.question, 'What is a closure?');
  assert.equal(initial.answer.text, 'A closure');
  assert.equal(initial.live, true);
  h.requests[0].delta(' retains scope.');
  const later = h.popup().events.filter(event => event.seq > initial.seq);
  assert.equal(later.find(event => event.type === 'answer-delta').text, ' retains scope.');
  h.connection('you').transcript('What is a queue?'); await h.tick(800);
  const nextQuestion = h.invokeContent('content:state');
  assert.equal(nextQuestion.question, 'What is a queue?');
  assert.equal(nextQuestion.answer.question, 'What is a closure?');
  assert.equal(nextQuestion.answer.text, 'A closure retains scope.');
  h.requests[0].finish(); await answer;
  const done = h.invokeContent('content:state');
  assert.equal(done.answer.state, 'done');
  assert.equal(done.answer.text, 'A closure retains scope.');
  assert.equal(done.answer.model, h.requests[0].options.model);
  assert.equal(JSON.stringify(done).includes('fake-answer-key'), false);
  const sequences = h.events.map(event => event.seq);
  assert.ok(sequences.every((seq, index) => index === 0 || seq > sequences[index - 1]));
  assert.deepEqual(h.popup().events.map(event => event.seq), h.root().events.filter(event => event.seq >= h.popup().events[0].seq).map(event => event.seq));
  h.invokeContent('listen:stop'); h.invokeContent('session:clear');
  const cleared = h.invokeContent('content:state');
  assert.equal(cleared.answer.state, 'idle');
  assert.equal(cleared.answer.text, '');
  assert.equal(cleared.question, '');
  assert.equal(cleared.answers, 0);
});

test('pending popup creation is shared and cannot hide configuration after the user has returned to it', async t => {
  const loading = deferred();
  const h = harness(t, { contentLoad: loading.promise });
  await h.createRoot();
  const first = h.invoke('window:show-content', { hideConfig: true });
  const second = h.invoke('window:show-content', { hideConfig: true });
  const popup = h.popup();
  assert.equal(h.windows.filter(target => target.options.transparent === true).length, 1);
  h.invoke('window:show-config');
  loading.resolve();
  assert.equal((await first).ok, false);
  assert.equal((await second).ok, false);
  assert.equal(h.root().isVisible(), true);
  assert.equal(popup.isVisible(), false);
  await h.invoke('window:show-content', { hideConfig: true });
  assert.equal(h.popup(), popup);
  assert.equal(popup.isVisible(), true);
});

test('window bounds and minimum sizes fit a small display and hotkey targets the popup', async t => {
  const h = harness(t, { workArea: { x: 20, y: 30, width: 600, height: 500 } });
  await h.createRoot();
  assert.equal(h.root().options.width, 600);
  assert.equal(h.root().options.minWidth, 600);
  assert.equal(h.root().options.minHeight, 500);
  await h.invoke('window:show-content');
  const popup = h.popup();
  popup.setBounds({ x: -100, y: -100, width: 1200, height: 1000 });
  assert.deepEqual(popup.getBounds(), { x: 20, y: 30, width: 600, height: 500 });
  assert.deepEqual(popup.minimumSize, [520, 420]);
  h.hotkeys.get('CommandOrControl+Shift+H')();
  assert.equal(popup.isVisible(), false);
  assert.equal(h.root().isVisible(), true);
  h.hotkeys.get('CommandOrControl+Shift+H')();
  assert.equal(popup.isVisible(), true);
});

test('appearance changes from content persist and broadcast to both windows without accepting other setup writes', async t => {
  const h = harness(t);
  await h.createRoot(); await h.invoke('window:show-content');
  assert.equal(h.invokeContent('settings:get').backgroundOpacity, 92);
  assert.equal(h.invokeContent('settings:get').answerFontSize, 20);
  assert.equal(h.invokeContent('appearance:text-size', 40), 26);
  assert.equal(h.invokeContent('appearance:text-size', 10), 16);
  assert.equal(h.invokeContent('appearance:set', 100), 100);
  const rootChanged = h.root().events.filter(event => event.type === 'settings-changed').at(-1);
  const popupChanged = h.popup().events.filter(event => event.type === 'settings-changed').at(-1);
  assert.equal(rootChanged.seq, popupChanged.seq);
  assert.equal(popupChanged.settings.backgroundOpacity, 100);
  assert.equal(popupChanged.settings.answerFontSize, 16);
  assert.equal(h.writes.at(-1).settings.answerFontSize, 16);
  assert.equal(h.invokeContent('content:state').settings.answerFontSize, 16);
});

test('role details remain labeled reference material and preserve plain context when no role is provided', async t => {
  const h = harness(t);
  h.invoke('settings:save', { context: 'Confirmed candidate facts.' });
  await h.invoke('answer:ask', { question: 'What is a closure?' });
  assert.equal(h.requests[0].options.context, 'Confirmed candidate facts.');
  h.invoke('settings:save', { roleTitle: 'Backend engineer', roleDescription: 'Requires distributed systems experience.' });
  await h.invoke('answer:ask', { question: 'What is a queue?' });
  assert.deepEqual(JSON.parse(h.requests[1].options.context), { candidateSummary: 'Confirmed candidate facts.', roleTitle: 'Backend engineer', roleDescription: 'Requires distributed systems experience.' });
  const bounded = h.invoke('settings:save', { roleTitle: 't'.repeat(210), roleDescription: 'd'.repeat(8100) });
  assert.equal(bounded.roleTitle.length, 200);
  assert.equal(bounded.roleDescription.length, 8000);
  assert.equal(h.writes.at(-1).settings.roleTitle.length, 200);
});

test('existing appearance values survive migration while new role and text settings receive defaults', t => {
  const h = harness(t, { savedConfig: { settings: { backgroundOpacity: 65 } } });
  h.readConfig();
  const current = h.invoke('settings:get');
  assert.equal(current.backgroundOpacity, 65);
  assert.equal(current.answerFontSize, 20);
  assert.equal(current.roleTitle, '');
  assert.equal(current.roleDescription, '');
});

test('explicit content resize validates input, clamps to display bounds and preserves live capture and answer state', async t => {
  const h = harness(t, { holdAnswers: true });
  await h.createRoot(); await h.start('practice', false); await h.invoke('window:show-content');
  const mic = h.connection('you');
  const answer = h.invokeContent('answer:ask', { question: 'What is a closure?' });
  h.requests[0].delta('A closure retains scope.');
  const before = h.invokeContent('content:state');
  for (const invalid of [null, [], {}, { width: 100 }, { width: NaN, height: 400 }, { width: Infinity, height: 400 }, { width: '800', height: 400 }, { width: 800, height: 600, x: 0 }]) {
    assert.throws(() => h.invokeContent('window:resize-content', invalid), /finite width and height/);
  }
  const minimum = h.invokeContent('window:resize-content', { width: 1, height: -1 });
  assert.equal(minimum.width, 520); assert.equal(minimum.height, 420);
  const maximum = h.invokeContent('window:resize-content', { width: 9999, height: 9999 });
  assert.equal(maximum.width, 1440); assert.equal(maximum.height, 900);
  const bounds = h.popup().getBounds();
  assert.equal(bounds.x, 0); assert.equal(bounds.y, 0);
  const after = h.invokeContent('content:state');
  assert.equal(after.seq, before.seq);
  assert.equal(after.answer.id, before.answer.id);
  assert.equal(after.answer.text, before.answer.text);
  assert.equal(h.state().live, true);
  assert.equal(mic.stops, 0);
  assert.equal(h.requests[0].options.signal.aborted, false);
  h.emitAudio('you'); assert.equal(mic.chunks.length, 1);
  h.requests[0].finish(); await answer;
});

test('answer hotkey creates the popup once and sends its action only after the page loads', async t => {
  const loading = deferred();
  const h = harness(t, { contentLoad: loading.promise });
  await h.createRoot();
  const first = h.hotkeys.get('CommandOrControl+Shift+Space')();
  const repeat = h.hotkeys.get('CommandOrControl+Shift+Space')();
  assert.equal(h.windows.filter(window => window.options.transparent === true).length, 1);
  assert.equal(h.events.some(event => event.type === 'hotkey-answer'), false);
  loading.resolve(); await first; await repeat;
  assert.equal(h.popup().isVisible(), true);
  assert.equal(h.popup().events.filter(event => event.type === 'hotkey-answer').length, 1);
  assert.equal(h.requests.length, 0);
});

test('new sessions and provider destinations reset the answer count shown by snapshots', async t => {
  const h = harness(t);
  await h.invoke('answer:ask', { question: 'What is a closure?' });
  assert.equal(h.invoke('content:state').answers, 1);
  await h.start('practice', false);
  assert.equal(h.invoke('content:state').answers, 0);
  h.invoke('listen:stop');
  await h.invoke('answer:ask', { question: 'What is a queue?' });
  assert.equal(h.invoke('content:state').answers, 1);
  h.invoke('settings:save', { answerProvider: 'anthropic' });
  assert.equal(h.invoke('content:state').answers, 0);
});

test('F01 voice fallback submits a retained non-interrogative task with Auto off and strips the cue', async t => {
  const h = harness(t); enableVoice(h); await h.start('call', false);
  const remote = h.connection('remote'), mic = h.connection('you');
  remote.transcript('An array with positive and negative numbers, target K, longest contiguous matching sum length.');
  await h.tick(1000); assert.equal(h.requests.length, 0);
  mic.transcript('Give me a minute to think.'); await settle();
  assert.equal(h.requests.length, 1);
  assert.match(h.requests[0].options.question, /negative numbers.*contiguous/);
  assert.doesNotMatch(h.requests[0].options.transcript, /Give me a minute/);
  assert.equal(h.events.find(e => e.type === 'answer-start').trigger, 'voice');
  assert.equal(h.state().autoCount, 1);
  assert.equal(h.state().voiceCommandStatus.status, 'submitted');
});

test('F02 finalization waits for unresolved question text and submits only after its final arrives', async t => {
  const h = harness(t); enableVoice(h); await h.start('call', false);
  const remote = h.connection('remote');
  remote.transcript('Given an array.', {start:0,duration:1});
  remote.transcript('Return the longest subarray', {isFinal:false,start:2,duration:1});
  h.connection('you').transcript('Give me a minute to think.'); await settle();
  assert.equal(remote.finalizes, 1); assert.equal(h.requests.length, 0);
  await h.tick(1000);
  remote.transcript('Return the longest subarray summing to K.', {start:2,duration:2}); await settle();
  assert.equal(h.requests.length, 1);
  assert.match(h.requests[0].options.question, /Given an array.*Return the longest subarray summing to K/);
});

test('F02 missing final expires without a partial paid request and recovers on the next question', async t => {
  const h = harness(t); enableVoice(h); await h.start('call', false);
  h.connection('remote').transcript('What is', {isFinal:false,start:0,duration:1});
  h.connection('you').transcript('Give me a minute to think.'); await settle();
  await h.tick(1500);
  assert.equal(h.requests.length, 0);
  assert.match(h.state().voiceCommandStatus.message, /incomplete/);
  await h.tick(6500);
  h.connection('remote').transcript('What are closures?', {start:0,duration:3});
  h.connection('you').transcript('Give me a minute to think.'); await settle();
  assert.equal(h.requests.length, 1);
});

test('F03 split command finals and duplicate packets create one request in Mic practice', async t => {
  const h = harness(t); enableVoice(h); await h.start('practice', false);
  const mic = h.connection('you');
  mic.transcript('What are closures?', {start:0,duration:1});
  mic.transcript('Give me a', {start:2,duration:1}); await h.tick(500);
  assert.equal(h.requests.length, 0);
  mic.transcript('minute to think.', {start:3,duration:1}); await settle();
  assert.equal(h.requests.length, 1);
  assert.equal(h.requests[0].options.question, 'What are closures?');
  mic.transcript('minute to think.', {start:3,duration:1}); await h.tick(7000);
  assert.equal(h.requests.length, 1);
  assert.doesNotMatch(h.requests[0].options.transcript, /minute to think|Give me a/);
});

test('F04 simultaneous automatic completion and spoken submission deduplicate by question identity', async t => {
  const h = harness(t, {holdAnswers:true}); enableVoice(h); await h.start('call');
  h.connection('remote').transcript('Explain closures.');
  await h.tick(800);
  h.connection('you').transcript('Gimme a minute to think.'); await settle();
  assert.equal(h.requests.length, 1);
  assert.equal(h.requests[0].options.signal.aborted, false);
  assert.match(h.state().voiceCommandStatus.message, /already/);
  h.requests[0].finish(); await settle();
});

test('F05 repeated voice cues do not restart an answer, including after cooldown', async t => {
  const h = harness(t, {holdAnswers:true}); enableVoice(h); await h.start('call', false);
  h.connection('remote').transcript('Explain closures.');
  const mic = h.connection('you'); mic.transcript('Give me a minute to think.'); await settle();
  mic.transcript('Give me a minute to think.'); await settle(); await h.tick(3100);
  mic.transcript('Give me a minute to think.'); await settle();
  assert.equal(h.requests.length, 1); assert.equal(h.requests[0].options.signal.aborted, false);
  h.requests[0].finish(); await settle();
});

test('F06 incoming audio cannot issue a voice command and command-only mic speech is excluded from context', async t => {
  const h = harness(t); enableVoice(h); await h.start('call', false);
  h.connection('remote').transcript('Explain promises.');
  h.connection('you').transcript('Private ordinary candidate speech.');
  h.connection('remote').transcript('Give me a minute to think.'); await h.tick(1000);
  assert.equal(h.requests.length, 0);
  h.connection('you').transcript('Let me think through this for a moment.'); await settle();
  assert.equal(h.requests.length, 1);
  assert.doesNotMatch(h.requests[0].options.transcript, /Private ordinary candidate/);
});

test('F07 quoted, negated and mentioned cues do not execute and typed phrase testing is free', async t => {
  const h = harness(t); enableVoice(h); await h.start('call', false);
  h.connection('remote').transcript('Explain closures.');
  for (const text of ['Do not give me a minute to think.', 'The phrase is "Give me a minute to think."', 'I said give me a minute to think.']) {
    h.connection('you').transcript(text); await h.tick(1000);
    assert.equal(h.invoke('voice:test', {text}).matched, false);
  }
  assert.equal(h.invoke('voice:test', {text:'Gimme a minute to think.'}).matched, true);
  assert.equal(h.requests.length, 0);
});

test('F08 voice cue cannot resurrect an expired question or an empty session', async t => {
  const h = harness(t); enableVoice(h, {voiceFreshnessMs:30000}); await h.start('call', false);
  const mic = h.connection('you'); mic.transcript('Give me a minute to think.'); await settle();
  assert.match(h.state().voiceCommandStatus.message, /No pending/);
  h.connection('remote').transcript('Explain closures.'); await h.tick(31000);
  mic.transcript('Give me a minute to think.'); await settle();
  assert.equal(h.requests.length, 0); assert.match(h.state().voiceCommandStatus.message, /No pending/);
});

test('F09 full DSA background and constraints survive separated finalized turns before voice submission', async t => {
  const h = harness(t); enableVoice(h); await h.start('call', false);
  for (const text of ['You are given an integer array.', 'It includes negative numbers and zeros.', 'Return the length of the longest contiguous subarray whose sum is K.']) {
    h.connection('remote').transcript(text); await h.tick(1400);
  }
  h.connection('you').transcript('Give me a minute to think.'); await settle();
  assert.equal(h.requests.length, 1);
  assert.match(h.requests[0].options.question, /given an integer array.*negative numbers.*longest contiguous/);
});

test('F10 Mic practice question and terminal voice command in one final excludes the command', async t => {
  const h = harness(t); enableVoice(h); await h.start('practice', false);
  h.connection('you').transcript('What are closures? Give me a minute to think.'); await settle();
  assert.equal(h.requests.length, 1); assert.equal(h.requests[0].options.question, 'What are closures?');
  assert.doesNotMatch(h.requests[0].options.transcript, /minute to think/);
});

test('F11 voice fallback respects cap and does not silently enable itself or create a third stream', async t => {
  const h = harness(t); assert.equal(h.invoke('settings:get').voiceFallbackEnabled, false);
  enableVoice(h, {maxAutoAnswers:1}); await h.start('call', false, true);
  assert.equal(h.connections.length, 2);
  h.connection('remote').transcript('Explain closures.');
  h.connection('you').transcript('Give me a minute to think.'); await settle(); await h.tick(3100);
  h.connection('remote').transcript('Explain promises.');
  h.connection('you').transcript('Give me a minute to think.'); await settle();
  assert.equal(h.requests.length, 1); assert.match(h.state().voiceCommandStatus.message, /limit/);
});

test('F11 voice pending submission is invalidated by stop or an audio gap during finalization', async t => {
  const h = harness(t); enableVoice(h); await h.start('call', false);
  const remote = h.connection('remote'); remote.transcript('Given an array.');
  remote.transcript('Return', {isFinal:false,start:2,duration:1});
  h.connection('you').transcript('Give me a minute to think.'); await settle();
  remote.options.onState('reconnecting'); await settle(); await h.tick(1600);
  assert.equal(h.requests.length, 0);
  h.invoke('listen:stop'); await h.tick(8000); assert.equal(h.requests.length, 0);
});

test('F12 custom phrases, Hindi alias and advanced defaults round-trip through settings', async t => {
  const h = harness(t); const defaults = h.invoke('settings:get');
  assert.equal(defaults.voiceFreshnessMs, 90000); assert.equal(defaults.voiceCooldownMs, 3000); assert.equal(defaults.voiceFinalizeMs, 1500);
  assert.equal(h.invoke('voice:test', {text:'एक मिनट, मुझे सोचने दीजिए।'}).matched, true);
  enableVoice(h, {voiceCommandPhrases:['Please prepare that answer.'],speechLanguage:'multi'}); h.readConfig();
  assert.equal(h.invoke('voice:test', {text:'Please prepare that answer.'}).matched, true);
  assert.equal(h.invoke('voice:test', {text:'Give me a minute to think.'}).matched, false);
  await h.start('practice', false); assert.equal(h.connection('you').options.language, 'multi');
  assert.throws(() => enableVoice(h), /Stop listening/);
});

test('a new voice-submitted question queues behind a different answer without interrupting either', async t => {
  const h = harness(t, {holdAnswers:true}); enableVoice(h); await h.start('call', false);
  h.connection('remote').transcript('Explain closures.'); h.connection('you').transcript('Give me a minute to think.'); await settle();
  await h.tick(3100); h.connection('remote').transcript('Explain promises.'); h.connection('you').transcript('Give me a minute to think.'); await settle();
  assert.equal(h.requests.length, 1); assert.equal(h.state().answerQueue.length, 1);
  assert.equal(h.requests[0].options.signal.aborted, false);
  h.requests[0].finish(); await settle(); assert.equal(h.requests.length, 2);
  assert.equal(h.requests[1].options.question, 'Explain promises.'); h.requests[1].finish(); await settle();
});

test('hotkey recovers pending text even with voice fallback and Auto both off, but never old answered text', async t => {
  const h = harness(t); await h.start('call', false);
  h.connection('remote').transcript('A bounded buffer using multiple producers and consumers.'); await h.tick(1000);
  assert.equal((await h.invoke('answer:submit-pending')).ok, true); await settle();
  assert.equal(h.requests.length, 1);
  assert.equal((await h.invoke('answer:submit-pending')).ok, false);
  assert.equal(h.requests.length, 1);
});

test('local diagnostic export is opt-in, credential-free, and records trigger and latency separately', async t => {
  const h = harness(t); enableVoice(h); await h.start('call', false);
  h.connection('remote').transcript('Explain closures.'); h.connection('you').transcript('Give me a minute to think.'); await settle();
  const events = h.invoke('diagnostics:get').events;
  assert.ok(events.some(e => e.kind === 'question-decision' && e.trigger === 'voice'));
  assert.ok(events.some(e => e.kind === 'answer-start' && e.provider === 'openai'));
  const output = h.invoke('diagnostics:export'); assert.equal(output.ok, true);
  const exported = JSON.stringify(h.writes.at(-1));
  assert.doesNotMatch(exported, /fake-answer-key|fake-speech-key/);
});

test('council: an older finalized segment cannot clear a newer unresolved speech span for voice recovery', async t => {
  const h = harness(t); enableVoice(h); await h.start('call', false);
  const remote = h.connection('remote');
  remote.transcript('Return the longest subarray', { isFinal:false, start:0, duration:1 });
  remote.transcript('Negative numbers are allowed.', { isFinal:false, start:2, duration:1 });
  remote.transcript('Return the longest subarray with sum K.', { start:0, duration:1 });
  h.connection('you').transcript('Give me a minute to think.', {start:4,duration:1});
  await settle(); await h.tick(1500);
  assert.equal(h.requests.length, 0, 'A finalized older segment does not authorize submitting incomplete newer speech');
  assert.match(h.state().voiceCommandStatus.message, /incomplete/);
  remote.transcript('Negative numbers are allowed.', {start:2,duration:1}); await h.tick(1600);
  h.connection('you').transcript('Give me a minute to think.', {start:6,duration:1}); await settle();
  assert.equal(h.requests.length, 1); assert.match(h.requests[0].options.question, /Negative numbers are allowed/);
});

test('council: dropped question audio cannot be overwritten by an automatic continuation across the gap', async t => {
  const h = harness(t); await h.start('call', true); const remote = h.connection('remote');
  remote.transcript('Given an integer array.', {start:0,duration:1}); await h.tick(300);
  remote.options.onError('Audio buffer full; some audio was dropped. Check your connection.');
  remote.transcript('Return the longest subarray with sum K.', {start:2,duration:1}); await h.tick(1000);
  assert.equal(h.requests.length, 0, 'Missing constraints must not silently become an apparently complete prompt');
  remote.transcript('What is a closure?', {start:4,duration:1}); await h.tick(1000);
  assert.equal(h.requests.length, 1); assert.equal(h.requests[0].options.question, 'What is a closure?');
});

test('council: provider access and quota failures halt queued voice submissions as well as automatic ones', async t => {
  for (const status of [403, 429]) {
    const h = harness(t, {holdAnswers:true}); enableVoice(h); await h.start('call', false);
    h.connection('remote').transcript('Explain closures.');
    h.connection('you').transcript('Give me a minute to think.'); await settle();
    await h.tick(3100);
    h.connection('remote').transcript('Explain binary search.');
    h.connection('you').transcript('Give me a minute to think.'); await settle();
    assert.equal(h.state().answerQueue.length, 1);
    h.requests[0].fail(Object.assign(new Error('Provider denied request'), {status})); await settle();
    assert.equal(h.requests.length, 1, `Status ${status} must not drain more requests against the same failing provider`);
    assert.equal(h.state().answerQueue.length, 0); assert.equal(h.state().settings.autoAnswer, false);
  }
});

test('council: a spoken short followup inherits the manually typed first question', async t => {
  const h = harness(t); await h.start('practice', true);
  await h.invoke('answer:ask', {question:'Design a least recently used cache.'}); await settle();
  h.connection('you').transcript('Time complexity.'); await h.tick(1000);
  assert.equal(h.requests.length, 2); assert.equal(h.requests[1].options.question, 'Time complexity.');
  assert.match(h.requests[1].options.transcript, /Design a least recently used cache/);
});

test('council: a microphone reconnect drops command prefixes without discarding valid remote question text', async t => {
  const h = harness(t); enableVoice(h); await h.start('call', false);
  h.connection('remote').transcript('Explain closures.'); await h.tick(900);
  const mic = h.connection('you'); mic.transcript('Give me a minute', {start:0,duration:1});
  mic.options.onState('reconnecting'); mic.transcript('to think.', {start:2,duration:1}); await settle();
  assert.equal(h.requests.length, 0, 'A command cannot be assembled across a lost audio interval');
  mic.transcript('Give me a minute to think.', {start:4,duration:1}); await settle();
  assert.equal(h.requests.length, 1); assert.equal(h.requests[0].options.question, 'Explain closures.');
});

test('council: remote pause phrases are not technical tasks when automatic answers are on', async t => {
  const h = harness(t); await h.start('call', true);
  for (const text of ['Give me a minute to think.', 'Gimme a minute to think.', 'Let me think through this for a moment.',
    'Let me work through this step by step.', 'Ek minute, mujhe sochne dijiye.', 'एक मिनट, मुझे सोचने दीजिए।']) {
    h.connection('remote').transcript(text); await h.tick(1000);
  }
  assert.equal(h.requests.length, 0); assert.equal(h.state().pending.canRecover, false);
  h.connection('remote').transcript('Give me an example of closures.'); await h.tick(1000);
  assert.equal(h.requests.length, 1);
});

test('queued followup binds its accepted question context instead of later unrelated transcript', async t => {
  const h = harness(t, {holdAnswers:true}); await h.start('practice');
  const mic = h.connection('you');
  mic.transcript('Find the longest subarray whose sum is K.'); await h.tick(800);
  mic.transcript('Time complexity.'); await h.tick(800);
  mic.transcript('New question: Design a distributed rate limiter.'); await h.tick(800);
  h.requests[0].finish(); await settle();
  assert.equal(h.requests[1].options.question, 'Time complexity.');
  assert.match(h.requests[1].options.transcript, /longest subarray/);
  assert.doesNotMatch(h.requests[1].options.transcript, /distributed rate limiter/);
  h.requests[1].finish(); await settle(); assert.equal(h.requests.length, 3);
  h.requests[2].finish(); await settle();
});

for (const pause of [300,800,1400,2000,4000]) {
  test(`DSA background, negative constraints and objective survive ${pause}ms pauses`, async t => {
    const h = harness(t); await h.start('practice'); const mic = h.connection('you');
    mic.transcript('You are given an integer array.'); await h.tick(pause);
    mic.transcript('It can contain negative numbers and zeros.'); await h.tick(pause);
    assert.equal(h.requests.length, 0);
    mic.transcript('Return the length of the longest contiguous subarray whose sum is K.'); await h.tick(801);
    assert.equal(h.requests.length, 1);
    assert.match(h.requests[0].options.question, /given an integer array.*negative numbers.*Return the length/);
  });
  test(`voice command split over ${pause}ms does not leak its prefix into the question`, async t => {
    const h = harness(t); enableVoice(h); await h.start('practice', false); const mic = h.connection('you');
    mic.transcript('Explain closures.'); mic.transcript('Give me a minute'); await h.tick(pause);
    assert.equal(h.requests.length, 0);
    mic.transcript('to think.'); await settle();
    assert.equal(h.requests.length, 1); assert.equal(h.requests[0].options.question, 'Explain closures.');
  });
}

test('a ninety-second segmented DSA problem retains early constraints without early generation', async t => {
  const h = harness(t); await h.start('practice'); const mic = h.connection('you');
  mic.transcript('You are given an integer array with negative numbers and zeros.'); await h.tick(2000);
  for (let i=0; i<44; i++) { mic.transcript(`Additional bound number ${i+1} is part of the same input specification.`); await h.tick(2000); }
  assert.equal(h.requests.length, 0);
  mic.transcript('Return the length of the longest contiguous subarray whose sum is K.'); await h.tick(801);
  assert.equal(h.requests.length, 1); assert.match(h.requests[0].options.question, /negative numbers and zeros/);
});

test('expiry: orphan SpeechStarted between answers cannot silently block the next finalized question', async t => {
  const h = harness(t); await h.start('practice', true); const mic = h.connection('you');
  mic.transcript('What is a closure?', {start:0,duration:1}); await h.tick(1000);
  assert.equal(h.requests.length, 1);
  mic.transcript('', {isFinal:false,speechFinal:false,speechStarted:true,start:2,duration:0}); await h.tick(7000);
  mic.transcript('What is binary search?', {start:10,duration:2}); await h.tick(1000);
  assert.equal(h.requests.length, 2, 'An expired VAD hint is not unresolved question text');
  assert.equal(h.requests[1].options.question, 'What is binary search?');
});

test('held finalized speech has a persistent visible recovery state and shares hotkey dedupe', async t => {
  const h = harness(t); await h.start('practice', true);
  h.connection('you').transcript('A bounded buffer using multiple producers and consumers.', {start:0,duration:3}); await h.tick(1000);
  const state = h.invoke('content:state');
  assert.equal(state.questionStatus.status, 'held'); assert.equal(state.questionStatus.canSubmit, true);
  assert.match(state.questionStatus.text, /bounded buffer/); assert.match(state.questionStatus.message, /uncertain/);
  assert.equal(h.requests.length, 0);
  assert.equal((await h.invoke('answer:submit-pending')).ok, true); await settle();
  assert.equal(h.requests.length, 1); assert.equal(h.invoke('content:state').questionStatus, null);
  assert.equal((await h.invoke('answer:submit-pending')).ok, false); assert.equal(h.requests.length, 1);
});

test('incomplete capture explains its blocker and a full Find request recovers automatic answering', async t => {
  const h = harness(t); await h.start('practice', true); const mic = h.connection('you');
  mic.transcript('Given an integer array.', {start:0,duration:1});
  mic.transcript('With a missing constraint', {isFinal:false,start:2,duration:1}); await h.tick(7000);
  const status = h.invoke('content:state').questionStatus;
  assert.equal(status.status, 'blocked'); assert.equal(status.canSubmit, false); assert.match(status.message, /repeat the full question/);
  mic.transcript('Find the longest subarray with sum K in an integer array that may contain negatives.', {start:10,duration:4}); await h.tick(1000);
  assert.equal(h.requests.length, 1); assert.equal(h.invoke('content:state').questionStatus, null);
});

test('unresolved text recovery also works with Auto off and an explicit keyboard submission', async t => {
  const h = harness(t); await h.start('practice', false); const mic = h.connection('you');
  mic.transcript('An unfinished constraint', {isFinal:false,start:0,duration:1});
  mic.transcript('What is binary search?', {start:3,duration:2}); await h.tick(1000);
  assert.equal(h.requests.length,0); await h.tick(5501);
  assert.equal(h.invoke('content:state').questionStatus.canSubmit, false);
  assert.equal((await h.invoke('answer:submit-pending')).ok, false);
  mic.transcript('What is binary search?', {start:7,duration:2}); await h.tick(1000);
  assert.equal((await h.invoke('answer:submit-pending')).ok, true); await settle();
  assert.equal(h.requests.length, 1); assert.equal(h.requests[0].options.question, 'What is binary search?');
});

for (const question of ['Okay, what is a closure?', 'Tell me about binary search.', 'Kya binary search ke liye sorted array chahiye?']) {
  test(`fresh recovery uses ordinary supported question phrasing: ${question}`, async t => {
    const h = harness(t); await h.start('practice'); const mic = h.connection('you');
    mic.transcript('An unfinished constraint', {isFinal:false,start:0,duration:1}); await h.tick(7000);
    mic.transcript('Return its length.', {start:8,duration:1}); await h.tick(1000);
    assert.equal(h.requests.length, 0);
    assert.ok(h.invoke('diagnostics:get').events.some(event => event.kind === 'transcript-final' && event.text === 'Return its length.'));
    mic.transcript(question, {start:10,duration:2}); await h.tick(1000);
    assert.equal(h.requests.length, 1); assert.equal(h.requests[0].options.question, question);
  });
}

test('expiry: abandoned interim-only speech becomes incomplete and a fresh full question answers afterward', async t => {
  const h = harness(t); await h.start('practice', true); const mic = h.connection('you');
  mic.transcript('What is a closure?', {start:0,duration:1}); await h.tick(1000);
  mic.transcript('Can you', {isFinal:false,speechFinal:false,start:2,duration:0.4}); await h.tick(7000);
  assert.equal(h.requests.length, 1, 'Abandoned interim text must not trigger a fabricated answer');
  mic.transcript('What is binary search?', {start:10,duration:2}); await h.tick(1000);
  assert.equal(h.requests.length, 2); assert.equal(h.requests[1].options.question, 'What is binary search?');
});

test('expiry: a new valid final clears earlier VAD-only hints without waiting for their timer', async t => {
  const h = harness(t); await h.start('practice', true); const mic = h.connection('you');
  mic.transcript('What is a closure?', {start:0,duration:1}); await h.tick(1000);
  mic.transcript('', {isFinal:false,speechFinal:false,speechStarted:true,start:2,duration:0}); await h.tick(500);
  mic.transcript('What is binary search?', {start:3,duration:2}); await h.tick(1000);
  assert.equal(h.requests.length, 2, 'VAD metadata alone cannot suppress a completed technical question');
  assert.equal(h.requests[1].options.question, 'What is binary search?');
});

test('expiry: newer unrelated final must not silently discard an unresolved text-bearing span', async t => {
  const h = harness(t); await h.start('practice', true); const mic = h.connection('you');
  mic.transcript('What is a closure?', {start:0,duration:1}); await h.tick(1000);
  mic.transcript('But include the condition that', {isFinal:false,speechFinal:false,start:2,duration:1}); await h.tick(500);
  mic.transcript('What is binary search?', {start:4,duration:2}); await h.tick(1000);
  assert.equal(h.requests.length, 1, 'Missing ASR text needs an explicit incomplete outcome, unlike a VAD-only hint');
  const pending = h.invoke('answer:submit-pending'); await settle(); await h.tick(1500);
  assert.equal((await pending).ok, false); assert.equal(h.requests.length, 1);
  await h.tick(4001);
  mic.transcript('What is binary search?', {start:8,duration:2}); await h.tick(1000);
  assert.equal(h.requests.length, 2, 'Repeating the full question after the incomplete outcome must recover');
  assert.equal(h.requests[1].options.question, 'What is binary search?');
});

for (const [pause, unfinished] of [[800, 6500], [700, 3000]]) {
  test(`call questions after leading VAD submit at ${pause}/${unfinished}ms settings and survive a restart`, async t => {
    const h = harness(t);
    h.invoke('settings:save', { autoAnswer: true, questionPauseMs: pause, incompletePauseMs: unfinished, answerTimeoutMs: 70000 });
    await h.start('call', true);
    const remote = h.connection('remote');
    const questions = ['Please explain disclosures in JavaScript.', 'Can you please explain your professional background?', 'Can you explain your professional background?'];
    for (const [index, question] of questions.entries()) {
      const start = 3 + index * 12;
      remote.transcript('', {isFinal:false,speechFinal:false,speechStarted:true,start:start-0.2,duration:0});
      remote.transcript(question, {start,duration:3.3});
      await h.tick(pause-1); assert.equal(h.requests.length,index);
      await h.tick(1); assert.equal(h.requests.length,index+1);
      assert.equal(h.requests[index].options.question,question);
    }
    h.invoke('listen:stop'); await h.start('call', true);
    const restarted = h.connection('remote');
    restarted.transcript('', {isFinal:false,speechFinal:false,speechStarted:true,start:2.8,duration:0});
    restarted.transcript('Please explain closures in JavaScript.', {start:3.02,duration:3.27});
    await h.tick(pause);
    assert.equal(h.requests.length,4);
    assert.equal(h.requests[3].options.question,'Please explain closures in JavaScript.');
    const events = h.invoke('diagnostics:get').events;
    const start = events.findLast(event=>event.kind==='session-start');
    assert.equal(start.autoAnswer,true); assert.equal(start.questionPauseMs,pause); assert.equal(start.incompletePauseMs,unfinished);
    assert.equal(start.questionSource,'remote'); assert.equal(start.answerTimeoutMs,70000);
    assert.equal(events.some(event=>event.kind==='question-decision'&&event.reason==='manual-mode'),false);
  });
}

test('diagnostics distinguish disabled Auto-answer from an unresolved text-bearing audio guard', async t => {
  const h = harness(t); await h.start('practice',false); const mic=h.connection('you');
  mic.transcript('What is a closure?',{start:0,duration:1}); await h.tick(800);
  let events=h.invoke('diagnostics:get').events;
  assert.equal(events.findLast(event=>event.kind==='question-decision').reason,'manual-mode');
  h.invoke('session:preferences',{autoAnswer:true});
  mic.transcript('A missing constraint',{isFinal:false,start:2,duration:1});
  mic.transcript('Describe closures in JavaScript.',{start:4,duration:2}); await h.tick(800);
  assert.equal(h.requests.length,0); await h.tick(5701);
  events=h.invoke('diagnostics:get').events;
  const blocked=events.findLast(event=>event.kind==='question-decision'&&event.awaitingFinalAudio);
  assert.equal(blocked.reason,'incomplete-audio'); assert.equal(blocked.autoAnswer,true);
  assert.deepEqual(JSON.parse(JSON.stringify(blocked.pendingAudioSpans)),[{start:2,end:3,hasText:true}]);
  assert.equal(h.requests.length,0);
  const progress=events.filter(event=>event.kind==='speech-progress');
  assert.ok(progress.length>0);
  assert.equal(progress.some(event=>Object.hasOwn(event,'text')),false,'Interim speech words are not duplicated into progress diagnostics');
});

for (const [pause,unfinished] of [[800,6500],[700,3000]]) {
  test(`finalized audio handles stale interims and retracted words without blocking later questions (${pause}/${unfinished})`, async t => {
    const h=harness(t); h.invoke('settings:save',{autoAnswer:true,questionPauseMs:pause,incompletePauseMs:unfinished}); await h.start('call');
    const remote=h.connection('remote');
    remote.transcript('What is a closure?',{start:0,duration:2}); await h.tick(pause);
    assert.equal(h.requests.length,1);
    remote.transcript('What is a closure?',{isFinal:false,start:0,duration:2});
    remote.transcript('Describe closures in JavaScript.',{start:4,duration:2}); await h.tick(200);
    remote.transcript('Describe closures in JavaScript.',{isFinal:false,start:4,duration:2}); await h.tick(pause-200);
    assert.equal(h.requests.length,2,'A late interim within a finalized range must not re-open it');
    remote.transcript('What is binary search?',{start:8,duration:2}); await h.tick(200);
    remote.transcript('um',{isFinal:false,start:10,duration:0.4});
    remote.transcript('',{eventType:'Results',isFinal:true,speechFinal:false,start:10,duration:1});
    await h.tick(pause);
    assert.equal(h.requests.length,3,'An explicitly finalized empty range settles retracted interim text');
    assert.equal(h.requests[2].options.question,'What is binary search?');
  });
  test(`partial final preserves trailing constraints until their own final result (${pause}/${unfinished})`, async t => {
    const h=harness(t); h.invoke('settings:save',{autoAnswer:true,questionPauseMs:pause,incompletePauseMs:unfinished}); await h.start('call');
    const remote=h.connection('remote');
    remote.transcript('Find the longest sum-K subarray. The array includes negative values and zeros.',{isFinal:false,start:4,duration:5});
    remote.transcript('Find the longest sum-K subarray.',{isFinal:true,speechFinal:false,start:4,duration:2}); await h.tick(pause+100);
    assert.equal(h.requests.length,0,'Partial final must not drop the constraint already present in the interim tail');
    remote.transcript('',{eventType:'UtteranceEnd',start:6,duration:0}); await h.tick(100);
    assert.equal(h.requests.length,0,'UtteranceEnd cannot finalize that tail');
    remote.transcript('The array includes negative values and zeros.',{isFinal:true,speechFinal:true,start:6,duration:3}); await h.tick(pause);
    assert.equal(h.requests.length,1);
    assert.equal(h.requests[0].options.question,'Find the longest sum-K subarray. The array includes negative values and zeros.');
  });
  test(`unrelated empty final cannot discard an uncaptured constraint (${pause}/${unfinished})`, async t => {
    const h=harness(t); h.invoke('settings:save',{autoAnswer:true,questionPauseMs:pause,incompletePauseMs:unfinished}); await h.start('call');
    const remote=h.connection('remote');
    remote.transcript('Find the longest sum-K subarray.',{start:4,duration:2});
    remote.transcript('The array includes negative values',{isFinal:false,start:6,duration:3});
    remote.transcript('',{eventType:'Results',start:10,duration:2});
    await h.tick(unfinished+1);
    assert.equal(h.requests.length,0); assert.equal(h.invoke('content:state').questionStatus.canSubmit,false);
  });
  test(`repeating a question after missing audio retains its unfinished constraint (${pause}/${unfinished})`, async t => {
    const h=harness(t); h.invoke('settings:save',{autoAnswer:true,questionPauseMs:pause,incompletePauseMs:unfinished}); await h.start('call');
    const remote=h.connection('remote');
    remote.transcript('An unfinished constraint',{isFinal:false,start:0,duration:2}); await h.tick(unfinished+1);
    remote.transcript('Return its length.',{start:3,duration:1}); await h.tick(pause);
    assert.equal(h.requests.length,0,'A dependent continuation cannot reconstruct the missing question');
    remote.transcript('Find the longest sum-K subarray. The array includes negative values and zeros.',{isFinal:false,start:5,duration:5});
    remote.transcript('Find the longest sum-K subarray.',{isFinal:true,speechFinal:false,start:5,duration:2}); await h.tick(pause+100);
    assert.equal(h.requests.length,0,'The repeated question must retain the coverage of its interim tail');
    remote.transcript('The array includes negative values and zeros.',{start:7,duration:3}); await h.tick(pause);
    assert.equal(h.requests.length,1);
    assert.equal(h.requests[0].options.question,'Find the longest sum-K subarray. The array includes negative values and zeros.');
  });
}
