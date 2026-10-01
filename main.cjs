const { app, BrowserWindow, ipcMain, desktopCapturer, session, globalShortcut, safeStorage, Menu, shell, screen } = require('electron');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { streamProviderAnswer, listProviderModels, validateBaseUrl } = require('./provider-adapters.cjs');
const { SpeechSession } = require('./speech.cjs');
const { TurnAssembler, looksLikeQuestion, classifyTurn } = require('./turns.cjs');
const { DEFAULT_VOICE_PHRASES, normalizeVoicePhrases, detectVoiceCommand, VoiceCommandMatcher, PendingQuestionBuffer } = require('./voice-fallback.cjs');
const { resolveProfileDirectory, createProfileStore } = require('./profile.cjs');
const { selectRoute } = require('./routing.cjs');
const { beginSignIn, refreshProfile, listModels, revokeProfile } = require('./oauth.cjs');

const smoke = process.argv.includes('--smoke-test');
const captureTest = process.argv.includes('--capture-test');
const dataDir = resolveProfileDirectory({ appData: app.getPath('appData'), env: process.env, fileSystem: fs });
fs.mkdirSync(dataDir, { recursive: true });
app.setPath('userData', dataDir);
app.setName('prateekAi');
const pageURL = pathToFileURL(path.join(__dirname, 'index.html')).href;
const contentURL = pathToFileURL(path.join(__dirname, 'content.html')).href;
const answerProviders = new Set(['chatgpt', 'openai', 'anthropic', 'gemini', 'compatible']);
const defaultProviderModels = { chatgpt: 'gpt-5.6-sol', openai: 'gpt-5.6-sol', anthropic: 'claude-sonnet-5-5', gemini: 'gemini-3.8-flash', compatible: '' };
const emptyFastModels = () => Object.fromEntries([...answerProviders].map(provider => [provider, '']));
const timingRanges = { questionPauseMs: [400, 2500, 800], incompletePauseMs: [2000, 10000, 6500], answerTimeoutMs: [20000, 120000, 75000], voiceFreshnessMs: [30000, 180000, 90000], voiceCooldownMs: [2000, 10000, 3000], voiceFinalizeMs: [500, 3000, 1500] };
const clampTiming = (value, [minimum, maximum, fallback]) => Number.isFinite(value) ? Math.max(minimum, Math.min(maximum, Math.round(value))) : fallback;
const accessOrQuotaCodes = new Set(['subscription_sharing_usage_limit_exceeded', 'subscription_sharing_usage_unavailable', 'subscription_sharing_user_not_eligible',
  'insufficient_quota', 'rate_limit_exceeded', 'rate_limit_error', 'resource_exhausted', 'authentication_error', 'permission_error', 'SIGN_IN_REQUIRED', 'PLAN_ACCESS_REQUIRED']);
let win, contentWin = null, contentWindowPromise = null, settings = { answerProvider: 'chatgpt', providerModels: { ...defaultProviderModels }, providerFastModels: emptyFastModels(), compatibleBaseUrl: '', model: 'gpt-5.6-sol', fastModel: '', adaptiveModels: true, mode: 'auto', depth: 'auto', context: '', roleTitle: '', roleDescription: '', sessionMode: 'call', autoAnswer: false, maxMinutes: 30, maxAutoAnswers: 20, questionPauseMs: 800, incompletePauseMs: 6500, answerTimeoutMs: 75000, answerFontSize: 20, backgroundOpacity: 92, motionEffects: true, voiceFallbackEnabled: false, voiceCommandPhrases: [...DEFAULT_VOICE_PHRASES], voiceFreshnessMs: 90000, voiceCooldownMs: 3000, voiceFinalizeMs: 1500, speechLanguage: 'en' };
let secrets = { openai: '', anthropic: '', gemini: '', compatible: '', deepgram: '' };
let chatgptProfile = null, authController, authGeneration = 0, hostId = `urn:uuid:${crypto.randomUUID()}`;
const MODEL_CACHE_MS = 10 * 60000;
let modelCatalog = { models: [], status: 'unavailable', message: 'Refresh the available models after connecting an account.' };
let modelCatalogAt = 0, modelCatalogIdentity = null, modelCatalogEpoch = 0, modelCatalogRequest = null;
let live = false, sessionId = 0, speech = new Map(), history = [], answerHistory = [], lastQuestion = '';
let sessionTimer, requestController, requestId = 0, autoCount = 0, answers = 0, startedAt = 0;
let turnAssembler = null, queuedAutomatic = null, activeSessionMode = 'call', questionSource = 'remote', autoLimitNotice = false;
let lastQuestionTiming = null;
let pendingBuffer = null, micCommands = null, micCommandTimer = null, lastVoiceAt = -Infinity, includeMicContext = false;
let answerQueue = [], voiceCommandStatus = null, pendingSubmission = null, providerBlockedMessage = '';
const sourceNeedsFresh = new Set();
const audioUnfinished = new Map(), finalWaiters = new Set(), diagnosticsEvents = [];
const submittedQuestions = new Map();
const answeredTurns = new Set();
const recentAcceptedQuestions = new Map();
const normalizedQuestion = text => text.toLowerCase().replace(/\s+/g, ' ').trim().replace(/[.!?]+$/, '').trim();
let shutdown = false, captureAllowed = false;
let workspaceBounds;
let eventSequence = 0, contentVisibilityGeneration = 0, hotkeyAnswerPending = false, answerSnapshot = { id: null, question: '', text: '', state: 'idle' }, pendingQuestion = '';
let sourceStates = { remote: 'off', you: 'off' };
const profileStore = createProfileStore({ directory: dataDir, safeStorage, fileSystem: fs });
let profileError = '';
const configPath = profileStore.configPath;
function send(type, detail = {}) {
  const event = { ...detail, type, seq: ++eventSequence };
  if (type === 'session-reset') {
    answerSnapshot = { id: null, question: '', text: '', state: 'idle' };
    sourceStates = { remote: 'off', you: 'off' }; pendingQuestion = '';
  } else if (type === 'answer-start') answerSnapshot = { ...detail, text: '', state: 'generating', message: '', firstTextMs: null, elapsedMs: null };
  else if (type === 'answer-delta' && detail.id === answerSnapshot.id && typeof detail.text === 'string') answerSnapshot.text = (answerSnapshot.text + detail.text).slice(0, 256 * 1024);
  else if (['answer-phase', 'answer-timing'].includes(type) && detail.id === answerSnapshot.id) answerSnapshot = { ...answerSnapshot, ...detail };
  else if (type === 'answer-done' && detail.id === answerSnapshot.id) answerSnapshot = { ...answerSnapshot, ...detail, state: 'done' };
  else if (type === 'answer-error' && detail.id === answerSnapshot.id) answerSnapshot = { ...answerSnapshot, ...detail, state: 'error' };
  else if (type === 'answer-cancelled' && answerSnapshot.state === 'generating') answerSnapshot = { ...answerSnapshot, state: 'cancelled' };
  else if (type === 'speech-state' && ['remote', 'you'].includes(detail.source)) sourceStates[detail.source] = detail.state;
  else if (type === 'question-preview') pendingQuestion = detail.pending ? trim(detail.text, 8000) : '';
  else if (type === 'question') pendingQuestion = '';
  else if (type === 'session-stopped') {
    sourceStates = { remote: 'off', you: 'off' }; pendingQuestion = '';
    if (answerSnapshot.state === 'generating') answerSnapshot = { ...answerSnapshot, state: 'cancelled', message: detail.reason || '' };
  }
  for (const target of [win, contentWin]) {
    if (target && !target.isDestroyed() && !target.webContents.isDestroyed?.()) target.webContents.send('event', event);
  }
}
const trim = (v, n = 12000) => typeof v === 'string' ? v.slice(0, n) : '';
const allowedModes = new Set(['auto', 'coding', 'system-design', 'fundamentals', 'siebel', 'security', 'debugging', 'behavioral']);
const allowedDepths = new Set(['auto', 'foundational', 'applied', 'senior']);
const allowedSessionModes = new Set(['call', 'practice']);
const validModel = value => typeof value === 'string' && /^[a-z0-9][a-z0-9._:/-]{0,149}$/i.test(value);
const clampOpacity = value => Number.isFinite(Number(value)) ? Math.max(45, Math.min(100, Math.round(Number(value)))) : 92;
const clampTextSize = value => Number.isFinite(Number(value)) ? Math.max(16, Math.min(26, Math.round(Number(value)))) : 20;
const contentMethods = new Set(['settings:get', 'content:state', 'answer:submit-pending', 'answer:ask', 'answer:cancel', 'session:clear', 'listen:stop',
  'window:show-config', 'window:hide-content', 'window:content-close', 'window:show-content', 'window:resize-content', 'appearance:text-size', 'appearance:set']);
