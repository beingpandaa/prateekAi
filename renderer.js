'use strict';
const $ = id => document.getElementById(id);
const api = window.prateekAi;
let config, live = false, starting = false, streams = [], nodes = [], audioContext;
let captureEpoch = 0, timerInterval, startedAt, selectedMode = 'auto', selectedDepth = 'auto';
let authAttempt = 0;
let answerBusy = false, savingSettings = false;
let sessionMode = 'call', callMic = false, preferencesBusy = false;
let nextQuestion = '', latestDetectedQuestion = '';
let modelRefreshBusy = false, modelRefreshId = 0, modelCatalog = null;
let selectedProvider = 'chatgpt', draftModels = {}, draftFastModels = {};
const PROVIDERS = {
  chatgpt: { label: 'ChatGPT plan', model: 'gpt-5.6-sol', help: 'Use the supported ChatGPT connection with an eligible plan. Availability and usage limits depend on your account and workspace.' },
  openai: { label: 'OpenAI API', model: 'gpt-5.6-sol', help: 'Use a developer API key from OpenAI Platform. API billing is separate from your ChatGPT subscription.' },
  anthropic: { label: 'Claude API', model: 'claude-sonnet-5-5', help: 'Use a key from Claude Console. This connection uses developer API billing, separately from a Claude subscription.' },
  gemini: { label: 'Gemini API', model: 'gemini-3.8-flash', help: 'Use a Gemini API key from Google AI Studio. API quotas, model access and any free allowance depend on your project.' },
  compatible: { label: 'Other / local', model: '', help: 'Connect your own compatible service, such as a hosted provider or a local model server. Only this selected service receives answer requests.' },
};
const QUICK_MODELS = {
  chatgpt: ['gpt-6-luna', 'gpt-5.6-luna'], openai: ['gpt-6-luna', 'gpt-5.6-luna'],
  anthropic: ['claude-haiku-4-5', 'claude-haiku-4-5-20251001'],
  gemini: ['gemini-3.5-flash-lite', 'gemini-3.1-flash-lite', 'gemini-2.5-flash-lite'], compatible: [],
};
function providerLabel(provider) { return PROVIDERS[provider]?.label || 'Cloud AI'; }
function answerProviderReady(value) {
  if (typeof value.hasAnswerProvider === 'boolean') return value.hasAnswerProvider;
  return !!(value.hasOpenAI || value.chatgptCanCall);
}
function providerDraftNeedsSave() {
  return selectedProvider !== (config?.answerProvider || 'openai') ||
    (selectedProvider !== 'chatgpt' && !!$(selectedProvider + 'Key').value.trim()) ||
    (selectedProvider === 'compatible' && $('compatibleBaseUrl').value.trim() !== (config?.compatibleBaseUrl || ''));
}
function chooseProvider(provider, remember = true) {
  if (!PROVIDERS[provider]) return;
  if (remember) { draftModels[selectedProvider] = $('model').value; draftFastModels[selectedProvider] = $('fastModel').value; }
  selectedProvider = provider;
  $('model').value = draftModels[provider] ?? PROVIDERS[provider].model;
  $('fastModel').value = draftFastModels[provider] || '';
  document.querySelectorAll('[data-provider]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.provider === provider)));
  document.querySelectorAll('[data-provider-key]').forEach(panel => panel.classList.toggle('hidden', panel.dataset.providerKey !== provider));
  $('chatgptConnection').classList.toggle('hidden', provider !== 'chatgpt');
  $('providerHelp').textContent = PROVIDERS[provider].help;
  $('selectedProviderLabel').textContent = `Answers from ${providerLabel(provider)}`;
  $('modelFilter').value = '';
  showModelCatalog(modelCatalog || { status: 'unavailable', models: [] });
  if (remember) $('settingsMessage').textContent = 'Save setup to use this provider. Other connections stay saved.';
}
function showConnectionStatus(value) {
  for (const [name, saved] of [['openai', value.hasOpenAI], ['anthropic', value.hasAnthropic], ['gemini', value.hasGemini], ['compatible', value.hasCompatible], ['deepgram', value.hasDeepgram]]) {
    $(name + 'Key').placeholder = saved ? 'Saved · leave blank to keep' : 'Not connected';
  }
  if (value.chatgptConnected) $('chatgptStatus').textContent = `Connected${value.chatgptLabel ? ` · ${value.chatgptLabel}` : ''}. ${value.chatgptCanCall ? 'Plan access enabled.' : 'Plan usage is not enabled.'}`;
  else $('chatgptStatus').textContent = 'Requires an eligible ChatGPT plan and permission from the selected workspace. Access is not guaranteed.';
  $('chatgptDisconnect').classList.toggle('hidden', !value.chatgptConnected);
}
function applyConnectionUpdate(value) {
  const autoDraft = $('autoAnswer').checked, preserveAutoDraft = autoDraft !== !!config?.autoAnswer;
  const previous = config?.providerModels?.chatgpt || (config?.answerProvider === 'chatgpt' ? config.model : PROVIDERS.chatgpt.model);
  const currentDraft = selectedProvider === 'chatgpt' ? $('model').value : (draftModels.chatgpt ?? previous);
  const next = value.providerModels?.chatgpt || (value.answerProvider === 'chatgpt' ? value.model : previous);
  if (currentDraft === previous) { draftModels.chatgpt = next; if (selectedProvider === 'chatgpt') $('model').value = next; }
  config = value; showConnectionStatus(value); applySessionPreferences(value);
  if (preserveAutoDraft) { $('autoAnswer').checked = autoDraft; $('maxAutoAnswers').disabled = !autoDraft; }
}
function hasUnsavedSetup() {
  if (!config) return false;
  if (providerDraftNeedsSave() || $('deepgramKey').value.trim()) return true;
  const fields = {
    model: $('model').value.trim(), fastModel: $('fastModel').value.trim(),
    mode: selectedMode, depth: selectedDepth, context: $('context').value,
    roleTitle: $('roleTitle').value, roleDescription: $('roleDescription').value,
    autoAnswer: $('autoAnswer').checked, adaptiveModels: $('adaptiveModels').checked,
    maxMinutes: Number($('maxMinutes').value), maxAutoAnswers: Number($('maxAutoAnswers').value),
    questionPauseMs: Number($('questionPauseMs').value), incompletePauseMs: Number($('incompletePauseMs').value), answerTimeoutMs: Number($('answerTimeoutMs').value)
  };
  const defaults = {fastModel:'',mode:'auto',depth:'auto',context:'',roleTitle:'',roleDescription:'',autoAnswer:false,adaptiveModels:true,questionPauseMs:800,incompletePauseMs:6500,answerTimeoutMs:75000};
  return Object.entries(fields).some(([name,value]) => value !== (config[name] ?? defaults[name]));
}
function requireSavedSetup() {
  if (!hasUnsavedSetup()) return true;
  notice('Save setup to apply your changes before opening answers or starting a session.');
  $('settingsMessage').textContent = 'Unsaved changes — select Save setup first.';
  $('save').focus(); return false;
}
function renderTimingSettings() {
  const pause = Number($('questionPauseMs').value), timeout = Number($('answerTimeoutMs').value);
  if (Number($('incompletePauseMs').value) < pause) $('incompletePauseMs').value = Math.ceil(pause / 500) * 500;
  const prefix = Number($('incompletePauseMs').value);
  $('questionPauseValue').textContent = `${(pause / 1000).toFixed(1)} s`;
  $('incompletePauseValue').textContent = `${(prefix / 1000).toFixed(1)} s`;
  $('answerTimeoutValue').textContent = `${timeout / 1000} s`;
  $('timingPresetBadge').textContent = pause === 800 && prefix === 6500 && timeout === 75000 ? 'Recommended defaults' : 'Custom timing';
  $('questionPauseOutcome').textContent = pause < 700 ? 'Faster · more likely to split a question during a pause.' : pause <= 1100 ? 'Balanced · recommended starting range: 0.7–1.1 seconds.' : 'More patient · joins longer pauses, with a slower response.';
  $('incompletePauseOutcome').textContent = prefix < 4500 ? 'Short window · a long hesitation may lose the first fragment.' : prefix <= 8000 ? 'Patient with incomplete phrases · recommended: 6.5 seconds.' : 'Long window · holds unfinished fragments for longer.';
  $('answerTimeoutOutcome').textContent = timeout < 45000 ? 'Stops sooner · complex answers may be cut short.' : timeout <= 90000 ? 'Balanced time allowance · recommended: 75 seconds.' : 'Longer allowance · slower requests can occupy the answer slot longer.';
}
function renderModelList() {
  const list = $('modelList'); list.replaceChildren();
  const query = $('modelFilter').value.trim().toLowerCase();
  const catalogMatches = !providerDraftNeedsSave() && (!modelCatalog?.provider || modelCatalog.provider === selectedProvider);
  const models = catalogMatches ? (modelCatalog?.models || []).filter(model => `${model.slug} ${model.display_name || ''}`.toLowerCase().includes(query)) : [];
  for (const model of models.slice(0, 80)) {
    const row = document.createElement('div'); row.className = 'model-choice';
    const name = document.createElement('span'); name.textContent = model.slug; row.append(name);
    for (const [target, label] of [['model', 'Main'], ['fastModel', 'Quick']]) {
      const button = document.createElement('button'); button.className = 'text-button'; button.textContent = label;
      button.setAttribute('aria-label', `Use ${model.slug} for ${label.toLowerCase()} answers`);
      button.addEventListener('click', () => { $(target).value = model.slug; showModelCatalog(modelCatalog); $('settingsMessage').textContent = 'Model selected. Save setup to apply it.'; });
      row.append(button);
    }
    list.append(row);
  }
  if (!models.length) { const text = document.createElement('p'); text.className = 'small muted'; text.textContent = catalogMatches ? 'No matching models. You can enter a model ID above.' : 'Save this connection, then refresh its models.'; list.append(text); }
  else if (models.length > 80) { const text = document.createElement('p'); text.className = 'small muted'; text.textContent = 'Showing the first 80 models. Search to narrow the list.'; list.append(text); }
}
const seconds = ms => `${(Math.max(0, ms) / 1000).toFixed(1)}s`;
function showModelCatalog(value) {
  modelCatalog = value;
  const available = (value.models || []).map(model => model.slug);
  const requestedFast = $('fastModel').value.trim();
  const fast = requestedFast ? (available.includes(requestedFast) ? requestedFast : null) : QUICK_MODELS[selectedProvider].find(model => available.includes(model));
  $('modelCatalogStatus').textContent = providerDraftNeedsSave() || (value.provider && value.provider !== selectedProvider) ? 'Save this connection before checking its available models.'
    : !$('adaptiveModels').checked ? 'Adaptive routing is off. Every question uses your main model.'
    : value.status === 'loading' ? 'Checking models available to your account…'
    : value.status === 'ready' ? (fast ? `Simple questions: ${fast}. Complex questions: your main model.` : 'No confirmed quick model. Simple questions use brief answers on your main model.')
      : (value.message || 'Model list unavailable. Answers can continue using your main model.');
  renderModelList();
}
async function refreshModels(force = false) {
  if (providerDraftNeedsSave()) { showModelCatalog(modelCatalog || { status: 'unavailable', models: [] }); return; }
  if (modelRefreshBusy && !force) return;
  const request = ++modelRefreshId;
  modelRefreshBusy = true; $('refreshModels').disabled = true; $('refreshModels').textContent = 'Checking…';
  try { const result = await api.refreshModels(force); if (request === modelRefreshId) showModelCatalog(result); }
  catch { if (request === modelRefreshId) showModelCatalog({ status: 'unavailable', models: [], message: 'Model list unavailable. Answers can continue using your main model.' }); }
  finally { if (request === modelRefreshId) { modelRefreshBusy = false; $('refreshModels').disabled = false; $('refreshModels').textContent = 'Refresh models'; } }
}
function syncSessionControls() {
  const practice = sessionMode === 'practice';
  document.querySelectorAll('[data-session-mode]').forEach(button => {
    button.setAttribute('aria-pressed', String(button.dataset.sessionMode === sessionMode));
    button.disabled = live || starting || preferencesBusy || savingSettings;
  });
  $('includeMic').checked = practice || callMic;
  $('includeMic').disabled = practice || live || starting || preferencesBusy || savingSettings;
  $('micLabel').textContent = practice ? 'Microphone only' : 'Include my microphone';
  $('liveAutoAnswer').checked = !!config?.autoAnswer;
  $('liveAutoAnswer').disabled = starting || preferencesBusy || savingSettings;
  $('listen').disabled = starting || preferencesBusy || savingSettings;
  $('openContent').disabled = starting || savingSettings;
  syncConfigurationLock(); updateFlowHint();
}
function updateFlowHint() {
  if (!config?.autoAnswer) $('flowHint').textContent = 'Auto-answer off · use Ask for a manual answer.';
  else if (nextQuestion) $('flowHint').textContent = answerBusy ? 'Listening to the next question…' : 'Finishing the question…';
  else $('flowHint').textContent = `${sessionMode === 'practice' ? 'Your microphone' : 'Other speaker'} → automatic answers`;
}
function applySessionPreferences(value, preserveDraft = true) {
  const autoDraft = $('autoAnswer').checked;
  const retainAutoDraft = preserveDraft && autoDraft !== !!config?.autoAnswer && !!value.autoAnswer === !!config?.autoAnswer;
  config = { ...config, ...value };
  sessionMode = value.sessionMode === 'practice' ? 'practice' : 'call';
  $('autoAnswer').checked = retainAutoDraft ? autoDraft : !!value.autoAnswer;
  $('maxAutoAnswers').disabled = !$('autoAnswer').checked;
  $('modeLabel').textContent = `${providerLabel(config.answerProvider)} · ${value.autoAnswer ? 'automatic answers' : 'manual answers'}`;
  syncSessionControls();
}
async function changeSessionPreferences(value) {
  if (preferencesBusy || starting || savingSettings || (value.sessionMode && live)) return;
  preferencesBusy = true; syncSessionControls();
  try {
    applySessionPreferences(await api.sessionPreferences(value));
    notice(value.autoAnswer === undefined
      ? (sessionMode === 'practice' ? 'Mic practice: ask aloud. Only your microphone is transcribed.' : 'Live call: questions come from computer audio. Use headphones if including your microphone.')
      : (config.autoAnswer ? 'Auto-answer on. Completed questions will be answered without clicking Ask.' : 'Auto-answer off. Listening can continue; use Ask whenever you need an answer.'));
  } catch (error) { notice(error.message); }
  finally { preferencesBusy = false; syncSessionControls(); }
}

function syncConfigurationLock() {
 const locked = live || starting || savingSettings;
 $('configurationFields').disabled = locked;
 $('save').disabled = locked; $('forgetKeys').disabled = locked;
 $('configurationLock').classList.toggle('hidden', !live && !starting);
}
const labelSource = source => source === 'you' ? 'You' : 'Other speaker';
function notice(message) { $('notice').textContent = message; $('notice').classList.toggle('hidden', !message); }
function setStatus(text, kind = '') { $('sessionStatus').textContent = text; $('statusDot').className = 'dot ' + kind; }
function addTranscript(source,text,turnId) {
 $('transcriptEmpty')?.remove();
 const existing = turnId && [...$('transcript').children].find(row=>row.dataset.turnId===turnId);
 if (existing) { existing.querySelector('p').textContent=text; return; }
 const row=document.createElement('div'); row.className='transcript-item'; if(turnId) row.dataset.turnId=turnId;
 const name=document.createElement('strong'); name.textContent=labelSource(source);
 const paragraph=document.createElement('p'); paragraph.textContent=text; row.append(name,paragraph); $('transcript').append(row);
 while($('transcript').children.length>120) $('transcript').firstChild.remove();
}
function applyAppearance(value) { const opacity=Math.max(45,Math.min(100,Number(value)||92)); $('backgroundOpacity').value=opacity; $('opacityValue').textContent=opacity+'%'; }
function applyTextSize(value) { const size=Math.max(16,Math.min(26,Number(value)||20)); $('answerFontSize').value=size; $('textSizeValue').textContent=size+' px'; }
function resetSessionView() { nextQuestion=''; answerBusy=false; $('transcript').replaceChildren(); $('interim').textContent=''; $('usage').textContent='0 answers'; updateFlowHint(); }
function showSettings() { selectSetupTab('connections'); }
async function releaseCapture() {
  captureEpoch++;
  live = false; starting = false; clearInterval(timerInterval);
  for (const stream of streams) for (const track of stream.getTracks()) { track.onended = null; track.stop(); }
  streams = [];
  for (const node of nodes) { try { node.disconnect(); if (node.port) node.port.close(); } catch {} }
  nodes = [];
  const context = audioContext; audioContext = null;
  $('listen').textContent = 'Start listening'; $('listen').disabled = false;
  nextQuestion = ''; syncSessionControls(); $('audioLevel').classList.remove('active');
  $('remoteState').textContent = 'Call audio: off'; $('micState').textContent = 'Microphone: off';
  if (context) await context.close().catch(() => {});
}
function connectAudio(stream, source, epoch, context) {
  const input = context.createMediaStreamSource(stream);
  const recorder = new AudioWorkletNode(context, 'pcm-recorder');
  const silent = context.createGain(); silent.gain.value = 0;
  recorder.port.onmessage = event => {
    if (!live || epoch !== captureEpoch) return;
    api.audio(source, event.data.pcm);
    if (source === (sessionMode === 'practice' ? 'you' : 'remote')) $('audioLevel').classList.toggle('active', event.data.peak > .005);
  };
  input.connect(recorder).connect(silent).connect(context.destination);
  nodes.push(input, recorder, silent);
  const audioTrack = stream.getAudioTracks()[0];
  if (!audioTrack) throw new Error('No audio track was captured. Check the Windows output device.');
  audioTrack.onended = () => {
    if (live && epoch === captureEpoch) { notice('Audio capture ended. Check your device and start again.'); api.captureFailure('Audio device disconnected.').catch(() => {}); releaseCapture(); }
  };
}
async function startListening() {
  if (starting || preferencesBusy || savingSettings) return;
  if (live) {
    $('listen').disabled = true; $('listen').textContent = 'Stopping…';
    try { await api.stop(); } catch (error) { $('listen').disabled = false; $('listen').textContent = 'Stop listening'; throw error; }
    return;
  }
  if (!requireSavedSetup()) return;
  starting = true; syncSessionControls(); $('listen').textContent = 'Connecting…';
  notice('');
  const epoch = ++captureEpoch;
  try {
    config = await api.settings();
    if (epoch !== captureEpoch) return;
    if (!config.hasDeepgram) { starting = false; syncSessionControls(); $('listen').textContent = 'Start listening'; showSettings(); $('settingsMessage').textContent = 'A Deepgram key is required for live transcription. The answer window includes an offline example.'; return; }
    if (config.autoAnswer && !answerProviderReady(config)) {
      starting = false; syncSessionControls(); $('listen').textContent = 'Start listening'; showSettings();
      $('settingsMessage').textContent = 'Auto-answer needs a connected answer provider. Choose your provider, connect its account or key, and save setup. No speech stream was opened.';
      return;
    }
    sessionMode = config.sessionMode === 'practice' ? 'practice' : 'call';
    const practice = sessionMode === 'practice';
    const microphone = practice || callMic;
    nextQuestion = ''; latestDetectedQuestion = ''; syncSessionControls();
    setStatus('Connecting…');
    try { audioContext = new AudioContext({ sampleRate: 16000 }); } catch { audioContext = new AudioContext(); }
    const context = audioContext;
    await context.audioWorklet.addModule('./pcm-worklet.js');
    if (epoch !== captureEpoch) return;
    await context.resume();
    if (epoch !== captureEpoch) return;
    await api.start({ sampleRate: context.sampleRate, microphone });
    if (epoch !== captureEpoch) return;
    $('transcript').replaceChildren(); $('interim').textContent = '';
    if (!practice) {
      const remote = await navigator.mediaDevices.getDisplayMedia({ audio: true, video: { frameRate: 1, width: 320, height: 240 } });
      if (epoch !== captureEpoch) { remote.getTracks().forEach(t => t.stop()); return; }
      streams.push(remote);
      remote.getVideoTracks().forEach(track => { track.enabled = false; });
      if (!remote.getAudioTracks().length) throw new Error('Windows did not provide system audio. Select a working playback device and retry.');
      connectAudio(remote, 'remote', epoch, context);
    }
    live = true;
    if (microphone) {
      const mic = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }, video: false });
      if (epoch !== captureEpoch) { mic.getTracks().forEach(t => t.stop()); return; }
      streams.push(mic); connectAudio(mic, 'you', epoch, context);
    }
    starting = false; syncSessionControls(); $('listen').textContent = 'Stop listening';
    setStatus('Listening', 'live'); startedAt ||= Date.now();
    $('timer').textContent = '00:00';
    timerInterval = setInterval(() => { const seconds = Math.floor((Date.now() - startedAt) / 1000); $('timer').textContent = `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`; }, 500);
    notice(config.autoAnswer
      ? (practice ? 'Ask aloud, then pause. Your complete question will be answered automatically.' : 'Listening to the other speaker. Completed questions will be answered automatically.')
      : 'Auto-answer is off. Use Ask in the answer window.');
    await api.showContent({ hideConfig: true });
  } catch (error) {
    if (epoch !== captureEpoch) return;
    await api.stop().catch(() => {}); await releaseCapture(); notice(error.message); setStatus('Ready when you are');
  }
}
function applySettings(value) {
  config = value; selectedMode = value.mode; selectedDepth = value.depth || 'auto';
  applySessionPreferences(value, false);
  applyAppearance(value.backgroundOpacity);
  applyTextSize(value.answerFontSize);
  $('roleTitle').value = value.roleTitle || ''; $('roleDescription').value = value.roleDescription || '';
  draftModels = { ...value.providerModels }; draftFastModels = { ...value.providerFastModels };
  const provider = value.answerProvider || 'openai';
  draftModels[provider] = value.model; draftFastModels[provider] = value.fastModel || '';
  $('compatibleBaseUrl').value = value.compatibleBaseUrl || '';
  $('context').value = value.context || '';
  $('maxMinutes').value = value.maxMinutes; $('maxAutoAnswers').value = value.maxAutoAnswers;
  $('autoAnswer').checked = value.autoAnswer;
  $('adaptiveModels').checked = value.adaptiveModels !== false;
  $('questionPauseMs').value = value.questionPauseMs ?? 800;
  $('incompletePauseMs').value = value.incompletePauseMs ?? 6500;
  $('answerTimeoutMs').value = value.answerTimeoutMs ?? 75000;
  renderTimingSettings();
  $('maxAutoAnswers').disabled = !value.autoAnswer;
  chooseProvider(provider, false); showConnectionStatus(value);
  $('privacyStatus').textContent = value.protectionRequested ? 'Capture protection requested' : 'Capture protection unavailable';
  $('keyStorage').textContent = value.encryptedStorage ? 'Saved keys are encrypted with Windows. Context is saved locally; transcripts stay in memory until cleared or closed.' : 'Encrypted storage unavailable. Keys will only be kept for this app session.';
  document.querySelectorAll('[data-mode]').forEach(button => button.classList.toggle('selected', button.dataset.mode === value.mode));
  document.querySelectorAll('[data-depth]').forEach(button => button.classList.toggle('selected', button.dataset.depth === selectedDepth));
}
function selectSetupTab(name) {
  document.querySelector('.settings-card').dataset.activeTab = name;
  document.querySelectorAll('[data-setup-tab]').forEach(button => {
    const selected = button.dataset.setupTab === name;
    button.setAttribute('aria-selected', String(selected)); button.tabIndex = selected ? 0 : -1;
    $(button.getAttribute('aria-controls')).classList.toggle('hidden', !selected);
  });
  document.querySelector('.setup-content').scrollTop = 0;
}
async function saveSettings(clearKeys = false) {
  if (savingSettings || live || starting) return;
  savingSettings = true;
  syncSessionControls();
  $('save').disabled = true; $('forgetKeys').disabled = true; syncConfigurationLock();
  $('save').textContent = 'Saving…'; $('settingsMessage').textContent = 'Saving setup…';
  try {
    const credentials = { deepgramKey: $('deepgramKey').value };
    if (selectedProvider !== 'chatgpt') credentials[selectedProvider + 'Key'] = $(selectedProvider + 'Key').value;
    const value = await api.saveSettings({ ...credentials, answerProvider: selectedProvider, compatibleBaseUrl: $('compatibleBaseUrl').value,
      model: $('model').value, fastModel: $('fastModel').value, adaptiveModels: $('adaptiveModels').checked, mode: selectedMode, depth: selectedDepth, context: $('context').value, roleTitle: $('roleTitle').value, roleDescription: $('roleDescription').value, autoAnswer: $('autoAnswer').checked,
      maxMinutes: Number($('maxMinutes').value), maxAutoAnswers: Number($('maxAutoAnswers').value),
      questionPauseMs: Number($('questionPauseMs').value), incompletePauseMs: Number($('incompletePauseMs').value), answerTimeoutMs: Number($('answerTimeoutMs').value), clearKeys });
    if (clearKeys) for (const name of ['openai', 'anthropic', 'gemini', 'compatible', 'deepgram']) $(name + 'Key').value = '';
    else { if (selectedProvider !== 'chatgpt') $(selectedProvider + 'Key').value = ''; $('deepgramKey').value = ''; }
    applySettings(value);
    notice('');
    if (value.providerChanged || value.conversationReset) {
      resetSessionView();
    }
    $('settingsMessage').textContent = clearKeys ? 'Saved API keys removed.' : value.providerChanged || value.conversationReset ? 'Setup saved. Previous conversation cleared for the new provider.' : 'Setup saved.';
    refreshModels(true);
  } catch (error) { $('settingsMessage').textContent = error.message; }
  finally { savingSettings = false; syncSessionControls(); $('save').textContent = 'Save setup'; }
}

