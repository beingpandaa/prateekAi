'use strict';

const api = window.prateekAi;
let lastHotkeySequence = 0;
const $ = id => document.getElementById(id);
const idleAnswer = () => ({ id: null, question: '', text: '', state: 'idle', message: '' });
let state = { seq: 0, settings: { answerFontSize: 20, backgroundOpacity: 92 }, live: false, question: '', answer: idleAnswer(), sources: {} };
let ready = false, queued = [], lastSeq = -1, answerFrame = null, renderedText = null, renderedId = null;
let nextQuestion = '', noticeText = '', stopped = false, sending = false, submission = null, draftRevision = 0;
let questionExpanded = false, fontSaving = false, opacityRevision = 0;
let previewMode = false;
const EXAMPLE_QUESTION = 'Can you explain closures in JavaScript?';
const EXAMPLE_ANSWER = 'A **closure** is a function that remembers the variables from the scope where it was created, even after that outer function has finished.\n\n- **Scope:** The function keeps access to its lexical environment.\n- **State:** Each call to the outer function can create independent private state.\n- **Useful for:** Callbacks, function factories, and encapsulation.\n\n```javascript\nfunction createCounter() {\n  let count = 0;\n  return () => ++count;\n}\n```\n\nThe practical point: the function retains access to the variable, not a frozen copy of its value.';