const ensureSender = (event, method) => {
  const configSender = win && !win.isDestroyed() && event.sender === win.webContents && event.senderFrame?.url === pageURL;
  const contentSender = contentWin && !contentWin.isDestroyed() && event.sender === contentWin.webContents && event.senderFrame?.url === contentURL && contentMethods.has(method);
  if (!configSender && !contentSender) throw new Error('Invalid app request.');
};
const handle = (name, fn) => ipcMain.handle(name, (event, ...args) => { ensureSender(event, name); return fn(...args); });
function contentState() {
  return { seq: eventSequence, settings: publicSettings(), live, startedAt, answers, question: lastQuestion, pendingQuestion,
    answer: { ...answerSnapshot }, sources: { ...sourceStates }, voiceCommandStatus };
}
function safeError(error) {
  let text = String(error?.message || error || 'Request failed.');
  for (const value of [...Object.values(secrets), chatgptProfile?.access_token, chatgptProfile?.refresh_token, chatgptProfile?.id_token]) if (value) text = text.split(value).join('[redacted]');
  return text.replace(/sk-[\w-]+/g, '[redacted]').slice(0, 350);
}
function readConfig() {
  const loaded = profileStore.load();
  const savedSettings = loaded.settings;
  profileError = loaded.message;
  Object.assign(settings, savedSettings);
  delete settings.siebelVocabulary;
  secrets = loaded.secrets;
  chatgptProfile = loaded.chatgptProfile;
  if (typeof loaded.hostId === 'string' && /^urn:uuid:[0-9a-f-]{36}$/i.test(loaded.hostId)) hostId = loaded.hostId;
  settings.answerProvider = answerProviders.has(savedSettings.answerProvider) ? savedSettings.answerProvider : chatgptProfile?.can_call_api ? 'chatgpt' : secrets.openai ? 'openai' : 'chatgpt';
  settings.providerModels = Object.fromEntries([...answerProviders].map(provider => [provider,
    validModel(savedSettings.providerModels?.[provider]) ? savedSettings.providerModels[provider] : defaultProviderModels[provider]]));
  settings.providerFastModels = Object.fromEntries([...answerProviders].map(provider => [provider,
    validModel(savedSettings.providerFastModels?.[provider]) ? savedSettings.providerFastModels[provider] : '']));
  if (validModel(savedSettings.model) && (!answerProviders.has(savedSettings.answerProvider) || !validModel(savedSettings.providerModels?.[settings.answerProvider]))) settings.providerModels[settings.answerProvider] = savedSettings.model;
  settings.model = settings.providerModels[settings.answerProvider];
  settings.fastModel = settings.providerFastModels[settings.answerProvider];
  try { settings.compatibleBaseUrl = settings.compatibleBaseUrl ? validateBaseUrl(settings.compatibleBaseUrl) : ''; } catch { settings.compatibleBaseUrl = ''; }
  if (!allowedModes.has(settings.mode)) settings.mode = 'auto';
  if (!allowedDepths.has(settings.depth)) settings.depth = 'auto';
  if (!allowedSessionModes.has(settings.sessionMode)) settings.sessionMode = 'call';
  settings.autoAnswer = settings.autoAnswer === true;
  settings.voiceFallbackEnabled = settings.voiceFallbackEnabled === true;
  try { settings.voiceCommandPhrases = normalizeVoicePhrases(settings.voiceCommandPhrases); } catch { settings.voiceCommandPhrases = [...DEFAULT_VOICE_PHRASES]; }
  settings.speechLanguage = settings.speechLanguage === 'multi' ? 'multi' : 'en';
  settings.adaptiveModels = settings.adaptiveModels !== false;
  settings.maxMinutes = Math.max(1, Math.min(60, Number(settings.maxMinutes) || 30));
  settings.maxAutoAnswers = Math.max(1, Math.min(60, Number(settings.maxAutoAnswers) || 20));
  settings.context = trim(settings.context, 20000);
  settings.roleTitle = trim(settings.roleTitle, 200);
  settings.roleDescription = trim(settings.roleDescription, 8000);
  settings.backgroundOpacity = clampOpacity(settings.backgroundOpacity);
  settings.answerFontSize = clampTextSize(settings.answerFontSize);
  for (const [field, range] of Object.entries(timingRanges)) settings[field] = clampTiming(settings[field], range);
  settings.incompletePauseMs = Math.max(Math.ceil(settings.questionPauseMs / 500) * 500, settings.incompletePauseMs);
}
function saveConfig() {
  profileStore.save({ settings, secrets, chatgptProfile, hostId });
}
function publicSettings() {
  return { ...settings, profileError, voiceCommandDefaults: [...DEFAULT_VOICE_PHRASES], providerModels: { ...settings.providerModels }, providerFastModels: { ...settings.providerFastModels },
    hasOpenAI: !!secrets.openai, hasAnthropic: !!secrets.anthropic, hasGemini: !!secrets.gemini, hasCompatible: !!secrets.compatible, hasDeepgram: !!secrets.deepgram,
    hasAnswerProvider: !!credentialIdentity(),
    chatgptConnected: !!chatgptProfile, chatgptCanCall: !!chatgptProfile?.can_call_api, chatgptLabel: chatgptProfile?.accountLabel || '',
    encryptedStorage: safeStorage.isEncryptionAvailable(), protectionRequested: win?.isContentProtected() || false,
    hotkeys: { answer: globalShortcut.isRegistered('CommandOrControl+Shift+Space'), toggle: globalShortcut.isRegistered('CommandOrControl+Shift+H') } };
}
function chatgptAccountIdentity(profile = chatgptProfile) {
  return profile ? JSON.stringify([profile.issuer, profile.client_id, profile.subject]) : null;
}
function credentialIdentity() {
  const provider = settings.answerProvider;
  if (provider === 'chatgpt') return chatgptProfile?.can_call_api ? `chatgpt:${authGeneration}:${chatgptAccountIdentity()}` : null;
  let baseUrl = '';
  if (provider === 'compatible') {
    try { baseUrl = validateBaseUrl(settings.compatibleBaseUrl); } catch { return null; }
    const hostname = new URL(baseUrl).hostname;
    const local = hostname === 'localhost' || hostname === '[::1]' || /^127(?:\.\d{1,3}){3}$/.test(hostname);
    if (!secrets.compatible && !local) return null;
  } else if (!secrets[provider]) return null;
  return `${provider}:${crypto.createHash('sha256').update(secrets[provider] || '').digest('hex')}:${baseUrl}`;
}
function missingAnswerProviderMessage() {
  const labels = { chatgpt: 'Connect a ChatGPT account with plan access', openai: 'Add an OpenAI API key', anthropic: 'Add a Claude API key', gemini: 'Add a Gemini API key', compatible: 'Set a compatible API base URL and its API key (optional for localhost)' };
  return `${labels[settings.answerProvider]} in Setup for the selected answer provider.`;
}
function publicCatalog() {
  return { ...modelCatalog, provider: settings.answerProvider, models: modelCatalog.models.map(model => ({ ...model })) };
}
function invalidateModelCatalog() {
  modelCatalogEpoch++;
  modelCatalogRequest?.controller.abort(); modelCatalogRequest = null;
  modelCatalogAt = 0; modelCatalogIdentity = null;
  modelCatalog = { models: [], status: 'unavailable', message: credentialIdentity() ? 'Refresh the available models for this account.' : 'Connect an answer account to discover its available models.' };
  send('model-catalog', publicCatalog());
}
function sanitizeModels(models) {
  const seen = new Set();
  return (Array.isArray(models) ? models : []).slice(0, 1000).flatMap(model => {
    if (!validModel(model?.slug) || seen.has(model.slug)) return [];
    seen.add(model.slug);
    const displayName = typeof model.display_name === 'string' ? model.display_name.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 200) : '';
    return [{ slug: model.slug, display_name: displayName || model.slug }];
  });
}
function cacheModelCatalog(models, identity) {
  const clean = sanitizeModels(models);
  modelCatalogIdentity = identity; modelCatalogAt = Date.now();
  modelCatalog = clean.length ? { models: clean, status: 'ready' }
    : { models: [], status: 'unavailable', message: 'No available models were returned. Keep using the selected model or refresh to retry.' };
  send('model-catalog', publicCatalog());
}
async function refreshModelCatalog({ force = false } = {}) {
  const identity = credentialIdentity();
  if (!identity) { invalidateModelCatalog(); return publicCatalog(); }
  if (modelCatalogRequest?.identity === identity) return modelCatalogRequest.promise;
  if (!force && modelCatalogIdentity === identity && modelCatalog.status === 'ready' && Date.now() - modelCatalogAt < MODEL_CACHE_MS) return publicCatalog();
  // Discovery is explicit and never sits on the answer generation path.
  const controller = new AbortController(), epoch = modelCatalogEpoch, generation = authGeneration;
  const selectedProvider = settings.answerProvider, selectedKey = secrets[selectedProvider] || '', selectedBaseUrl = settings.compatibleBaseUrl;
  const operation = { controller, identity, promise: null };
  modelCatalogRequest = operation;
  const isCurrent = () => modelCatalogRequest === operation && modelCatalogEpoch === epoch && credentialIdentity() === identity && !shutdown && !controller.signal.aborted;
  const timeout = setTimeout(() => controller.abort(), 12000);
  modelCatalog = { models: [], status: 'loading' }; modelCatalogIdentity = identity;
  send('model-catalog', publicCatalog());
  operation.promise = (async () => {
    try {
      let models;
      if (selectedProvider === 'chatgpt') {
        let selectedProfile = chatgptProfile;
        const accountIdentity = chatgptAccountIdentity(selectedProfile);
        if (selectedProfile.expires_at < Date.now() + 60000) {
          selectedProfile = await refreshProfile(selectedProfile, { signal: controller.signal, persist: profile => {
            // Persist a completed token rotation even if discovery is cancelled,
            // as long as it still belongs to this same account generation.
            if (generation !== authGeneration || chatgptAccountIdentity() !== accountIdentity || shutdown) return;
            chatgptProfile = profile; saveConfig();
          } });
        }
        if (!isCurrent()) return publicCatalog();
        models = await listModels(selectedProfile, { signal: controller.signal });
      } else {
        models = await listProviderModels({ provider: selectedProvider, apiKey: selectedKey, baseUrl: selectedBaseUrl, signal: controller.signal });
      }
      if (isCurrent()) cacheModelCatalog(models, identity);
    } catch {
      if (modelCatalogRequest === operation && modelCatalogEpoch === epoch && credentialIdentity() === identity && !shutdown) {
        modelCatalog = { models: [], status: 'unavailable', message: 'Model discovery is unavailable. Keep using your selected model; refresh to retry.' };
        modelCatalogAt = 0;
        send('model-catalog', publicCatalog());
      }
    } finally {
      clearTimeout(timeout);
      if (modelCatalogRequest === operation) modelCatalogRequest = null;
    }
    return publicCatalog();
  })();
  return operation.promise;
}
function cancelAnswer() { const wasActive = !!requestController; requestId++; requestController?.abort(); requestController = null; return wasActive; }
function recordDiagnostic(kind, message, detail = {}) {
  const entry = { at: Date.now(), sessionId, kind, message: safeError(message), ...detail };
  diagnosticsEvents.push(entry);
  if (diagnosticsEvents.length > 400) diagnosticsEvents.shift();
  send('diagnostic', { entry });
}
function reportVoice(status, message, detail = {}) {
  voiceCommandStatus = { status, message, at: Date.now(), ...detail };
  send('voice-command-status', voiceCommandStatus);
  recordDiagnostic('voice-command', message, { status, ...detail });
}
function syncQueue() { queuedAutomatic = answerQueue[0] || null; }
function clearQueue(reason = 'cancelled', automaticOnly = false) {
  answerQueue = answerQueue.filter(candidate => {
    if (automaticOnly && candidate.trigger !== 'auto') return true;
    submittedQuestions.set(candidate.key, reason);
    recordDiagnostic('question-decision', 'Queued question ' + reason, { decision: reason, questionId: candidate.turnId, trigger: candidate.trigger });
    return false;
  });
  syncQueue();
}
function resetTurns() {
  turnAssembler?.reset(); turnAssembler = null; clearQueue('session-reset'); lastQuestionTiming = null;
  answeredTurns.clear(); recentAcceptedQuestions.clear(); submittedQuestions.clear();
  pendingBuffer = null; micCommands?.reset(); micCommands = null;
  clearTimeout(micCommandTimer); micCommandTimer = null; lastVoiceAt = -Infinity;
  audioUnfinished.clear(); sourceNeedsFresh.clear(); providerBlockedMessage = ''; for (const notify of [...finalWaiters]) notify(false); finalWaiters.clear();
  pendingSubmission = null; voiceCommandStatus = null;
}
function stopSession(reason = 'Listening stopped.') {
  resetTurns(); cancelAnswer(); live = false; captureAllowed = false; sessionId++;
  clearTimeout(sessionTimer); sessionTimer = null;
  for (const connection of speech.values()) connection.stop();
  speech.clear(); send('session-stopped', { reason });
}
function publishTurn(id, turn, pending) {
  if (!live || sessionId !== id || (turn.source === 'you' && activeSessionMode === 'call' && !includeMicContext)) return;
  const text = trim(turn.text, 8000);
  if (!text || !speech.has(turn.source)) return;
  const existing = history.find(entry => entry.turnId === turn.id);
  if (existing) { existing.text = text; existing.at = Date.now(); if (pending) existing.lastFinalAt = Date.now(); }
  else { history.push({ turnId: turn.id, source: turn.source, text, at: Date.now(), lastFinalAt: Date.now() }); history = history.slice(-160); }
  send('transcript', { source: turn.source, text, turnId: turn.id, isFinal: true, pending });
  if (turn.source === questionSource && pending) send('question-preview', { text: pendingBuffer?.snapshot().text || text, turnId: turn.id, pending: true });
}
function automaticStillAllowed(candidate) {
  return !!candidate && live && candidate.sessionId === sessionId && candidate.sessionMode === activeSessionMode
    && candidate.source === questionSource && (candidate.trigger !== 'auto' || settings.autoAnswer)
    && (candidate.trigger !== 'auto' || looksLikeQuestion(candidate.question, { hasContext: !!lastQuestion || answerHistory.length > 0 }));
}
function pauseAutomatic(message) {
  settings.autoAnswer = false; clearQueue('paused', true); saveConfig();
  send('session-preferences', { settings: publicSettings() }); send('notice', { message });
}
function drainAutomatic() {
  if (requestController || !answerQueue.length) return;
  const candidate = answerQueue.shift(); syncQueue();
  if (!automaticStillAllowed(candidate)) { recordDiagnostic('question-decision', 'Queued question no longer eligible', { decision: 'cancelled', questionId: candidate.turnId }); drainAutomatic(); return; }
  if (autoCount >= settings.maxAutoAnswers) {
    submittedQuestions.set(candidate.key, 'limit-reached'); clearQueue('limit-reached');
    autoLimitNotice = true;
    send('notice', { message: 'Session answer limit reached. Use Ask manually or start a new session.' }); return;
  }
  if (!credentialIdentity() || !validModel(settings.model)) {
    submittedQuestions.set(candidate.key, 'provider-unavailable'); clearQueue('provider-unavailable');
    pauseAutomatic('Answers paused: check the selected provider, credentials, and main model in Setup.'); return;
  }
  ask({ question: candidate.question, automatic: true, candidate }).catch(error => send('notice', { message: safeError(error) }));
}
function queueSnapshot(snapshot, trigger) {
  const key = `${sessionId}:${snapshot.id}:${snapshot.revision}`;
  if (submittedQuestions.has(key) || snapshot.status === 'consumed') return { ok: false, message: 'This question is already submitted.' };
  if (providerBlockedMessage) return { ok: false, message: providerBlockedMessage };
  if (sourceNeedsFresh.has(questionSource)) return { ok: false, message: 'Audio was interrupted. Repeat the full question or enter it manually.' };
  if (!snapshot.canRecover) return { ok: false, message: snapshot.reason === 'too-long' ? 'Question is too long. Review it manually.' : 'No pending question captured.' };
  if (!credentialIdentity()) { const message = missingAnswerProviderMessage(); if (trigger === 'auto') pauseAutomatic('Automatic answers paused: ' + message); return { ok: false, message }; }
  if (!validModel(settings.model)) return { ok: false, message: 'Choose a valid main model in Setup.' };
  if (autoCount + answerQueue.length >= settings.maxAutoAnswers) return { ok: false, message: 'Session answer limit reached. Use Ask manually or start a new session.' };
  if (answerQueue.length >= 10) return { ok: false, message: 'Answer queue is full. Wait for an answer before submitting this question.' };
  const classification = classifyTurn(snapshot.text, { hasContext: !!lastQuestion });
  let question = snapshot.text;
  if (classification.kind === 'correction' && lastQuestion) question = `${lastQuestion}\nCorrection: ${snapshot.text}`;
  if (question.length > 8000) return { ok: false, message: 'Question is too long. Review it manually.' };
  if (classification.kind === 'correction') {
    clearQueue('superseded');
    if (cancelAnswer()) send('answer-cancelled');
  }
  const consumed = pendingBuffer.consume({ id: snapshot.id, revision: snapshot.revision });
  if (!consumed.ok) return { ok: false, message: 'This question changed or was already submitted.' };
  const candidate = { key, question, turnId: snapshot.id, revision: snapshot.revision, source: questionSource,
    sessionId, sessionMode: activeSessionMode, trigger, referenceQuestion: lastQuestion, transcriptSnapshot: transcriptContext(), answerContext: answerHistory.map(entry => ({...entry})), readyAt: Date.now(), settleMs: Math.max(0, Date.now() - snapshot.updatedAt) };
  submittedQuestions.set(key, 'queued'); answeredTurns.add(key);
  if (trigger !== 'auto') turnAssembler?.discardPending?.(questionSource);
  lastQuestion = question; lastQuestionTiming = candidate;
  send('question-preview', { text: '', pending: false });
  send('question', { text: question, turnId: snapshot.id, source: questionSource, trigger, settleMs: candidate.settleMs });
  recordDiagnostic('question-decision', 'Question submitted', { decision: 'accepted', questionId: snapshot.id, revision: snapshot.revision, trigger, text: question });
  answerQueue.push(candidate); syncQueue(); drainAutomatic();
  return { ok: true, message: requestController && answerQueue.includes(candidate) ? 'Question queued.' : 'Answer requested.' };
}
function waitForFinal(id) {
  if (!audioUnfinished.has(questionSource)) return Promise.resolve(true);
  const connection = speech.get(questionSource);
  if (!connection?.finalize?.()) return Promise.resolve(false);
  return new Promise(resolve => {
    let timer;
    const notify = forced => {
      if (forced !== false && live && sessionId === id && audioUnfinished.has(questionSource)) return;
      clearTimeout(timer); finalWaiters.delete(notify);
      resolve(forced !== false && live && sessionId === id && !audioUnfinished.has(questionSource));
    };
    finalWaiters.add(notify);
    timer = setTimeout(() => notify(false), settings.voiceFinalizeMs);
    notify();
  });
}
async function submitPending(trigger = 'hotkey') {
  if (!live) return { ok: false, message: 'Start listening to capture a question.' };
  if (trigger === 'voice' && !settings.voiceFallbackEnabled) return { ok: false, message: 'Voice fallback is off.' };
  if (pendingSubmission) return { ok: false, message: 'The pending question is already being submitted.' };
  const id = sessionId, operation = {}; pendingSubmission = operation;
  try {
    if (!await waitForFinal(id)) return { ok: false, message: 'Question transcript is incomplete. Check audio or use the keyboard/manual fallback.' };
    if (!live || id !== sessionId) return { ok: false, message: 'Listening session changed.' };
    const result = queueSnapshot(pendingBuffer.snapshot(), trigger);
    if (!result.ok) recordDiagnostic('question-decision', result.message, { decision: 'blocked', trigger });
    return result;
  } finally { if (pendingSubmission === operation) pendingSubmission = null; }
}
function rememberTurn(turn) {
  if (turn.source !== questionSource || !pendingBuffer) return;
  const classification = classifyTurn(turn.text, { hasContext: !!lastQuestion });
  pendingBuffer.observe({ ...turn, reason: turn.reason || classification.reason });
}
function beginTurns(id) {
  pendingBuffer = new PendingQuestionBuffer({ sessionId: id, source: questionSource, maxAgeMs: settings.voiceFreshnessMs, now: () => Date.now() });
  pendingBuffer.reset({ sessionId: id, source: questionSource });
  micCommands = new VoiceCommandMatcher({ phrases: settings.voiceCommandPhrases });
  turnAssembler = new TurnAssembler({ settleMs: settings.questionPauseMs, prefixMs: settings.incompletePauseMs,
    now: () => Date.now(), setTimer: setTimeout, clearTimer: clearTimeout, hasContext: () => !!lastQuestion,
    onUpdate: turn => { rememberTurn(turn); publishTurn(id, turn, true); },
    onTurn: turn => {
      if (!live || sessionId !== id) return;
      if (turn.reason === 'incomplete-audio') audioUnfinished.delete(turn.source);
      rememberTurn(turn); publishTurn(id, turn, false);
      if (turn.source !== questionSource) return;
      send('question-preview', { text: '', turnId: turn.id, pending: false });
      const snapshot = pendingBuffer.snapshot();
      const classification = classifyTurn(snapshot.text, { hasContext: !!lastQuestion });
      if (['acknowledgment', 'incomplete-audio', 'too-long'].includes(turn.reason) || !classification.question || !snapshot.canRecover) {
        recordDiagnostic('question-decision', 'Question held: ' + (turn.reason || classification.reason), { decision: 'held', reason: turn.reason || classification.reason, questionId: snapshot.id }); return;
      }
      if (settings.autoAnswer && !audioUnfinished.has(questionSource)) {
        const result = queueSnapshot(snapshot, 'auto');
        if (!result.ok) { recordDiagnostic('question-decision', result.message, { decision: 'blocked', trigger: 'auto' }); send('notice', { message: result.message }); }
      } else { lastQuestion = snapshot.text; send('question', { text: snapshot.text, turnId: snapshot.id, source: questionSource }); lastQuestionTiming = { question: snapshot.text, readyAt: Date.now() }; recordDiagnostic('question-decision', 'Pending question ready', { decision: 'ready', questionId: snapshot.id }); }
    } });
}
function trackFinalState(result) {
  let spans = audioUnfinished.get(result.source)?.spans || [];
  if (result.speechStarted || (!result.isFinal && result.text)) {
    const start = Number.isFinite(result.start) ? result.start : null;
    const existing = spans.find(span => span.start === start);
    if (existing) existing.hasText ||= !!result.text;
    else spans.push({ start, hasText: !!result.text });
    if (spans.length > 32) { markAudioGap(result.source, 'incomplete-audio'); return; }
  } else if (result.isFinal && result.text) {
    const end = Number.isFinite(result.start) ? result.start + (result.duration || 0) : null;
    spans = spans.filter(span => span.start !== null && end !== null
      && !(result.start <= span.start + 0.02 && end > span.start + 0.001));
  }
  if (spans.length) audioUnfinished.set(result.source, { spans, hasText: spans.some(span => span.hasText) });
  else audioUnfinished.delete(result.source);
}
function markAudioGap(source, reason = 'audio-gap') {
  audioUnfinished.delete(source);
  if (source === 'you') { micCommands?.reset(); clearTimeout(micCommandTimer); micCommandTimer = null; }
  if (source !== questionSource) return;
  sourceNeedsFresh.add(source); turnAssembler?.reset(source); pendingBuffer?.invalidate(reason); clearQueue(reason);
  for (const notify of [...finalWaiters]) notify(false);
  send('question-preview', { text: '', pending: false });
  recordDiagnostic('question-decision', 'Audio gap: repeat the full question or enter it manually.', { decision: 'incomplete', reason });
}
function forwardTranscript(id, result) {
  if (!live || id !== sessionId) return;
  if (result.source === 'you' && activeSessionMode === 'call' && !includeMicContext) return;
  if (sourceNeedsFresh.has(result.source)) {
    // Continuations such as 'Return its length' cannot repair an unknown gap.
    const freshStart = /^(?:(?:new|next) (?:question|problem)[\s:,.]+)?(?:what|why|how|explain|describe|design|implement|write|given|you are given|can you|could you|ek |aapko |आपको|एक )/i.test(result.text.trim());
    if (!result.isFinal || !freshStart) return;
    sourceNeedsFresh.delete(result.source);
  }
  trackFinalState(result);
  if (!result.isFinal && result.text) send('transcript', result);
  if (result.isFinal && result.text) recordDiagnostic('transcript-final', 'Finalized question audio', { source: result.source, text: result.text, audioStart: result.start, audioDuration: result.duration });
  turnAssembler?.push(result);
  for (const notify of [...finalWaiters]) notify();
}
function onTranscript(id, result) {
  if (!live || sessionId !== id || !speech.has(result.source)) return;
  // Never truncate a provider segment into an apparently complete task.
  if (typeof result.text === 'string' && result.text.length > 8000) {
    markAudioGap(result.source, 'too-long'); send('notice', { message: 'Question is too long. Review it manually.' }); return;
  }
  const text = typeof result.text === 'string' ? result.text : '';
  const input = { ...result, text };
  if (result.source !== 'you' || !settings.voiceFallbackEnabled) { forwardTranscript(id, input); return; }
  const matched = micCommands.push(input);
  clearTimeout(micCommandTimer); micCommandTimer = null;
  for (const part of matched.forward) forwardTranscript(id, part);
  if (matched.holding) micCommandTimer = setTimeout(() => {
    if (live && sessionId === id) for (const part of micCommands.flush().forward) forwardTranscript(id, part);
  }, settings.incompletePauseMs);
  if (matched.command) {
    if (activeSessionMode === 'practice') {
      const remaining = (audioUnfinished.get('you')?.spans || []).filter(span => span.hasText);
      if (remaining.length) audioUnfinished.set('you', { spans: remaining, hasText: true }); else audioUnfinished.delete('you');
      for (const notify of [...finalWaiters]) notify();
    }
    if (Date.now() - lastVoiceAt < settings.voiceCooldownMs) { reportVoice('ignored', 'Voice command already recognized.'); return; }
    lastVoiceAt = Date.now();
    reportVoice('recognized', 'Voice command recognized');
    submitPending('voice').then(result => {
      if (live && sessionId === id) reportVoice(result.ok ? 'submitted' : 'blocked', result.message);
    }).catch(error => { if (live && sessionId === id) reportVoice('blocked', safeError(error)); });
  }
}
function transcriptContext() {
  return history.slice(-55).map(x => `${x.source === 'remote' ? 'Other speaker' : 'You'}: ${x.text}`).join('\n').slice(-18000);
}
function answerPromptContext(candidate) {
  const transcript = candidate ? candidate.transcriptSnapshot : transcriptContext();
  const prior = candidate ? [...candidate.answerContext] : [...answerHistory];
  if (candidate?.referenceQuestion) {
    const completed = answerHistory.findLast(entry => entry.question === candidate.referenceQuestion);
    if (completed && !prior.some(entry => entry.question === completed.question && entry.text === completed.text)) prior.push(completed);
  }
  const reference = candidate?.referenceQuestion ? '\nPreceding question when this request was accepted (follow-up reference):\n' + candidate.referenceQuestion : '';
  return transcript + reference + (prior.length ? '\nPrevious assistant suggestions (unverified; for follow-up context):\n' + prior.slice(-3).map(x => `Question: ${x.question}\nSuggestion: ${x.text}`).join('\n').slice(-7000) : '');
}
async function ask(input = {}) {
  // Only completed turns originating in this process can trigger paid auto requests.
  if (input.automatic && (!automaticStillAllowed(input.candidate) || requestController || autoCount >= settings.maxAutoAnswers)) return { ok: false };
  if (!input.automatic) clearQueue('manual-replacement');
  const question = trim(input.question || lastQuestion, 10000).trim();
  if (!question) throw new Error('Type a question or wait for a completed question from the call.');
  if (!credentialIdentity()) throw new Error(missingAnswerProviderMessage());
  if (!validModel(settings.model)) throw new Error('Choose a valid main model for the selected provider in Setup.');
  if (!input.automatic && pendingBuffer) {
    const pending = pendingBuffer.snapshot();
    if (pending.canRecover && normalizedQuestion(pending.text) === normalizedQuestion(question)) pendingBuffer.consume({ id: pending.id, revision: pending.revision });
  }
  lastQuestion = question;
  const acceptedAt = Date.now(), identity = credentialIdentity(), generation = authGeneration, answerTimeoutMs = settings.answerTimeoutMs;
  const selectedProvider = settings.answerProvider, selectedBaseUrl = settings.compatibleBaseUrl;
  const availableModels = modelCatalog.status === 'ready' && modelCatalogIdentity === identity && Date.now() - modelCatalogAt < MODEL_CACHE_MS ? modelCatalog.models : [];
  const route = selectRoute({ question, provider: selectedProvider, model: settings.model, fastModel: settings.fastModel, adaptiveModels: settings.adaptiveModels, availableModels,
    mode: settings.mode, depth: settings.depth, previousQuestion: input.candidate?.referenceQuestion || answerHistory.at(-1)?.question });
  const referenceContext = settings.roleTitle || settings.roleDescription
    ? JSON.stringify({ candidateSummary: settings.context, roleTitle: settings.roleTitle, roleDescription: settings.roleDescription }) : settings.context;
  const answerSettings = { mode: settings.mode, depth: settings.depth, context: referenceContext };
  const timing = input.candidate || (lastQuestionTiming && normalizedQuestion(lastQuestionTiming.question) === normalizedQuestion(question) ? lastQuestionTiming : null);
  const settleMs = timing?.settleMs;
  const queueWaitMs = input.automatic && Number.isFinite(timing?.readyAt) ? Math.max(0, acceptedAt - timing.readyAt) : 0;
  let firstTextMs = null;
  cancelAnswer();
  const id = requestId;
  const controller = new AbortController(); requestController = controller;
  const timeout = setTimeout(() => controller.abort(), answerTimeoutMs);
  answers++;
  for (const [text, at] of recentAcceptedQuestions) if (Date.now() - at >= 12000) recentAcceptedQuestions.delete(text);
  recentAcceptedQuestions.set(normalizedQuestion(question), Date.now());
  if (input.automatic) { autoCount++; submittedQuestions.set(input.candidate.key, 'generating'); }
  send('answer-start', { id, question, automatic: !!input.automatic, answers, autoCount,
    provider: selectedProvider, model: route.model, routeKind: route.kind, trigger: input.candidate?.trigger || 'manual', settleMs, queueWaitMs });
  recordDiagnostic('answer-start', 'Request sent', { trigger: input.candidate?.trigger || 'manual', provider: selectedProvider, model: route.model, settleMs, queueWaitMs });
  try {
    let key = secrets[selectedProvider] || '';
    if (selectedProvider === 'chatgpt') {
      let selectedProfile = chatgptProfile;
      const accountIdentity = chatgptAccountIdentity(selectedProfile);
      if (selectedProfile.expires_at < Date.now() + 60000) {
        send('answer-phase', { id, phase: 'refreshing-auth' });
        selectedProfile = await refreshProfile(selectedProfile, { signal: controller.signal, persist: profile => {
          // Rotation may outlive this answer, but never an account replacement.
          if (generation !== authGeneration || chatgptAccountIdentity() !== accountIdentity || shutdown) return;
          chatgptProfile = profile; saveConfig();
        } });
      }
      if (id !== requestId || generation !== authGeneration || credentialIdentity() !== identity || controller.signal.aborted || !chatgptProfile) return { ok: false };
      key = selectedProfile.access_token;
    }
    if (id !== requestId || credentialIdentity() !== identity || controller.signal.aborted) return { ok: false };
    send('answer-phase', { id, phase: 'waiting-first-text' });
    const result = await streamProviderAnswer({ provider: selectedProvider, apiKey: key, baseUrl: selectedBaseUrl, model: route.model, reasoningEffort: route.reasoningEffort, concise: route.concise, question,
      transcript: answerPromptContext(input.candidate),
      ...answerSettings, signal: controller.signal,
      onDelta: text => {
        if (id !== requestId || credentialIdentity() !== identity) return;
        if (firstTextMs === null && typeof text === 'string' && text.trim()) {
          firstTextMs = Math.max(0, Date.now() - acceptedAt);
          recordDiagnostic('answer-timing', 'First useful answer text', { firstTextMs, provider: selectedProvider, model: route.model, settleMs, queueWaitMs });
        send('answer-timing', { id, firstTextMs, provider: selectedProvider, model: route.model, routeKind: route.kind, settleMs, queueWaitMs });
        }
        send('answer-delta', { id, text });
      } });
    if (id === requestId && credentialIdentity() === identity) {
      providerBlockedMessage = '';
      if (input.candidate) submittedQuestions.set(input.candidate.key, 'answered');
      answerHistory.push({ question, text: result.text.slice(0, 5000), provider: selectedProvider, model: route.model, routeKind: route.kind }); answerHistory = answerHistory.slice(-3);
      send('answer-done', { id, usage: result.usage, provider: selectedProvider, model: route.model, routeKind: route.kind, elapsedMs: Math.max(0, Date.now() - acceptedAt), firstTextMs, settleMs, queueWaitMs });
    }
  } catch (error) {
    if (id === requestId) {
      if (input.candidate) submittedQuestions.set(input.candidate.key, 'failed');
      recordDiagnostic('answer-error', safeError(error), { provider: selectedProvider, trigger: input.candidate?.trigger || 'manual' });
      send('answer-error', { id, message: controller.signal.aborted ? 'Answer interrupted or timed out. Partial text may be incomplete.' : safeError(error) });
      if (!controller.signal.aborted && ([400, 401, 403, 404, 429].includes(error?.status) || accessOrQuotaCodes.has(error?.code))) {
        providerBlockedMessage = 'Provider access or usage error. Check Setup and restart listening, or retry manually.';
        clearQueue('provider-blocked');
        pauseAutomatic('Automatic answers paused after a provider access or usage error. Check the error and your account/model settings before enabling Auto again.');
      }
    }
  } finally {
    clearTimeout(timeout);
    if (id === requestId) { requestController = null; drainAutomatic(); }
  }
  return { ok: true };
}
function registerIPC() {
  handle('auth:connect', async () => {
    if (live) throw new Error('Stop listening before connecting an account.');
    if (authController) throw new Error('Sign-in is already open in your browser.');
    const controller = new AbortController(); authController = controller;
    let generation = authGeneration;
    const isCurrent = () => authController === controller && generation === authGeneration && !controller.signal.aborted && !shutdown;
    if (cancelAnswer()) send('answer-cancelled');
    try {
      saveConfig();
      const profile = await beginSignIn({ hostId, profile: chatgptProfile || undefined, signal: controller.signal,
        openBrowser: url => { if (new URL(url).origin !== 'https://auth.openai.com') throw new Error('Unexpected authorization address.'); return shell.openExternal(url); },
        onStatus: message => { if (isCurrent()) send('auth-status', { message: typeof message === 'string' ? message : 'Complete sign-in in your browser.' }); },
        persist: profile => {
          if (!isCurrent()) return;
          // Advance only when replacement succeeds, so an earlier rotation can
          // still save usable credentials if browser sign-in is cancelled.
          generation = ++authGeneration;
          chatgptProfile = profile; if (settings.answerProvider === 'chatgpt') invalidateModelCatalog(); saveConfig();
        } });
      if (!isCurrent()) return { ok: false };
      if (profile.can_call_api) {
        try {
          const models = sanitizeModels(await listModels(profile, { signal: controller.signal }));
          if (!isCurrent()) return { ok: false };
          if (settings.answerProvider === 'chatgpt') cacheModelCatalog(models, credentialIdentity());
          if (models.length && !models.some(model => model.slug === settings.providerModels.chatgpt)) settings.providerModels.chatgpt = (models.find(model => /sol|mini|luna/.test(model.slug)) || models[0]).slug;
          if (settings.answerProvider === 'chatgpt') settings.model = settings.providerModels.chatgpt;
          saveConfig();
        } catch { if (isCurrent()) send('auth-status', { message: 'Connected. Model discovery failed; check the model name before asking.' }); }
      }
      if (!isCurrent()) return { ok: false };
      send('auth-complete', { settings: publicSettings(), message: profile.can_call_api ? 'ChatGPT plan connected. Live transcription still needs Deepgram.' : 'Signed in, but ChatGPT plan usage was not granted. Use an eligible plan or an API key.' });
      return { ok: true };
    } finally { if (authController === controller) authController = null; }
  });
  handle('auth:disconnect', async () => {
    if (live) throw new Error('Stop listening before disconnecting.');
    authGeneration++;
    const controller = authController; authController = null;
    controller?.abort(); if (cancelAnswer()) send('answer-cancelled');
    const old = chatgptProfile; chatgptProfile = null; if (settings.answerProvider === 'chatgpt') invalidateModelCatalog(); saveConfig();
    if (old) { try { await revokeProfile(old, { signal: AbortSignal.timeout(10000) }); } catch { send('notice', { message: 'Local sign-in removed. Review connected apps in ChatGPT settings if remote revocation was unavailable.' }); } }
    return publicSettings();
  });
  handle('auth:cancel', () => {
    const controller = authController; authController = null;
    controller?.abort();
    return publicSettings();
  });
  handle('settings:get', () => publicSettings());
  handle('content:state', () => contentState());
  handle('window:show-content', async value => {
    if (value !== undefined && (!value || typeof value !== 'object' || Array.isArray(value)
      || Object.keys(value).some(key => key !== 'hideConfig') || (Object.hasOwn(value, 'hideConfig') && typeof value.hideConfig !== 'boolean'))) throw new Error('Invalid content window request.');
    const visibility = ++contentVisibilityGeneration;
    const target = await createContentWindow();
    if (visibility !== contentVisibilityGeneration || shutdown || !win || win.isDestroyed()) return { ok: false };
    target.show(); target.focus();
    if (value?.hideConfig && win && !win.isDestroyed()) win.hide();
    return { ok: true };
  });
  handle('window:show-config', () => { showConfiguration(); return { ok: true }; });
  handle('window:resize-content', value => {
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !['width', 'height'].includes(key))
      || !Number.isFinite(value.width) || !Number.isFinite(value.height)) throw new Error('Content size must include finite width and height.');
    if (!contentWin || contentWin.isDestroyed()) throw new Error('Open the answer window before resizing it.');
    const bounds = contentWin.getBounds(), area = screen.getDisplayMatching(bounds).workArea;
    const width = Math.max(Math.min(520, area.width), Math.min(area.width, Math.round(value.width)));
    const height = Math.max(Math.min(420, area.height), Math.min(area.height, Math.round(value.height)));
    contentWin.setMinimumSize(Math.min(520, area.width), Math.min(420, area.height));
    contentWin.setBounds({ width, height, x: Math.max(area.x, Math.min(bounds.x, area.x + area.width - width)), y: Math.max(area.y, Math.min(bounds.y, area.y + area.height - height)) });
    const resized = contentWin.getBounds();
    return { width: resized.width, height: resized.height };
  });
  handle('window:hide-content', () => { contentVisibilityGeneration++; if (contentWin && !contentWin.isDestroyed()) contentWin.hide(); return { ok: true }; });
  handle('window:content-close', () => { closeContentWindow(); return { ok: true }; });
  handle('models:refresh', value => {
    if (value !== undefined && (!value || typeof value !== 'object' || Array.isArray(value)
      || Object.keys(value).some(key => key !== 'force') || (Object.hasOwn(value, 'force') && typeof value.force !== 'boolean'))) throw new Error('Invalid model refresh request.');
    return refreshModelCatalog(value);
  });
  handle('session:preferences', value => {
    if (!value || typeof value !== 'object' || Array.isArray(value)
      || Object.keys(value).some(key => !['sessionMode', 'autoAnswer'].includes(key))
      || (Object.hasOwn(value, 'sessionMode') && !allowedSessionModes.has(value.sessionMode))
      || (Object.hasOwn(value, 'autoAnswer') && typeof value.autoAnswer !== 'boolean')) throw new Error('Invalid session preferences.');
    if (live && Object.hasOwn(value, 'sessionMode')) throw new Error('Stop listening before changing between Call and Practice.');
    if (Object.hasOwn(value, 'sessionMode')) settings.sessionMode = value.sessionMode;
    if (Object.hasOwn(value, 'autoAnswer')) settings.autoAnswer = value.autoAnswer;
    if (!settings.autoAnswer) clearQueue('automatic-disabled', true);
    saveConfig();
    const current = publicSettings();
    send('session-preferences', { settings: current });
    return current;
  });
  handle('appearance:set', value => {
    settings.backgroundOpacity = clampOpacity(value);
    saveConfig();
    send('settings-changed', { settings: publicSettings() });
    return settings.backgroundOpacity;
  });
  handle('appearance:text-size', value => {
    settings.answerFontSize = clampTextSize(value);
    saveConfig();
    send('settings-changed', { settings: publicSettings() });
    return settings.answerFontSize;
  });
  handle('appearance:motion', value => {
    settings.motionEffects = value !== false;
    saveConfig();
    return settings.motionEffects;
  });
  handle('window:layout', focus => {
    if (typeof focus !== 'boolean') throw new Error('Invalid window layout.');
    const bounds = win.getBounds();
    if (focus && !workspaceBounds) workspaceBounds = bounds;
    const area = screen.getDisplayMatching(bounds).workArea;
    const desired = focus ? { ...bounds, width: 640, height: 690 } : (workspaceBounds || { ...bounds, width: 960, height: 760 });
    const width = Math.min(desired.width, area.width), height = Math.min(desired.height, area.height);
    win.setBounds({ width, height, x: Math.max(area.x, Math.min(desired.x, area.x + area.width - width)), y: Math.max(area.y, Math.min(desired.y, area.y + area.height - height)) });
    if (!focus) workspaceBounds = null;
    return focus;
  });
  handle('settings:save', value => {
    if (!profileStore.canSave) throw new Error(profileError || 'Profile is read-only. Restart after restoring the saved configuration.');
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid settings.');
    if (live) throw new Error('Stop listening before changing setup.');
    // Validate all provider fields before touching either settings or secrets.
    const nextTiming = {};
    for (const [field, range] of Object.entries(timingRanges)) {
      if (Object.hasOwn(value, field) && !Number.isFinite(value[field])) throw new Error('Timing settings must be finite numbers in milliseconds.');
      nextTiming[field] = Object.hasOwn(value, field) ? clampTiming(value[field], range) : settings[field];
    }
    nextTiming.incompletePauseMs = Math.max(Math.ceil(nextTiming.questionPauseMs / 500) * 500, nextTiming.incompletePauseMs);
    if (Object.hasOwn(value, 'answerProvider') && !answerProviders.has(value.answerProvider)) throw new Error('Choose a supported answer provider.');
    const provider = value.answerProvider || settings.answerProvider;
    const model = value.model === undefined ? settings.providerModels[provider] : typeof value.model === 'string' ? value.model.trim() : null;
    const fastModel = value.fastModel === undefined ? settings.providerFastModels[provider] : typeof value.fastModel === 'string' ? value.fastModel.trim() : null;
    if (!(provider === 'compatible' && model === '') && !validModel(model)) throw new Error('Model names must be 1–150 characters using letters, numbers, dots, dashes, underscores, colons or slashes.');
    if (fastModel !== '' && !validModel(fastModel)) throw new Error('Enter a valid fast model name, or leave it blank for automatic selection.');
    const rawBaseUrl = value.compatibleBaseUrl === undefined ? settings.compatibleBaseUrl : value.compatibleBaseUrl;
    if (typeof rawBaseUrl !== 'string') throw new Error('Enter a valid compatible API base URL.');
    const baseUrl = rawBaseUrl.trim() ? validateBaseUrl(rawBaseUrl.trim()) : '';
    const nextSecrets = { ...secrets };
    const clearFields = { openai: 'clearOpenAI', anthropic: 'clearAnthropic', gemini: 'clearGemini', compatible: 'clearCompatible', deepgram: 'clearDeepgram' };
    for (const name of Object.keys(secrets)) {
      const supplied = value[`${name}Key`] ?? value[name];
      if (supplied !== undefined && (typeof supplied !== 'string' || supplied.trim().length > 600 || /[\r\n]/.test(supplied.trim()))) throw new Error('API keys must be a single line of at most 600 characters.');
      if (value.clearKeys === true || value[clearFields[name]] === true) nextSecrets[name] = '';
      else if (typeof supplied === 'string' && supplied.trim()) nextSecrets[name] = supplied.trim();
    }
    const providerChanged = provider !== settings.answerProvider;
    const destinationChanged = provider === 'compatible' && baseUrl !== settings.compatibleBaseUrl;
    const conversationReset = providerChanged || destinationChanged;
    const credentialChanged = nextSecrets[provider] !== secrets[provider];
    const selectedChanged = providerChanged || model !== settings.model || fastModel !== settings.fastModel
      || credentialChanged || destinationChanged;
    const phrases = Object.hasOwn(value, 'voiceCommandPhrases') ? normalizeVoicePhrases(value.voiceCommandPhrases) : settings.voiceCommandPhrases;
    if (value.voiceFallbackEnabled !== undefined && typeof value.voiceFallbackEnabled !== 'boolean') throw new Error('Invalid voice fallback setting.');
    if (value.speechLanguage !== undefined && !['en', 'multi'].includes(value.speechLanguage)) throw new Error('Choose English or English + Hindi.');
    secrets = nextSecrets;
    settings.voiceCommandPhrases = phrases;
    if (typeof value.voiceFallbackEnabled === 'boolean') settings.voiceFallbackEnabled = value.voiceFallbackEnabled;
    if (value.speechLanguage) settings.speechLanguage = value.speechLanguage;
    settings.answerProvider = provider;
    settings.providerModels[provider] = model; settings.providerFastModels[provider] = fastModel;
    settings.model = model; settings.fastModel = fastModel; settings.compatibleBaseUrl = baseUrl;
    Object.assign(settings, nextTiming);
    if (selectedChanged) { if (cancelAnswer()) send('answer-cancelled'); invalidateModelCatalog(); }
    if (conversationReset) { resetTurns(); history = []; answerHistory = []; lastQuestion = ''; answers = 0; send('session-reset', { reason: 'provider-changed' }); }
    if (typeof value.adaptiveModels === 'boolean') settings.adaptiveModels = value.adaptiveModels;
    settings.mode = allowedModes.has(value.mode) ? value.mode : settings.mode;
    settings.depth = allowedDepths.has(value.depth) ? value.depth : settings.depth;
    settings.sessionMode = allowedSessionModes.has(value.sessionMode) ? value.sessionMode : settings.sessionMode;
    settings.context = trim(value.context ?? settings.context, 20000);
    settings.roleTitle = trim(value.roleTitle ?? settings.roleTitle, 200);
    settings.roleDescription = trim(value.roleDescription ?? settings.roleDescription, 8000);
    if (Object.hasOwn(value, 'answerFontSize')) settings.answerFontSize = clampTextSize(value.answerFontSize);
    if (Object.hasOwn(value, 'backgroundOpacity')) settings.backgroundOpacity = clampOpacity(value.backgroundOpacity);
    settings.autoAnswer = !!value.autoAnswer;
    settings.maxMinutes = Math.max(1, Math.min(60, Number(value.maxMinutes) || 30));
    settings.maxAutoAnswers = Math.max(1, Math.min(60, Number(value.maxAutoAnswers) || 20));
    saveConfig();
    send('settings-changed', { settings: publicSettings() });
    return { ...publicSettings(), providerChanged, conversationReset };
  });
  handle('listen:start', async value => {
    if (live) throw new Error('A listening session is already active.');
    if (authController) throw new Error('Finish or cancel ChatGPT sign-in before starting live transcription.');
    if (!secrets.deepgram) throw new Error('Add a Deepgram API key in Setup before starting live transcription.');
    const rate = Number(value?.sampleRate);
    if (![16000, 22050, 24000, 32000, 44100, 48000, 96000].includes(rate)) throw new Error('Unsupported audio sample rate.');
    resetTurns(); cancelAnswer();
    activeSessionMode = settings.sessionMode;
    questionSource = activeSessionMode === 'practice' ? 'you' : 'remote';
    live = true; captureAllowed = activeSessionMode === 'call'; const id = ++sessionId;
    startedAt = Date.now(); autoCount = 0; answers = 0; autoLimitNotice = false; lastQuestion = ''; history = []; answerHistory = [];
    send('session-reset', { reason: 'new-session' });
    includeMicContext = activeSessionMode === 'practice' || (value?.includeMicContext === undefined ? !!value?.microphone : value.includeMicContext === true);
    const sources = activeSessionMode === 'practice' ? ['you'] : ((value?.microphone || settings.voiceFallbackEnabled) ? ['remote', 'you'] : ['remote']);
    beginTurns(id);
    try {
      for (const source of sources) {
        const connection = new SpeechSession({ apiKey: secrets.deepgram, source, sampleRate: rate, language: settings.speechLanguage,
          onTranscript: data => onTranscript(id, data),
          onState: state => { if (live && sessionId === id) {
            send('speech-state', { source, state });
            if (state === 'reconnecting') markAudioGap(source);
            if (state === 'stopped') stopSession('Transcription ended. Start again to reconnect.');
          } },
          onError: message => { if (live && sessionId === id) { if (/dropped|missing|buffer full/i.test(message)) markAudioGap(source); recordDiagnostic('speech-error', message); send('notice', { message: safeError(message) }); } } });
        speech.set(source, connection);
        await connection.start();
        if (!live || id !== sessionId) { connection.stop(); throw new Error('Session cancelled.'); }
      }
      sessionTimer = setTimeout(() => { if (live && sessionId === id) stopSession('Session time limit reached.'); }, settings.maxMinutes * 60000);
      send('session-started', { sessionId: id, startedAt, maxMinutes: settings.maxMinutes, sources, sessionMode: activeSessionMode, questionSource });
      return { ok: true, sessionId: id, sources, sessionMode: activeSessionMode, questionSource };
    } catch (error) { if (id === sessionId) stopSession('Could not start transcription.'); throw new Error(safeError(error)); }
  });
  handle('listen:stop', () => { stopSession(); cancelAnswer(); return { ok: true }; });
  handle('capture:failed', message => { stopSession(trim(message, 250)); return { ok: true }; });
  handle('answer:ask', data => ask({ question: data?.question }));
  handle('answer:submit-pending', () => submitPending('hotkey'));
  handle('voice:test', value => {
    if (!value || typeof value.text !== 'string' || value.text.length > 8000) throw new Error('Enter a phrase of at most 8000 characters.');
    const result = detectVoiceCommand(value.text, { phrases: value.phrases === undefined ? settings.voiceCommandPhrases : normalizeVoicePhrases(value.phrases) });
    return { matched: result.matched, phrase: result.phrase, message: result.matched ? 'Phrase recognized. No request was sent.' : 'No command matched. No request was sent.' };
  });
  handle('diagnostics:get', () => ({ events: diagnosticsEvents.slice(), summary: 'Local session diagnostics. No raw audio or credentials.' }));
  handle('diagnostics:export', () => {
    const directory = path.join(dataDir, 'diagnostics'); fs.mkdirSync(directory, { recursive: true });
    const destination = path.join(directory, `diagnostics-${Date.now()}.json`);
    const json = JSON.stringify({ version: 1, app: 'prateekAi', exportedAt: Date.now(), events: diagnosticsEvents }, null, 2);
    // Do not truncate JSON with safeError; redact known credentials across the export.
    let clean = json;
    for (const secret of [...Object.values(secrets), chatgptProfile?.access_token, chatgptProfile?.refresh_token, chatgptProfile?.id_token]) if (secret) clean = clean.split(secret).join('[redacted]');
    fs.writeFileSync(destination, clean, { encoding: 'utf8', mode: 0o600 });
    return { ok: true, path: destination, message: 'Diagnostics exported locally. Review the transcript text before sharing.' };
  });
  handle('answer:cancel', () => { clearQueue('cancelled'); cancelAnswer(); send('answer-cancelled'); });
  handle('session:clear', () => { if (live) throw new Error('Stop listening before clearing the session.'); resetTurns(); cancelAnswer(); history = []; answerHistory = []; lastQuestion = ''; answers = 0; startedAt = 0; send('session-reset', { reason: 'cleared' }); return { ok: true }; });
  ipcMain.on('audio:chunk', (e, source, data) => {
    try {
      ensureSender(e, 'audio:chunk'); if (!live || !speech.has(source)) return;
      if (!(data instanceof ArrayBuffer) && !ArrayBuffer.isView(data)) return;
      if (data.byteLength > 192000) return;
      const chunk = data instanceof ArrayBuffer ? Buffer.from(data) : Buffer.from(data.buffer, data.byteOffset, data.byteLength);
      if (chunk.length > 0 && chunk.length <= 192000) speech.get(source)?.sendAudio(chunk);
    } catch { send('notice', { message: 'An audio chunk could not be sent.' }); }
  });
  ipcMain.on('window:minimize', e => { ensureSender(e, 'window:minimize'); win.minimize(); });
  ipcMain.on('window:close', e => { ensureSender(e, 'window:close'); win.close(); });
}
function secureWindow(target) {
  target.setContentProtection(true);
  target.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  target.webContents.on('will-navigate', event => event.preventDefault());
  target.webContents.on('context-menu', event => event.preventDefault());
  target.webContents.on('will-attach-webview', event => event.preventDefault());
}
function constrainWindow(target, minimumWidth, minimumHeight) {
  let adjusting = false;
  const constrain = () => {
    if (adjusting || target.isDestroyed()) return;
    const bounds = target.getBounds(), area = screen.getDisplayMatching(bounds).workArea;
    const width = Math.min(bounds.width, area.width), height = Math.min(bounds.height, area.height);
    const next = { width, height, x: Math.max(area.x, Math.min(bounds.x, area.x + area.width - width)), y: Math.max(area.y, Math.min(bounds.y, area.y + area.height - height)) };
    if (['x', 'y', 'width', 'height'].every(key => bounds[key] === next[key])) return;
    adjusting = true;
    try {
      target.setMinimumSize(Math.min(minimumWidth, area.width), Math.min(minimumHeight, area.height));
      target.setBounds(next);
    } finally { adjusting = false; }
  };
  target.on('resize', constrain); target.on('move', constrain);
}
function showConfiguration() {
  contentVisibilityGeneration++;
  if (contentWin && !contentWin.isDestroyed()) contentWin.hide();
  if (win && !win.isDestroyed()) { win.show(); win.focus(); }
}
function closeContentWindow() {
  stopSession('Content window closed. Listening stopped.');
  showConfiguration();
}
async function createContentWindow() {
  if (contentWindowPromise) return contentWindowPromise;
  if (contentWin && !contentWin.isDestroyed()) return contentWin;
  if (shutdown || !win || win.isDestroyed()) throw new Error('The configuration window has closed.');
  const area = screen.getDisplayMatching(win.getBounds()).workArea;
  const width = Math.min(740, area.width), height = Math.min(660, area.height);
  const target = new BrowserWindow({ width, height, minWidth: Math.min(520, area.width), minHeight: Math.min(420, area.height),
    x: Math.max(area.x, area.x + area.width - width - 24), y: Math.max(area.y, Math.min(area.y + 72, area.y + area.height - height)),
    resizable: true, maximizable: false, show: false, frame: false, transparent: true, backgroundColor: '#00000000',
    alwaysOnTop: !smoke && !captureTest, skipTaskbar: true,
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false,
      sandbox: true, webSecurity: true, spellcheck: false, devTools: false, backgroundThrottling: false } });
  contentWin = target;
  secureWindow(target); constrainWindow(target, 520, 420);
  target.on('close', event => { if (!shutdown) { event.preventDefault(); closeContentWindow(); } });
  target.on('closed', () => { if (contentWin === target) contentWin = null; });
  let opening;
  opening = (async () => {
    try {
      await target.loadURL(contentURL);
      if (shutdown || target.isDestroyed() || !win || win.isDestroyed()) throw new Error('The content window was closed.');
      return target;
    } catch (error) {
      if (!target.isDestroyed()) target.destroy();
      throw error;
    } finally { if (contentWindowPromise === opening) contentWindowPromise = null; }
  })();
  contentWindowPromise = opening;
  return opening;
}
async function createWindow() {
  Menu.setApplicationMenu(null);
  const area = screen.getPrimaryDisplay().workArea;
  win = new BrowserWindow({ width: Math.min(1000, area.width), height: Math.min(760, area.height), minWidth: Math.min(780, area.width), minHeight: Math.min(600, area.height), resizable: true, maximizable: false,
    show: false, frame: false, transparent: false, backgroundColor: '#0b1013', alwaysOnTop: false, skipTaskbar: false,
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false,
      sandbox: true, webSecurity: true, spellcheck: false, devTools: false, backgroundThrottling: false } });
  secureWindow(win); constrainWindow(win, 780, 600);
  const ses = win.webContents.session;
  ses.setPermissionRequestHandler((webContents, permission, callback, details) => {
    callback(webContents === win?.webContents && ['media', 'display-capture'].includes(permission) && details.requestingUrl === pageURL);
  });
  ses.setPermissionCheckHandler((webContents, permission) => webContents === win?.webContents && ['media', 'display-capture'].includes(permission));
  ses.setDisplayMediaRequestHandler(async (request, callback) => {
    try {
      if (!captureAllowed || request.frame?.url !== pageURL || request.frame !== win?.webContents.mainFrame) return callback({});
      const captureSessionId = sessionId;
      const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 0, height: 0 } });
      if (!sources.length || !captureAllowed || captureSessionId !== sessionId || request.frame?.url !== pageURL || request.frame !== win?.webContents.mainFrame) return callback({});
      callback({ video: sources[0], audio: 'loopback' });
    } catch { callback({}); }
  });
  await win.loadURL(pageURL);
  if (profileError) send('notice', { message: profileError });
  if (!smoke) win.show();
  if (process.argv.includes('--connect-chatgpt')) await win.webContents.executeJavaScript("document.getElementById('chatgptConnect')?.click()");
  win.on('closed', () => {
    contentVisibilityGeneration++;
    stopSession(); cancelAnswer(); win = null;
    if (contentWin && !contentWin.isDestroyed()) contentWin.destroy();
    app.quit();
  });
  globalShortcut.register('CommandOrControl+Shift+Space', async () => {
    if (hotkeyAnswerPending) return;
    hotkeyAnswerPending = true;
    const visibility = ++contentVisibilityGeneration;
    try {
      const target = await createContentWindow();
      if (visibility !== contentVisibilityGeneration || shutdown || !win || win.isDestroyed()) return;
      target.showInactive();
      send('hotkey-answer');
    } catch (error) { if (!shutdown) send('notice', { message: safeError(error) }); }
    finally { hotkeyAnswerPending = false; }
  });
  globalShortcut.register('CommandOrControl+Shift+H', () => {
    const target = contentWin && !contentWin.isDestroyed() ? contentWin : win;
    if (!target || target.isDestroyed()) return;
    contentVisibilityGeneration++;
    if (target.isVisible()) target.hide(); else target.showInactive();
  });
  if (smoke) {
    const out = process.env.PRATEEKAI_TEST_OUT || process.env.CALLSIDE_TEST_OUT || path.join(__dirname, 'test-output');
    fs.mkdirSync(out, { recursive: true });
    win.showInactive();
    await new Promise(resolve => setTimeout(resolve, 900));
    const result = await win.webContents.executeJavaScript('window.runSmokeTest()');
    await win.webContents.executeJavaScript('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
    result.contentProtectionRequested = win.isContentProtected();
    fs.writeFileSync(path.join(out, 'smoke.png'), (await win.webContents.capturePage()).toPNG());
    fs.writeFileSync(path.join(out, 'setup.png'), (await win.webContents.capturePage()).toPNG());
    const popup = await createContentWindow();
    popup.showInactive();
    const contentResult = await popup.webContents.executeJavaScript("typeof window.runContentSmokeTest === 'function' ? window.runContentSmokeTest() : { ok: false, smokeHelperMissing: true }");
    await popup.webContents.executeJavaScript('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
    contentResult.contentProtectionRequested = popup.isContentProtected();
    fs.writeFileSync(path.join(out, 'content-smoke.json'), JSON.stringify(contentResult, null, 2));
    fs.writeFileSync(path.join(out, 'content.png'), (await popup.webContents.capturePage()).toPNG());
    result.contentWindow = contentResult;
    result.ok = result.ok && contentResult.ok && contentResult.contentProtectionRequested;
    fs.writeFileSync(path.join(out, 'smoke.json'), JSON.stringify(result, null, 2));
    app.exit(result.ok ? 0 : 1);
  }
  if (captureTest) {
    const out = process.env.PRATEEKAI_TEST_OUT || process.env.CALLSIDE_TEST_OUT || path.join(__dirname, 'test-output');
    fs.mkdirSync(out, { recursive: true });
    captureAllowed = true;
    await win.webContents.executeJavaScript('window.installCaptureTestMarker()');
    await new Promise(resolve => setTimeout(resolve, 700));
    const bitmap = (await win.webContents.capturePage()).getBitmap();
    let localMarkerPixels = 0;
    for (let i = 0; i < bitmap.length; i += 4) if (bitmap[i + 2] > 247 && bitmap[i + 1] < 17 && bitmap[i] > 196 && bitmap[i] < 205) localMarkerPixels++;
    const result = await win.webContents.executeJavaScript('window.runCaptureTest()', true);
    result.localMarkerPixels = localMarkerPixels;
    result.protectedMarkerAbsent = localMarkerPixels > 5000 && result.desktopMarkerPixels === 0;
    result.contentProtectionRequested = win.isContentProtected();
    result.ok = result.ok && result.protectedMarkerAbsent;
    fs.writeFileSync(path.join(out, 'capture.json'), JSON.stringify(result, null, 2));
    captureAllowed = false;
    app.exit(result.ok ? 0 : 1);
  }
}
app.whenReady().then(() => { readConfig(); registerIPC(); return createWindow(); }).catch(error => {
  fs.mkdirSync(dataDir, { recursive: true }); fs.writeFileSync(path.join(dataDir, 'startup-error.txt'), safeError(error)); app.exit(1);
});
app.on('window-all-closed', () => app.quit());
app.on('before-quit', () => { if (shutdown) return; shutdown = true; authGeneration++; authController?.abort(); modelCatalogRequest?.controller.abort(); stopSession(); cancelAnswer(); globalShortcut.unregisterAll(); });
