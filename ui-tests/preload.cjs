const { contextBridge, ipcRenderer } = require('electron');
let listener, asks = [], currentAsk, rejected = false, saveCount = 0, appearance = [], preferences = [], starts = [], stops = 0, modelRefreshes = 0, credentialFields = [], textSizes = [], contentOpens = [], voiceTests = [], diagnosticReads = 0, diagnosticExports = 0;
const settings = { answerProvider: 'openai', providerModels: {openai:'test-model'}, providerFastModels:{}, model: 'test-model', mode: 'auto', depth: 'auto', sessionMode: 'call', context: '', autoAnswer: false, maxMinutes: 5, maxAutoAnswers: 5, backgroundOpacity: 78, hasOpenAI: false, hasDeepgram: false, chatgptConnected: false, encryptedStorage: true, protectionRequested: true };
Object.assign(settings, { profileError: 'Saved profile could not be read. Setup is read-only until recovery.', speechLanguage: 'en', voiceFallbackEnabled: false, voiceCommandDefaults: ['Give me a minute to think.', 'Let me think through this for a moment.', 'Let me work through this step by step.', 'Ek minute, mujhe sochne dijiye.'], voiceCommandPhrases: ['Give me a minute to think.', 'Let me think through this for a moment.', 'Let me work through this step by step.', 'Ek minute, mujhe sochne dijiye.'], voiceFreshnessMs: 90000, voiceCooldownMs: 3000, voiceFinalizeMs: 1500 });
const emit = event => listener?.(event);
contextBridge.exposeInMainWorld('prateekAi', {
  settings: async () => ({ ...settings }),
  testVoiceCommand: async input => { voiceTests.push(input); return { matched: input.phrases.includes(input.text), phrase: input.text }; },
  diagnostics: async () => { diagnosticReads++; return { events: [{ at: 1000, kind: 'question-ready', message: '<img src=x onerror=window.__diagnosticUnsafe=true> No raw question included.' }, { at: 2000, kind: 'voice-command', message: 'Command accepted.' }] }; },
  exportDiagnostics: async () => { diagnosticExports++; return { ok: true, path: 'C:\\mock-tests\\diagnostics.json' }; },
  showContent: async options => { contentOpens.push(options); },
  setTextSize: async value => { textSizes.push(value); settings.answerFontSize=value; return value; },
  saveSettings: async value => {
    saveCount++; await new Promise(resolve => setTimeout(resolve, 20));
    const providerChanged = settings.answerProvider !== value.answerProvider;
    credentialFields = Object.keys(value).filter(key=>key.endsWith('Key') && value[key]);
    const clean = {...value}; for (const key of Object.keys(clean).filter(key=>key.endsWith('Key'))) delete clean[key];
    Object.assign(settings, clean);
    settings.providerModels[settings.answerProvider] = settings.model;
    settings.providerFastModels[settings.answerProvider] = settings.fastModel;
    return { ...settings, providerChanged };
  },
  sessionPreferences: async value => { preferences.push(value); Object.assign(settings, value); emit({ type: 'session-preferences', settings: { ...settings } }); return { ...settings }; },
  refreshModels: async () => { modelRefreshes++; return { provider:settings.answerProvider, status: 'ready', models: settings.answerProvider==='anthropic' ? [{slug:'claude-haiku-4-5',display_name:'Claude Haiku 4.5'},{slug:'claude-sonnet-5-5',display_name:'Claude Sonnet 5.5'}] : [{ slug:'gpt-6-luna', display_name:'GPT-6 Luna' }] }; },
  setAppearance: async value => { appearance.push(value); settings.backgroundOpacity = value; return value; },
  setMotion: async value => { settings.motionEffects = value; return value; },
  setLayout: focus => ipcRenderer.invoke('test:layout', focus),
  onEvent: handler => { listener = handler; },
  ask: input => {
    asks.push(input);
    if (rejected) { rejected = false; return Promise.reject(new Error('Test provider is not connected.')); }
    return new Promise(resolve => { currentAsk = resolve; });
  },
  cancelAnswer: async () => { emit({ type: 'answer-cancelled' }); currentAsk?.({ ok: true }); },
  clear: async () => ({}), cancelChatGPT: async () => ({}),
  connectChatGPT: async () => { throw new Error('Disabled in UI tests.'); },
  disconnectChatGPT: async () => ({ ...settings }),
  start: async value => { starts.push({ ...value, sessionMode: settings.sessionMode }); return { ok: true }; },
  stop: async () => { stops++; emit({ type: 'session-stopped', reason: 'Listening stopped.' }); },
  audio: () => { throw new Error('Audio disabled in UI tests.'); },
  captureFailure: async () => ({}), minimize() {}, close() {},
});
contextBridge.exposeInMainWorld('uiTest', {
  emit, rejectNext: () => { rejected = true; },
  finish: event => { emit(event); currentAsk?.({ ok: true }); },
  counts: () => ({ asks: asks.length, lastAsk: asks.at(-1), saveCount, appearance, preferences, starts, stops, modelRefreshes, adaptiveModels: settings.adaptiveModels, provider:settings.answerProvider, model:settings.model, fastModel:settings.fastModel, credentialFields, textSizes, contentOpens, roleTitle:settings.roleTitle,roleDescription:settings.roleDescription,context:settings.context,timing:[settings.questionPauseMs,settings.incompletePauseMs,settings.answerTimeoutMs], voiceTests, diagnosticReads, diagnosticExports, voice: {enabled:settings.voiceFallbackEnabled,phrases:settings.voiceCommandPhrases,freshness:settings.voiceFreshnessMs,cooldown:settings.voiceCooldownMs,finalize:settings.voiceFinalizeMs,language:settings.speechLanguage} }),
  setSettings: value => { Object.assign(settings, value); emit({ type: 'session-preferences', settings: { ...settings } }); },
});