function inline(parent, value) {
  const parts = value.split(/(\*\*[^*\n]+\*\*|__[^_\n]+__|`[^`\n]+`|\*[^*\n]+\*)/g);
  for (const part of parts) {
    let node;
    if ((part.startsWith('**') && part.endsWith('**')) || (part.startsWith('__') && part.endsWith('__'))) { node = document.createElement('strong'); node.textContent = part.slice(2, -2); }
    else if (part.startsWith('`') && part.endsWith('`') && part.length > 1) { node = document.createElement('code'); node.textContent = part.slice(1, -1); }
    else if (part.startsWith('*') && part.endsWith('*') && part.length > 1) { node = document.createElement('em'); node.textContent = part.slice(1, -1); }
    else node = document.createTextNode(part);
    parent.append(node);
  }
}

// Text nodes only: model output never becomes HTML, scripts, images, or links.
function markdown(value) {
  const fragment = document.createDocumentFragment();
  const lines = value.slice(0, 256 * 1024).replace(/\r\n?/g, '\n').split('\n');
  let paragraph = [], code = null, fence = '', list = null, listType = '', firstParagraph = true;
  const flush = () => {
    if (!paragraph.length) return;
    const p = document.createElement('p');
    if (firstParagraph) { p.className = 'lead'; firstParagraph = false; }
    inline(p, paragraph.join(' ')); fragment.append(p); paragraph = [];
  };
  const flushCode = () => {
    const pre = document.createElement('pre'), element = document.createElement('code');
    element.textContent = code.join('\n'); pre.append(element); fragment.append(pre); code = null;
  };
  for (const line of lines) {
    const fenceMatch = /^\s*(```|~~~)/.exec(line);
    if (code !== null) {
      if (fenceMatch?.[1] === fence) flushCode(); else code.push(line);
      continue;
    }
    if (fenceMatch) { flush(); list = null; code = []; fence = fenceMatch[1]; continue; }
    if (!line.trim()) { flush(); list = null; continue; }
    const heading = /^#{1,6}\s+(.+)$/.exec(line);
    if (heading) { flush(); list = null; const h = document.createElement('h3'); inline(h, heading[1]); fragment.append(h); continue; }
    const bullet = /^\s*(?:([-*•])|\d+[.)])\s+(.+)$/.exec(line);
    if (bullet) {
      flush();
      const type = bullet[1] ? 'ul' : 'ol';
      if (!list || listType !== type) { list = document.createElement(type); listType = type; fragment.append(list); }
      const item = document.createElement('li'), label = /^([^:*`]{1,36}):\s+(.+)$/.exec(bullet[2]);
      if (label && !/^https?$/i.test(label[1])) { const strong = document.createElement('strong'); strong.textContent = `${label[1]}:`; item.append(strong, document.createTextNode(' ')); inline(item, label[2]); }
      else inline(item, bullet[2]);
      list.append(item); continue;
    }
    if (/^>\s?/.test(line)) { flush(); list = null; const quote = document.createElement('blockquote'); inline(quote, line.replace(/^>\s?/, '')); fragment.append(quote); continue; }
    list = null; paragraph.push(line);
  }
  flush(); if (code !== null) flushCode();
  return fragment;
}

function message(text, information = false) {
  $('message').textContent = text || '';
  $('message').classList.toggle('hidden', !text);
  $('message').classList.toggle('information', information);
}
function applySettings(settings) {
  state.settings = { ...state.settings, ...settings };
  const size = Math.max(16, Math.min(26, Number(state.settings.answerFontSize) || 20));
  const opacity = Math.max(45, Math.min(100, Number(state.settings.backgroundOpacity) || 92));
  document.documentElement.style.setProperty('--answer-font', `${size}px`);
  document.documentElement.style.setProperty('--surface-opacity', String(opacity / 100));
  $('textSize').textContent = size;
  $('smallerText').disabled = fontSaving || size <= 16;
  $('largerText').disabled = fontSaving || size >= 26;
  $('backgroundOpacity').value = opacity;
  $('opacityValue').textContent = `${opacity}%`;
}
function busy() { return state.answer.state === 'generating'; }
function elapsed(value) { return Number.isFinite(value) ? `${(Math.max(0, value) / 1000).toFixed(1)}s` : ''; }
function updateStatus() {
  let label = 'Ready', kind = '';
  const source = state.settings.sessionMode === 'practice' ? 'you' : 'remote';
  if (busy()) {
    kind = 'busy';
    label = state.answer.text ? 'Answering' : state.answer.phase === 'refreshing-auth' ? 'Refreshing connection' : 'Preparing answer';
  } else if (state.live) {
    kind = 'live';
    label = state.sources[source] === 'reconnecting' ? 'Reconnecting audio' : nextQuestion ? 'Finishing question' : state.questionStatus ? (state.questionStatus.status === 'held' ? 'Question held · Listening' : 'Question needs attention') : state.settings.autoAnswer ? 'Listening · Auto' : 'Listening · Manual';
  } else if (stopped) label = 'Stopped';
  if (state.answer.state === 'error') { label = state.live ? 'Answer failed · Listening' : 'Answer failed'; kind = 'error'; }
  else if (state.answer.state === 'cancelled' && !state.live) label = 'Stopped';
  if (previewMode) { label = 'Example · Offline'; kind = ''; }
  $('statusText').textContent = label; $('statusDot').className = `status-dot ${kind}`;
  $('cancelAnswer').classList.toggle('hidden', !busy());
  $('cancelAnswer').disabled = false;
  $('askButton').disabled = busy() || sending || !$('manualQuestion').value.trim();
  $('askButton').textContent = sending ? 'Sending…' : 'Ask';
  $('stopListening').disabled = !state.live;
  $('showExample').disabled = state.live || busy(); $('emptyExample').disabled = state.live || busy();
  $('answerScroll').setAttribute('aria-busy', String(busy()));
  const details = [state.answer.model, state.answer.routeKind === 'quick' ? 'Quick answer' : '',
    Number.isFinite(state.answer.firstTextMs) ? `First text ${elapsed(state.answer.firstTextMs)}` : '',
    Number.isFinite(state.answer.elapsedMs) ? `Total ${elapsed(state.answer.elapsedMs)}` : ''].filter(Boolean);
  $('answerDetails').textContent = details.join(' · ') || 'No answer yet';
  const voice = state.voiceCommandStatus;
  const voiceVisible = !!state.settings.voiceFallbackEnabled && state.live && !previewMode;
  $('voiceCommandStatus').classList.toggle('hidden', !voiceVisible);
  $('voiceCommandStatus').dataset.status = voice?.status || 'ready';
  $('voiceCommandStatus').textContent = voice?.message || 'Voice fallback ready · say a saved command to answer the pending question.';
  const recovery = state.questionStatus;
  const recoveryVisible = !!recovery && state.live && !previewMode;
  const expired = Number.isFinite(recovery?.expiresAt) && Date.now() >= recovery.expiresAt;
  $('questionRecovery').classList.toggle('hidden', !recoveryVisible);
  $('questionRecoveryMessage').textContent = expired ? 'The captured question expired. Please ask it again.' : recovery?.message || '';
  $('questionRecoveryText').textContent = recovery?.text || '';
  $('answerCaptured').classList.toggle('hidden', !recovery?.canSubmit || expired);
  $('answerCaptured').disabled = sending || !recoveryVisible || !recovery?.canSubmit || expired;
}
function renderQuestion() {
  const question = state.answer.question || (state.answer.id === null ? state.question : '');
  $('questionSection').classList.toggle('hidden', !question);
  if ($('currentQuestion').textContent !== question) { $('currentQuestion').textContent = question; questionExpanded = false; }
  $('currentQuestion').classList.toggle('expanded', questionExpanded);
  requestAnimationFrame(() => {
    const truncated = $('currentQuestion').scrollHeight > $('currentQuestion').clientHeight + 1;
    $('expandQuestion').classList.toggle('hidden', !questionExpanded && !truncated);
    $('expandQuestion').textContent = questionExpanded ? 'Show less' : 'Show full question';
    $('expandQuestion').setAttribute('aria-expanded', String(questionExpanded));
  });
}
function renderAnswer() {
  const answer = state.answer;
  const fresh = renderedId !== answer.id;
  if (fresh) { renderedId = answer.id; renderedText = null; $('answerScroll').scrollTop = 0; }
  if (renderedText !== answer.text) {
    const position = fresh ? 0 : $('answerScroll').scrollTop;
    $('answerBody').replaceChildren(markdown(answer.text || ''));
    renderedText = answer.text;
    // The reader decides when to scroll. Streaming must never pull them away
    // from the first sentence or move them to the end of an unfinished answer.
    $('answerScroll').scrollTop = position;
  }
  const hasAnswer = !!answer.text;
  const pending = busy() && !hasAnswer;
  $('answerBody').classList.toggle('hidden', !hasAnswer);
  $('answerPlaceholder').classList.toggle('hidden', !pending);
  $('placeholderText').textContent = answer.phase === 'refreshing-auth' ? 'Refreshing your connection…' : 'Preparing an answer…';
  $('emptyState').classList.toggle('hidden', hasAnswer || pending || answer.state === 'error');
  $('emptyHint').textContent = state.live
    ? state.settings.autoAnswer ? 'Listening for your next question.\nAnswers will appear automatically.' : 'Listening is on.\nTurn on Auto-answer in Setup, or type a question.'
    : 'Start listening from Setup.\nTurn on Auto-answer for answers as you talk.';
  const failure = answer.state === 'error' ? answer.message : answer.state === 'cancelled' && hasAnswer ? 'Answer stopped. This partial answer may be incomplete.' : '';
  const notice = state.questionStatus?.message === noticeText ? '' : noticeText;
  message(notice && failure && notice !== failure ? `${notice} ${failure}` : notice || failure, !failure);
  renderQuestion(); updateStatus();
}
function scheduleAnswer() {
  if (answerFrame === null) answerFrame = requestAnimationFrame(() => { answerFrame = null; renderAnswer(); });
}
function flushAnswer() { if (answerFrame !== null) cancelAnimationFrame(answerFrame); answerFrame = null; renderAnswer(); }
function setComposer(open) {
  $('composer').classList.toggle('hidden', !open); $('composeButton').setAttribute('aria-expanded', String(open));
  if (open) { closeMenu(); $('manualQuestion').focus(); } else $('composeButton').focus();
  updateStatus();
}
function closeMenu(returnFocus = false) {
  $('readingMenu').classList.add('hidden'); $('menuButton').setAttribute('aria-expanded', 'false');
  if (returnFocus) $('menuButton').focus();
}
function showMenu() {
  $('tooltip').classList.add('hidden');
  $('readingMenu').classList.remove('hidden'); $('menuButton').setAttribute('aria-expanded', 'true'); $('openSetup').focus();
}
function reset() {
  state.question = ''; state.answer = idleAnswer(); state.sources = {}; nextQuestion = ''; noticeText = ''; submission = null; sending = false;
  previewMode = false; renderedId = null; renderedText = null; questionExpanded = false; $('answerScroll').scrollTop = 0;
  state.voiceCommandStatus = null; state.questionStatus = null;
}
function applyEvent(event) {
  // Commands are not represented by the state snapshot. Replay one buffered
  // hotkey even when its sequence is already included in that snapshot.
  if (event?.type === 'hotkey-answer' && Number.isFinite(event.seq)) {
    if (event.seq <= lastHotkeySequence) return;
    lastHotkeySequence = event.seq;
    submitPending(); return;
  }
  if (!event || typeof event !== 'object' || !Number.isFinite(event.seq) || event.seq <= lastSeq) return;
  lastSeq = event.seq; state.seq = event.seq;
  if (event.type === 'settings-changed' || event.type === 'session-preferences') { applySettings(event.settings); renderAnswer(); return; }
  if (event.type === 'session-reset') { reset(); flushAnswer(); return; }
  if (event.type === 'session-started') { state.live = true; state.startedAt = event.startedAt || Date.now(); stopped = false; noticeText = ''; renderAnswer(); return; }
  if (event.type === 'session-stopped') {
    state.live = false; stopped = true; nextQuestion = ''; state.questionStatus = null;
    if (busy()) state.answer = { ...state.answer, state: 'cancelled' };
    if (event.reason && event.reason !== 'Listening stopped.') noticeText = event.reason;
    sending = false; submission = null; flushAnswer(); return;
  }
  if (event.type === 'speech-state') { state.sources[event.source] = event.state; updateStatus(); return; }
  if (event.type === 'voice-command-status') { state.voiceCommandStatus = { status: event.status, message: event.message }; updateStatus(); return; }
  if (event.type === 'question-status') { state.questionStatus = { ...event }; updateStatus(); return; }
  if (event.type === 'notice') { noticeText = event.message || ''; renderAnswer(); return; }
  if (event.type === 'question-preview') { nextQuestion = event.pending ? event.text || '' : ''; if (event.pending) state.questionStatus = null; updateStatus(); return; }
  if (event.type === 'question') { state.question = event.text || ''; state.questionStatus = null; updateStatus(); if (!state.answer.question) renderQuestion(); return; }
  if (event.type === 'answer-start') {
    previewMode = false;
    if (!event.automatic || state.questionStatus?.questionId === event.questionId) state.questionStatus = null;
    if (!event.automatic && submission?.question === event.question) {
      if (draftRevision === submission.revision && $('manualQuestion').value === submission.draft) { $('manualQuestion').value = ''; draftRevision++; setComposer(false); }
      submission = null;
    }
    if (submission?.pending) submission = null;
    sending = false; nextQuestion = ''; noticeText = '';
    state.answer = { ...idleAnswer(), ...event, state: 'generating', text: '', phase: 'waiting-first-text' };
    $('answerScroll').scrollTop = 0; flushAnswer(); return;
  }
  if (event.type === 'answer-cancelled' && (event.id === undefined || event.id === state.answer.id)) {
    if (busy()) state.answer = { ...state.answer, state: 'cancelled' };
    sending = false; submission = null; flushAnswer(); return;
  }
  if (event.id !== state.answer.id) return;
  if (event.type === 'answer-delta') { state.answer.text += typeof event.text === 'string' ? event.text : ''; scheduleAnswer(); }
  else if (event.type === 'answer-phase' || event.type === 'answer-timing') { Object.assign(state.answer, event); renderAnswer(); }
  else if (event.type === 'answer-done') { Object.assign(state.answer, event, { state: 'done' }); flushAnswer(); }
  else if (event.type === 'answer-error') { Object.assign(state.answer, event, { state: 'error' }); sending = false; flushAnswer(); }
}

// Subscribe first. Events delivered while the snapshot is in flight must not
// duplicate text already included in that snapshot or overwrite newer state.
api.onEvent(event => { if (!ready) queued.push(event); else applyEvent(event); });
const initialized = (async () => {
  try {
    const snapshot = await api.contentState();
    state = { ...state, ...snapshot, answer: { ...idleAnswer(), ...snapshot.answer }, sources: { ...snapshot.sources } };
    lastSeq = Number.isFinite(snapshot.seq) ? snapshot.seq : 0;
    applySettings(snapshot.settings); stopped = !state.live && !!state.startedAt;
    renderAnswer(); ready = true;
    const buffered = queued; queued = [];
    buffered.sort((a, b) => (a.seq || 0) - (b.seq || 0)).forEach(applyEvent);
    document.documentElement.dataset.contentReady = 'true';
  } catch (error) {
    ready = true; queued = []; noticeText = `Could not load the answer view. ${error.message || 'Open Setup and try again.'}`; renderAnswer();
    document.documentElement.dataset.contentReady = 'error';
  }
})();

async function perform(action, button) {
  if (button) button.disabled = true;
  try { await action(); } catch (error) { noticeText = error.message || 'The action could not be completed.'; renderAnswer(); }
  finally { if (button) button.disabled = false; }
}
async function submitPending() {
  if (sending) return;
  const token = { pending: true };
  sending = true; submission = token; noticeText = ''; renderAnswer();
  try {
    const result = await api.submitPending({ trigger: 'hotkey' });
    if (submission === token && result?.ok === false) noticeText = result.message || 'No recent unanswered question is ready. Ask again or type a question.';
    else if (submission === token && result?.message) noticeText = result.message;
  } catch (error) { if (submission === token) noticeText = error.message || 'The pending question could not be submitted.'; }
  finally { if (submission === token) { submission = null; sending = false; renderAnswer(); } }
}
async function ask(explicitQuestion) {
  const draft = $('manualQuestion').value, question = typeof explicitQuestion === 'string' ? explicitQuestion.trim() : draft.trim();
  if (!question || sending || busy()) return;
  const token = { question, draft, revision: draftRevision };
  submission = token; sending = true; noticeText = ''; renderAnswer();
  try {
    const result = await api.ask({ question });
    if (result?.ok === false && submission === token) noticeText = result.message || 'This question was not submitted. Try again when ready.';
  } catch (error) { noticeText = error.message || 'The question could not be submitted.'; }
  finally {
    if (submission === token) { submission = null; sending = false; }
    renderAnswer();
  }
}
async function textSize(change) {
  if (fontSaving) return;
  const previous = Number(state.settings.answerFontSize) || 20;
  const value = Math.max(16, Math.min(26, previous + change));
  fontSaving = true; applySettings({ answerFontSize: value });
  try {
    const result = await api.setTextSize(value);
    if (typeof result === 'number') state.settings.answerFontSize = result;
    else if (result?.settings) Object.assign(state.settings, result.settings);
  } catch (error) { state.settings.answerFontSize = previous; noticeText = error.message; renderAnswer(); }
  finally { fontSaving = false; applySettings(state.settings); }
}
function showExample() {
  if (state.live || busy()) return;
  closeMenu(); previewMode = true; noticeText = '';
  state.answer = { ...idleAnswer(), id: 'example', question: EXAMPLE_QUESTION, state: 'done', model: 'Offline example · no AI request', text: EXAMPLE_ANSWER };
  $('answerScroll').scrollTop = 0; flushAnswer();
}
$('composeButton').addEventListener('click', () => setComposer($('composer').classList.contains('hidden')));
$('dismissComposer').addEventListener('click', () => setComposer(false));
$('manualQuestion').addEventListener('input', () => { draftRevision++; updateStatus(); });
$('composer').addEventListener('submit', event => { event.preventDefault(); ask(); });
$('cancelAnswer').addEventListener('click', () => perform(() => api.cancelAnswer(), $('cancelAnswer')));
$('closeContent').addEventListener('click', () => perform(() => api.closeContent(), $('closeContent')));
$('menuButton').addEventListener('click', () => $('readingMenu').classList.contains('hidden') ? showMenu() : closeMenu(true));
$('openSetup').addEventListener('click', () => { closeMenu(); perform(() => api.showConfiguration()); });
$('emptySetup').addEventListener('click', () => perform(() => api.showConfiguration()));
$('emptyExample').addEventListener('click', showExample);
$('showExample').addEventListener('click', showExample);
$('hideContent').addEventListener('click', () => { closeMenu(); perform(() => api.hideContent()); });
$('stopListening').addEventListener('click', () => { closeMenu(); perform(() => api.stop()); });
$('answerCaptured').addEventListener('click', () => submitPending());
$('smallerText').addEventListener('click', () => textSize(-1));
$('largerText').addEventListener('click', () => textSize(1));
$('backgroundOpacity').addEventListener('input', () => applySettings({ backgroundOpacity: Number($('backgroundOpacity').value) }));
$('backgroundOpacity').addEventListener('change', async () => {
  const revision = ++opacityRevision, value = Number($('backgroundOpacity').value);
  try { const result = await api.setAppearance(value); if (revision === opacityRevision && typeof result === 'number') applySettings({ backgroundOpacity: result }); }
  catch (error) { noticeText = error.message; renderAnswer(); }
});
$('expandQuestion').addEventListener('click', () => { questionExpanded = !questionExpanded; renderQuestion(); });

// Transparent windows do not consistently expose native resize borders on
// Windows. Keep the fallback small, and never send parallel resize requests.
let resizeDrag = null, resizeTarget = null, resizePending = null, resizeFrame = null, resizeInFlight = false;
function requestResize(width, height) {
  resizeTarget = resizePending = { width: Math.max(520, Math.round(width)), height: Math.max(420, Math.round(height)) };
  if (resizeFrame === null) resizeFrame = requestAnimationFrame(flushResize);
}
async function flushResize() {
  resizeFrame = null;
  if (resizeInFlight || !resizePending) return;
  const requested = resizePending; resizePending = null; resizeInFlight = true;
  try { await api.resizeContent(requested); }
  catch (error) { resizePending = null; noticeText = error.message || 'The window could not be resized.'; renderAnswer(); }
  finally {
    resizeInFlight = false;
    if (resizePending && resizeFrame === null) resizeFrame = requestAnimationFrame(flushResize);
    else if (!resizePending) resizeTarget = null;
  }
}
const resizeHandle = $('resizeHandle');
resizeHandle.addEventListener('pointerdown', event => {
  if (event.button !== 0) return;
  event.preventDefault(); resizeHandle.focus();
  resizeDrag = { id: event.pointerId, x: event.screenX, y: event.screenY, width: innerWidth, height: innerHeight };
  try { resizeHandle.setPointerCapture(event.pointerId); } catch { /* Synthetic accessibility/test events have no active pointer. */ }
});
resizeHandle.addEventListener('pointermove', event => {
  if (!resizeDrag || event.pointerId !== resizeDrag.id) return;
  event.preventDefault();
  requestResize(resizeDrag.width + event.screenX - resizeDrag.x, resizeDrag.height + event.screenY - resizeDrag.y);
});
function endResize(event) {
  if (!resizeDrag || event.pointerId !== resizeDrag.id) return;
  resizeDrag = null;
  if (resizeHandle.hasPointerCapture(event.pointerId)) resizeHandle.releasePointerCapture(event.pointerId);
}
resizeHandle.addEventListener('pointerup', endResize);
resizeHandle.addEventListener('pointercancel', endResize);
resizeHandle.addEventListener('lostpointercapture', () => { resizeDrag = null; });
window.addEventListener('blur', () => { resizeDrag = null; });
resizeHandle.addEventListener('keydown', event => {
  const deltas = { ArrowLeft: [-20, 0], ArrowRight: [20, 0], ArrowUp: [0, -20], ArrowDown: [0, 20] };
  const delta = deltas[event.key]; if (!delta) return;
  event.preventDefault(); event.stopPropagation();
  const base = resizeTarget || { width: innerWidth, height: innerHeight };
  requestResize(base.width + delta[0], base.height + delta[1]);
});
document.addEventListener('pointerdown', event => { if (!$('readingMenu').contains(event.target) && !$('menuButton').contains(event.target)) closeMenu(); });
document.addEventListener('keydown', event => {
  if (event.key === 'Escape') {
    event.preventDefault();
    if (!$('readingMenu').classList.contains('hidden')) closeMenu(true);
    else if (!$('composer').classList.contains('hidden')) setComposer(false);
    else perform(() => api.hideContent());
  } else if (event.ctrlKey && event.key === 'Enter') {
    event.preventDefault(); if ($('composer').classList.contains('hidden')) setComposer(true); else ask();
  }
});
for (const button of document.querySelectorAll('[data-help]')) {
  const show = () => { if (!$('readingMenu').classList.contains('hidden')) return; $('tooltip').textContent = button.dataset.help; $('tooltip').classList.remove('hidden'); };
  const hide = () => $('tooltip').classList.add('hidden');
  button.addEventListener('mouseenter', show); button.addEventListener('focus', show); button.addEventListener('mouseleave', hide); button.addEventListener('blur', hide); button.addEventListener('click', hide);
}
window.addEventListener('resize', renderQuestion);

window.runContentSmokeTest = async () => {
  await initialized;
  const unsafe = markdown('<img src=x onerror="window.__unsafe=true"> **Safe text**');
  const safeMarkup = !unsafe.querySelector('img,script,iframe');
  previewMode = true; noticeText = '';
  state.answer = { ...idleAnswer(), id: 'smoke', question: EXAMPLE_QUESTION, state: 'done', model: 'Offline example · no AI request', text: EXAMPLE_ANSWER };
  flushAnswer();
  await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(resolve, 20))));
  return { ok: safeMarkup && $('composer').classList.contains('hidden') && $('answerBody').textContent.includes('lexical environment'), safeMarkup, composerHidden: $('composer').classList.contains('hidden'), answerFontSize: getComputedStyle($('answerBody')).fontSize, questionFontSize: getComputedStyle($('currentQuestion')).fontSize, answerHeight: $('answerScroll').clientHeight, viewport: [innerWidth, innerHeight] };
};