api.onEvent(event => {
 if(event.type==='notice') notice(event.message);
 if(event.type==='model-catalog') showModelCatalog(event);
 if(event.type==='session-preferences') applySessionPreferences(event.settings);
 if(event.type==='session-started') startedAt = event.startedAt || Date.now();
 if(event.type==='settings-changed') { config={...config,...event.settings}; applyAppearance(config.backgroundOpacity); applyTextSize(config.answerFontSize); }
 if(event.type==='session-reset') resetSessionView();
 if(event.type==='session-stopped') { answerBusy=false; releaseCapture(); setStatus(event.reason || 'Listening stopped'); }
 if(event.type==='speech-state') { $(event.source==='remote'?'remoteState':'micState').textContent=(event.source==='remote'?'Call audio: ':'Microphone: ')+event.state; if(event.state==='reconnecting') $('interim').textContent=''; }
 if(event.type==='transcript') { if(event.isFinal&&event.text) { addTranscript(event.source,event.text,event.turnId); $('interim').textContent=''; } else if(event.text) $('interim').textContent=labelSource(event.source)+': '+event.text; }
 if(event.type==='question-preview') { nextQuestion=event.pending?event.text:''; updateFlowHint(); }
 if(event.type==='answer-start') { answerBusy=true; $('usage').textContent=event.answers+' answers'; updateFlowHint(); }
 if(['answer-done','answer-error','answer-cancelled'].includes(event.type)) { answerBusy=false; updateFlowHint(); }
 if(event.type==='auth-status') $('chatgptStatus').textContent=event.message;
 if(event.type==='auth-complete') { applyConnectionUpdate(event.settings); refreshModels(); $('settingsMessage').textContent=selectedProvider===config.answerProvider?(event.message||'ChatGPT connected.'):'ChatGPT connected. Save setup to select it.'; }
});
$('listen').addEventListener('click', () => startListening().catch(error => notice(error.message)));
$('includeMic').addEventListener('change', () => { if (sessionMode === 'call') callMic = $('includeMic').checked; });
$('liveAutoAnswer').addEventListener('change', () => changeSessionPreferences({ autoAnswer: $('liveAutoAnswer').checked }));
document.querySelectorAll('[data-session-mode]').forEach(button => button.addEventListener('click', () => changeSessionPreferences({ sessionMode: button.dataset.sessionMode })));
$('save').addEventListener('click', () => saveSettings());
$('refreshModels').addEventListener('click', () => refreshModels(true));
$('adaptiveModels').addEventListener('change', () => showModelCatalog(modelCatalog || { status: 'unavailable', models: [] }));
$('fastModel').addEventListener('input', () => showModelCatalog(modelCatalog || { status: 'unavailable', models: [] }));
$('modelFilter').addEventListener('input', renderModelList);
for (const id of ['questionPauseMs', 'incompletePauseMs', 'answerTimeoutMs']) $(id).addEventListener('input', renderTimingSettings);
$('resetTiming').addEventListener('click', () => { $('questionPauseMs').value = 800; $('incompletePauseMs').value = 6500; $('answerTimeoutMs').value = 75000; renderTimingSettings(); });
document.querySelectorAll('[data-timing-help]').forEach(button => button.addEventListener('click', () => {
  const help = $(button.dataset.timingHelp), expanded = button.getAttribute('aria-expanded') !== 'true';
  button.setAttribute('aria-expanded', String(expanded)); help.classList.toggle('hidden', !expanded);
}));
document.querySelectorAll('[data-provider]').forEach(button => button.addEventListener('click', () => { if (!savingSettings) chooseProvider(button.dataset.provider); }));
for (const name of ['openai', 'anthropic', 'gemini', 'compatible']) $(name + 'Key').addEventListener('input', () => showModelCatalog(modelCatalog || { status: 'unavailable', models: [] }));
$('compatibleBaseUrl').addEventListener('input', () => showModelCatalog(modelCatalog || { status: 'unavailable', models: [] }));
$('forgetKeys').addEventListener('click', () => saveSettings(true));
$('minimize').addEventListener('click', () => api.minimize());
$('close').addEventListener('click', () => api.close());
$('autoAnswer').addEventListener('change', () => { $('maxAutoAnswers').disabled = !$('autoAnswer').checked; });
$('backgroundOpacity').addEventListener('input', () => applyAppearance($('backgroundOpacity').value));
$('backgroundOpacity').addEventListener('change', async () => {
  try { const opacity = Number($('backgroundOpacity').value); await api.setAppearance(opacity); if (config) config.backgroundOpacity = opacity; }
  catch (error) { notice(`Could not save background transparency: ${error.message}`); }
});
document.querySelectorAll('[data-mode]').forEach(button => button.addEventListener('click', () => { selectedMode = button.dataset.mode; document.querySelectorAll('[data-mode]').forEach(other => other.classList.toggle('selected', other === button)); }));
document.querySelectorAll('[data-depth]').forEach(button => button.addEventListener('click', () => { selectedDepth = button.dataset.depth; document.querySelectorAll('[data-depth]').forEach(other => other.classList.toggle('selected', other === button)); }));
document.addEventListener('contextmenu', event => event.preventDefault());
function signingIn(active) {
  $('chatgptConnect').disabled = active;
  $('chatgptCancel').classList.toggle('hidden', !active);
}
async function cancelSignIn(message) {
  const attempt = ++authAttempt; signingIn(true);
  try {
    await api.cancelChatGPT();
    if (attempt === authAttempt) $('chatgptStatus').textContent = message;
  } catch (error) { if (attempt === authAttempt) $('chatgptStatus').textContent = error.message; }
  finally { if (attempt === authAttempt) signingIn(false); }
}
$('chatgptConnect').addEventListener('click', async () => {
  const attempt = ++authAttempt; signingIn(true);
  try { await api.connectChatGPT(); }
  catch (error) { if (attempt === authAttempt) { $('chatgptStatus').textContent = error.message; $('authHelp').classList.remove('hidden'); } }
  finally { if (attempt === authAttempt) signingIn(false); }
});
$('chatgptCancel').addEventListener('click', () => cancelSignIn('Sign-in cancelled. Any previously connected account is unchanged.'));
$('chatgptHelp').addEventListener('click', async () => {
  $('authHelp').classList.remove('hidden');
  await cancelSignIn('Sign-in stopped. Follow the guidance below if your browser reported an organization policy block.');
});
$('chatgptDisconnect').addEventListener('click', async () => { if (api.disconnectChatGPT) { applyConnectionUpdate(await api.disconnectChatGPT()); refreshModels(); } });

$('openContent').addEventListener('click', async()=> { if(savingSettings || starting || !requireSavedSetup()) return; $('openContent').disabled=true; try { await api.showContent({hideConfig:true}); } catch(error) { notice(error.message); } finally { $('openContent').disabled=false; } });
document.querySelectorAll('[data-setup-tab]').forEach(button => {
  button.addEventListener('click', () => selectSetupTab(button.dataset.setupTab));
  button.addEventListener('keydown', event => {
    const tabs = [...document.querySelectorAll('[data-setup-tab]')];
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const index = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : (tabs.indexOf(button) + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
    selectSetupTab(tabs[index].dataset.setupTab); tabs[index].focus();
  });
});
$('answerFontSize').addEventListener('input',()=>applyTextSize($('answerFontSize').value));
$('answerFontSize').addEventListener('change',async()=> { try { await api.setTextSize(Number($('answerFontSize').value)); } catch(error) { notice(error.message); } });
$('clear').addEventListener('click',async()=> { try { await api.clear(); resetSessionView(); notice('Session cleared.'); } catch(error) { notice(error.message); } });
const ready=api.settings().then(value=> { applySettings(value); if(answerProviderReady(value)) refreshModels(); }).catch(error=>notice(error.message));
window.runSmokeTest=async()=> { await ready; const checks={configurationLoaded:!!$('save')&&!$('question'),roleFields:!!$('roleTitle')&&!!$('roleDescription'),apiBridge:typeof api.showContent==='function'&&typeof api.setTextSize==='function',noNativePopups:document.querySelectorAll('select,[title],input[type=file],[required]').length===0,noHorizontalOverflow:document.documentElement.scrollWidth<=innerWidth}; return {ok:Object.values(checks).every(Boolean),...checks,viewport:{width:innerWidth,height:innerHeight}}; };
// Explicit command-line qualification only. No cloud calls or audio recordings.
window.installCaptureTestMarker = () => {
  const marker = document.createElement('div'); marker.id = 'captureTestMarker';
  marker.className = 'capture-test-marker'; marker.textContent = 'Local capture qualification';
  document.body.append(marker);
};
window.runCaptureTest = async () => {
  let stream, context, input, recorder, silence, oscillator, volume;
  const result = { ok: false, durationSeconds: 4, cloudRequests: 0, audioSaved: false, chunks: 0, samples: 0, peak: 0, desktopMarkerPixels: null };
  try {
    context = new AudioContext({ sampleRate: 16000 });
    await context.audioWorklet.addModule('./pcm-worklet.js'); await context.resume();
    stream = await navigator.mediaDevices.getDisplayMedia({ audio: true, video: { width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: 5 } });
    result.audioTracks = stream.getAudioTracks().length; result.sampleRate = context.sampleRate;
    if (!result.audioTracks) throw new Error('No loopback audio track.');
    input = context.createMediaStreamSource(stream); recorder = new AudioWorkletNode(context, 'pcm-recorder');
    silence = context.createGain(); silence.gain.value = 0;
    recorder.port.onmessage = ({ data }) => { result.chunks++; result.samples += data.pcm.byteLength / 2; result.peak = Math.max(result.peak, data.peak); };
    input.connect(recorder).connect(silence).connect(context.destination);
    oscillator = context.createOscillator(); oscillator.frequency.value = 440;
    volume = context.createGain(); volume.gain.value = 0.035;
    oscillator.connect(volume).connect(context.destination); oscillator.start();
    const video = document.createElement('video'); video.muted = true; video.srcObject = stream; await video.play();
    await new Promise(resolve => setTimeout(resolve, 4000));
    const canvas = document.createElement('canvas'); canvas.width = video.videoWidth; canvas.height = video.videoHeight;
    const drawing = canvas.getContext('2d', { willReadFrequently: true }); drawing.drawImage(video, 0, 0);
    const pixels = drawing.getImageData(0, 0, canvas.width, canvas.height).data;
    let count = 0;
    for (let i = 0; i < pixels.length; i += 4) if (pixels[i] > 247 && pixels[i + 1] < 17 && pixels[i + 2] > 196 && pixels[i + 2] < 205) count++;
    result.desktopMarkerPixels = count; result.captureSize = { width: canvas.width, height: canvas.height };
    result.ok = result.chunks >= 20 && result.peak > .001;
  } catch (error) { result.error = error.message; }
  finally {
    try { oscillator?.stop(); } catch {}
    stream?.getTracks().forEach(track => track.stop());
    for (const node of [input, recorder, silence, oscillator, volume]) { try { node?.disconnect(); } catch {} }
    recorder?.port.close(); await context?.close().catch(() => {}); $('captureTestMarker')?.remove();
  }
  return result;
};
