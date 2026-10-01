'use strict';
// Cross-layer regression: production main, preload, renderer, turn assembly,
// SpeechSession and answer SSE parser, with inert devices and local transports.
// No production profile, real credentials, hardware capture or cloud requests.
const electron = require('electron');
const { app, BrowserWindow, session } = electron;
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const assert = require('node:assert/strict');
const { performance } = require('node:perf_hooks');
const out = path.resolve(__dirname, '../../flow-e2e-tests');
const profile = path.join(out, `profile-${Date.now()}`);
fs.mkdirSync(out, { recursive: true });
process.env.PRATEEKAI_DATA_DIR = profile;
const checks = [], sockets = [], requests = [], events = [], blockedRequests = [];
const shortcuts = new Map();
const eventTimes = new Map();
let configWin, contentWin, holdNext = false, finished = false, resizeGeometry = null, firstQuestionTiming = null;
const check = (name, passed) => {
  checks.push({ name, passed: !!passed });
  assert.ok(passed, name);
};
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate, label, timeout = 5000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await delay(30);
  }
  throw new Error(`Timed out: ${label}`);
}
const ui = code => configWin.webContents.executeJavaScript(code);
const contentUI = code => contentWin.webContents.executeJavaScript(code);
const click = id => ui(`document.getElementById(${JSON.stringify(id)}).click()`);
const contentClick = id => contentUI(`document.getElementById(${JSON.stringify(id)}).click()`);
async function contentReady() {
  await until(() => contentWin && !contentWin.webContents.isLoading(), 'answer window loaded');
  await until(() => contentUI("document.documentElement.dataset.contentReady === 'true'"), 'answer snapshot and buffered events applied');
}

class LocalWebSocket extends EventEmitter {
  constructor(url) {
    super();
    assert.equal(new URL(url).origin, 'wss://api.deepgram.com');
    this.readyState = 0; this.bufferedAmount = 0; this.audioChunks = 0; this.closedByClient = false;
    sockets.push(this);
    queueMicrotask(() => { if (this.readyState !== 0) return; this.readyState = 1; this.emit('open'); });
  }
  send(data, options, callback) {
    if (options.binary) this.audioChunks++;
    else if (JSON.parse(String(data)).type === 'CloseStream') {
      this.closedByClient = true; this.readyState = 3;
      queueMicrotask(() => this.emit('close', 1000));
    }
    queueMicrotask(() => callback?.());
  }
  terminate() { this.readyState = 3; }
  transcript(text, start) {
    this.emit('message', Buffer.from(JSON.stringify({ type: 'Results', is_final: true, speech_final: true,
      start, duration: 1, channel: { alternatives: [{ transcript: text }] } })));
  }
  utterance(text, start, speechFinal = true) {
    // Deepgram timestamps remain relative to the same live socket. Interim and
    // final spans overlap for the same utterance; later utterances never reuse
    // the previous audio span. Exercise both final-with-endpoint and separate
    // empty endpoint messages, followed by the additional UtteranceEnd marker.
    const emit = value => this.emit('message', Buffer.from(JSON.stringify(value)));
    emit({ type: 'SpeechStarted', timestamp: start });
    emit({ type: 'Results', is_final: false, speech_final: false, start, duration: 0.6,
      channel: { alternatives: [{ transcript: text.split(' ').slice(0, -1).join(' ') }] } });
    emit({ type: 'Results', is_final: true, speech_final: speechFinal, start, duration: 1,
      channel: { alternatives: [{ transcript: text }] } });
    if (!speechFinal) emit({ type: 'Results', is_final: true, speech_final: true, start: start + 1, duration: 0,
      channel: { alternatives: [{ transcript: '' }] } });
    emit({ type: 'UtteranceEnd', last_word_end: start + 1 });
  }
}

function localAnswer(question, held) {
  if (held) return 'This deliberately held local answer is still streaming.';
  if (/closures/i.test(question)) return 'A closure retains access to its lexical scope after the outer function returns.';
  if (/event loop/i.test(question)) return 'The event loop schedules queued callbacks when the JavaScript call stack is empty.';
  if (/what is a promise/i.test(question)) return 'A promise represents the eventual completion or failure of an asynchronous operation.';
  if (/handle errors/i.test(question)) return 'Promise rejections propagate until a rejection handler handles the error.';
  if (/await schedule/i.test(question)) return 'An await continuation resumes through the microtask queue after its awaited promise settles.';
  return `A local test answer for: ${question}`;
}

global.fetch = async (url, options) => {
  const catalogs = {
    'https://api.anthropic.com/v1/models?limit=100': {data:[{id:'claude-haiku-4-5'},{id:'claude-sonnet-5-5'}]},
    'https://generativelanguage.googleapis.com/v1beta/models?pageSize=100': {models:[{name:'models/gemini-3.5-flash-lite',supportedGenerationMethods:['generateContent']},{name:'models/gemini-3.8-flash',supportedGenerationMethods:['generateContent']}]},
    'http://127.0.0.1:11434/v1/models': {data:[{id:'custom/main'},{id:'custom/quick'}]},
  };
  if (catalogs[String(url)]) return new Response(JSON.stringify(catalogs[String(url)]), {status:200});
  const nativeProvider = {
    'https://api.anthropic.com/v1/messages':'anthropic',
    'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash-lite:streamGenerateContent?alt=sse':'gemini',
    'http://127.0.0.1:11434/v1/chat/completions':'compatible',
  }[String(url)];
  if (nativeProvider) {
    const body = JSON.parse(options.body);
    const contents = nativeProvider==='gemini' ? body.contents.map(item=>item.parts[0].text) : body.messages.filter(item=>item.role==='user').map(item=>item.content);
    const keyIsCorrect = nativeProvider==='anthropic' ? options.headers['x-api-key']==='LOCAL-TEST-ANTHROPIC-NOT-A-KEY' : nativeProvider==='gemini' ? options.headers['x-goog-api-key']==='LOCAL-TEST-GEMINI-NOT-A-KEY' : !options.headers.Authorization;
    requests.push({provider:nativeProvider,question:contents.at(-1),reference:JSON.parse(contents[0]).reference_material,model:body.model || 'gemini-3.5-flash-lite',keyIsCorrect});
    const answer = `A ${nativeProvider} test answer explains lexical scope.`;
    const sequence = nativeProvider==='anthropic' ? [
      {type:'message_start',message:{id:'native-claude',model:body.model}},
      {type:'content_block_delta',delta:{type:'text_delta',text:answer}},
      {type:'message_delta',delta:{stop_reason:'end_turn'},usage:{output_tokens:9}},{type:'message_stop'},
    ] : nativeProvider==='gemini' ? [{candidates:[{index:0,content:{parts:[{text:answer}]},finishReason:'STOP'}],usageMetadata:{promptTokenCount:1,candidatesTokenCount:9}}]
      : [{choices:[{index:0,delta:{content:answer},finish_reason:null}]},{choices:[{index:0,delta:{},finish_reason:'stop'}]}];
    const data = sequence.map(event=>`data: ${JSON.stringify(event)}\n\n`).join('') + (nativeProvider==='compatible' ? 'data: [DONE]\n\n' : '');
    return new Response(data,{status:200,headers:{'Content-Type':'text/event-stream'}});
  }
  if (String(url) === 'https://api.openai.com/v1/models') {
    return new Response(JSON.stringify({ data: [{ id: 'gpt-6-luna' }, { id: 'local-test-model' }] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }
  assert.equal(String(url), 'https://api.openai.com/v1/responses', 'Only the local answer double may be called');
  const body = JSON.parse(options.body);
  const entry = { provider: 'openai', question: body.input.at(-1).content, model: body.model, reasoning: body.reasoning,
    reference: JSON.parse(body.input[0].content).reference_material, aborted: false, held: holdNext };
  requests.push(entry); holdNext = false;
  const encoder = new TextEncoder();
  let streamController, closed = false;
  const event = value => streamController.enqueue(encoder.encode(`data: ${JSON.stringify(value)}\n\n`));
  const stream = new ReadableStream({
    start(controller) {
      streamController = controller;
      event({ type: 'response.created', response: { id: `local-${requests.length}` } });
      entry.answerText = localAnswer(entry.question, entry.held);
      event({ type: 'response.output_text.delta', delta: entry.answerText });
      entry.complete = () => {
        if (closed) return;
        event({ type: 'response.completed', response: { status: 'completed', usage: { input_tokens: 1, output_tokens: 1 } } });
        closed = true; controller.close();
      };
      if (!entry.held) entry.complete();
    },
    cancel() { closed = true; }
  });
  options.signal.addEventListener('abort', () => {
    entry.aborted = true;
    if (!closed) { closed = true; streamController.error(new DOMException('Cancelled local test', 'AbortError')); }
  }, { once: true });
  return new Response(stream, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
};

class TestWindow extends BrowserWindow {
  constructor(options) {
    super({ ...options, alwaysOnTop: false });
    const send = this.webContents.send.bind(this.webContents);
    this.webContents.send = (channel, detail) => {
      // Main broadcasts the same sequence to both windows. Record it once,
      // through the configuration owner, so answer counts stay meaningful.
      if (channel === 'event' && this === configWin) { events.push(detail); eventTimes.set(detail.seq, performance.now()); }
      return send(channel, detail);
    };
  }
  loadURL(url, options) {
    const filename = path.basename(new URL(url).pathname);
    if (filename === 'index.html') configWin = this;
    else if (filename === 'content.html') contentWin = this;
    else assert.fail(`Unexpected production page: ${filename}`);
    return super.loadURL(url, options);
  }
  show() { this.showInactive(); }
}
const load = Module._load;
Module._load = function(request, parent, isMain) {
  if (request === 'ws') return LocalWebSocket;
  if (request === 'electron') return { ...electron, BrowserWindow: TestWindow,
    globalShortcut: { register: (name, callback) => { shortcuts.set(name, callback); return true; }, isRegistered: name => shortcuts.has(name), unregisterAll() { shortcuts.clear(); } } };
  if (['http', 'https', 'node:http', 'node:https'].includes(request)) {
    const real = load.apply(this, arguments);
    return { ...real, request() { throw new Error('External HTTP disabled in flow test'); }, get() { throw new Error('External HTTP disabled in flow test'); } };
  }
  return load.apply(this, arguments);
};
app.whenReady().then(() => {
  session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
    const blocked = !/^(file:|data:|devtools:)/.test(details.url);
    if (blocked) blockedRequests.push(details.url);
    callback({ cancel: blocked });
  });
});
require('../main.cjs');

const deadline = setTimeout(() => finish(new Error('Flow regression exceeded its 45-second bound')), 45000);
async function finish(error) {
  if (finished) return; finished = true; clearTimeout(deadline);
  const result = { ok: !error, checks, fakeSpeechConnections: sockets.length, fakeAnswerRequests: requests.length,
    realCloudRequests: 0, realAudioCapture: false, providerTransports: 'in-process doubles', resizeGeometry, firstQuestionTiming,
    automaticAnswers: events.filter(event => event.type === 'answer-start' && event.automatic).map(event => ({ id: event.id, question: event.question,
      done: events.some(completion => completion.type === 'answer-done' && completion.id === event.id),
      settleMs: event.settleMs, queueWaitMs: event.queueWaitMs })),
    productionLayers: ['main', 'preload', 'configuration renderer', 'content renderer and snapshot', 'TurnAssembler', 'SpeechSession', 'provider routing', 'OpenAI/Claude/Gemini/compatible SSE parsers'],
    ...(error ? { error: String(error.stack || error) } : {}) };
  try {
    if (configWin && !configWin.isDestroyed()) {
      await ui('window.prateekAi.stop()').catch(() => {});
      fs.writeFileSync(path.join(out, error ? 'failure-config.png' : 'flow-config.png'), (await configWin.webContents.capturePage()).toPNG());
    }
    if (contentWin && !contentWin.isDestroyed()) fs.writeFileSync(path.join(out, error ? 'failure.png' : 'flow.png'), (await contentWin.webContents.capturePage()).toPNG());
  } catch (captureError) { result.screenshotError = String(captureError.message); }
  fs.writeFileSync(path.join(out, 'result.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
  app.exit(error ? 1 : 0);
}

(async () => {
  await app.whenReady();
  await until(() => configWin && !configWin.webContents.isLoading(), 'production configuration window loaded');
  await until(() => ui("!!window.prateekAi && document.getElementById('listen') !== null"), 'production preload and renderer ready');
  await delay(150);
  await ui(`(() => {
    const capture = window.flowCapture = { display:0, mic:0, closed:0, tracks:[], ports:[] };
    const track = kind => { const value = {kind,enabled:true,stopped:false,stop(){this.stopped=true;}}; capture.tracks.push(value); return value; };
    const stream = display => { const audio=track('audio'), video=display?track('video'):null; return {getTracks:()=>video?[audio,video]:[audio],getAudioTracks:()=>[audio],getVideoTracks:()=>video?[video]:[]}; };
    const node = () => ({connect(next){return next;},disconnect(){},gain:{value:0}});
    window.AudioContext = class { constructor(){this.sampleRate=16000;this.destination={};this.audioWorklet={addModule:async()=>{}};} async resume(){} async close(){capture.closed++;} createMediaStreamSource(){return node();} createGain(){return node();} };
    window.AudioWorkletNode = class { constructor(){Object.assign(this,node());const port=this.port={closed:false,close(){this.closed=true;clearInterval(this.timer);}};capture.ports.push(port);port.timer=setInterval(()=>port.onmessage?.({data:{pcm:new Int16Array(1600).buffer,peak:0}}),100);} };
    navigator.mediaDevices.getDisplayMedia=async()=>{capture.display++;return stream(true);};
    navigator.mediaDevices.getUserMedia=async()=>{capture.mic++;return stream(false);};
  })()`);
  check('Configuration is a permanent setup surface without answer or composer clutter', await ui("!!document.getElementById('connectionsTab') && !document.getElementById('setup') && !document.getElementById('answer') && !document.getElementById('question')"));
  await ui("document.querySelector('[data-provider=\"openai\"]').click()");
  await ui("document.getElementById('deepgramKey').value='LOCAL-TEST-DEEPGRAM-NOT-A-KEY';document.getElementById('openaiKey').value='LOCAL-TEST-OPENAI-NOT-A-KEY'");
  await click('answersTab');
  await ui("document.getElementById('model').value='local-test-model'");
  await click('contextTab');
  await ui("document.getElementById('context').value='Candidate has maintained JavaScript components.';document.getElementById('roleTitle').value='Senior software engineer';document.getElementById('roleDescription').value='Role requires distributed systems design and mentoring.'");
  await click('save');
  await until(() => ui("document.getElementById('settingsMessage').textContent.startsWith('Setup saved.')"), 'fake setup persisted via production IPC');
  await click('practiceMode');
  await until(() => ui("document.getElementById('practiceMode').getAttribute('aria-pressed')==='true' && !document.getElementById('liveAutoAnswer').disabled"), 'practice preference saved');
  await click('liveAutoAnswer');
  await until(() => ui("document.getElementById('liveAutoAnswer').checked && !document.getElementById('listen').disabled"), 'auto preference saved');
  await click('listen');
  await until(() => ui("document.getElementById('listen').textContent==='Stop listening'"), 'listening started');
  await contentReady();
  await until(() => contentWin.isVisible() && !configWin.isVisible(), 'capture-ready transition opens answers and hides setup');
  check('Starting capture opens a distinct content-only window and keeps the capture owner alive', configWin !== contentWin && !configWin.isDestroyed() && await contentUI("document.getElementById('composer').classList.contains('hidden') && !document.getElementById('transcript') && !document.getElementById('settings')"));
  const capture = await ui('({mic:flowCapture.mic,display:flowCapture.display})');
  check('Practice uses one real SpeechSession with only an inert microphone device', sockets.length === 1 && capture.mic === 1 && capture.display === 0);
  await until(() => sockets[0].audioChunks > 0, 'synthetic PCM crosses real IPC and SpeechSession');
  check('Synthetic PCM reaches the local WebSocket through production audio IPC', sockets[0].audioChunks > 0);
  sockets[0].transcript('Can you explain me', 0);
  await delay(2000);
  check('An incomplete prefix does not generate during a two-second pause', requests.length === 0);
  const finalArrivedAt = performance.now();
  sockets[0].transcript('what are closures?', 3);
  await until(() => events.some(e => e.type === 'answer-done'), 'automatic answer streamed');
  await delay(60);
  check('One completed question creates exactly one automatic answer', requests.length === 1 && requests[0].question === 'Can you explain me what are closures?');
  check('Simple question uses a catalog-confirmed lightweight model with no reasoning delay', requests[0].model === 'gpt-6-luna' && requests[0].reasoning?.effort === 'none');
  const firstStart = events.find(event => event.type === 'answer-start');
  // The reported settleMs begins when PendingQuestionBuffer finishes updating,
  // after synchronous classification. That marker can lag the assembler timer
  // under parallel CPU load, making a healthy 800ms turn report e.g. 780ms.
  // Measure the actual final-arrival -> answer-start interval monotonically.
  // Exact 800ms behavior is covered by fake-clock unit tests; allow 50ms timer
  // tolerance here while retaining the strict sub-1.5-second product gate.
  const finalToAnswerStartMs = eventTimes.get(firstStart.seq) - finalArrivedAt;
  firstQuestionTiming = { finalToAnswerStartMs: Math.round(finalToAnswerStartMs * 10) / 10, reportedSettleMs: firstStart.settleMs, maximumMs: 1500 };
  check('Completed question reaches answer start within 750–1500ms of the final transcript', finalToAnswerStartMs >= 750 && finalToAnswerStartMs < 1500);
  check('Speech fragments merge into one configuration transcript while the popup composer stays empty', await ui("document.querySelectorAll('.transcript-item').length===1 && document.querySelector('.transcript-item p').textContent==='Can you explain me what are closures?'" ) && await contentUI("document.getElementById('manualQuestion').value==='' && document.getElementById('composer').classList.contains('hidden')"));
  check('The real SSE parser streams the correctly paired question and answer into the popup', await contentUI("document.getElementById('answerBody').textContent.includes('lexical scope') && document.getElementById('currentQuestion').textContent==='Can you explain me what are closures?' && document.getElementById('answerScroll').getAttribute('aria-busy')==='false'"));
  const referenceContext = JSON.parse(requests[0].reference.context);
  check('Saved candidate facts and desired-role requirements reach the provider as separate context fields', referenceContext.candidateSummary === 'Candidate has maintained JavaScript components.' && referenceContext.roleTitle === 'Senior software engineer' && referenceContext.roleDescription === 'Role requires distributed systems design and mentoring.');
  const originalBounds = contentWin.getBounds(), chunksBeforeResize = sockets[0].audioChunks;
  await contentUI("document.getElementById('resizeHandle').focus();document.getElementById('resizeHandle').dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowLeft',bubbles:true}))");
  await until(() => contentWin.getBounds().width === originalBounds.width - 20, 'resize grip shrinks actual Electron window width through IPC');
  await contentUI("document.getElementById('resizeHandle').dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowUp',bubbles:true}))");
  await until(() => contentWin.getBounds().height === originalBounds.height - 20, 'resize grip shrinks actual Electron window height through IPC');
  check('Popup resize grip changes native dimensions through its real preload and IPC controls', contentWin.getBounds().width === originalBounds.width - 20 && contentWin.getBounds().height === originalBounds.height - 20);
  const resizeArea = electron.screen.getDisplayMatching(contentWin.getBounds()).workArea;
  const minimumBounds = { width: Math.min(520, resizeArea.width), height: Math.min(420, resizeArea.height) };
  const clamped = await contentUI('window.prateekAi.resizeContent({width:1,height:1})');
  await until(() => contentWin.getBounds().width === minimumBounds.width && contentWin.getBounds().height === minimumBounds.height, 'native minimum resize clamp');
  resizeGeometry = await contentUI("new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve({width:innerWidth,height:innerHeight,answerHeight:document.getElementById('answerScroll').clientHeight,documentWidth:document.documentElement.scrollWidth,question:document.getElementById('currentQuestion').textContent,answer:document.getElementById('answerBody').textContent}))))");
  check('Minimum-size resize is clamped by main and preserves a readable answer area without horizontal overflow', clamped.width === minimumBounds.width && clamped.height === minimumBounds.height && resizeGeometry.width === minimumBounds.width && resizeGeometry.height === minimumBounds.height && resizeGeometry.answerHeight >= minimumBounds.height - 140 && resizeGeometry.documentWidth <= resizeGeometry.width && resizeGeometry.question === requests[0].question && resizeGeometry.answer.includes('lexical scope'));
  await contentUI(`window.prateekAi.resizeContent({width:${originalBounds.width},height:${originalBounds.height}})`);
  await until(() => contentWin.getBounds().width === originalBounds.width && contentWin.getBounds().height === originalBounds.height && sockets[0].audioChunks > chunksBeforeResize, 'resize restore and uninterrupted PCM delivery');
  check('Resizing and restoring the popup preserves live capture without another stream or answer request', sockets.length === 1 && requests.length === 1 && !sockets[0].closedByClient && await ui("flowCapture.mic===1 && flowCapture.closed===0 && flowCapture.tracks.every(t=>!t.stopped) && document.getElementById('listen').textContent==='Stop listening'"));
  fs.writeFileSync(path.join(out, 'automatic-answer.png'), (await contentWin.webContents.capturePage()).toPNG());
  await new Promise(resolve => { contentWin.webContents.once('did-finish-load', resolve); contentWin.webContents.reload(); });
  await contentReady();
  check('Reloaded answer window restores the completed snapshot exactly once without another request', requests.length === 1 && await contentUI("document.getElementById('currentQuestion').textContent==='Can you explain me what are closures?' && document.getElementById('answerBody').textContent==='A closure retains access to its lexical scope after the outer function returns.'"));
  for (const [question, start, speechFinal] of [['Explain event loop?', 6, true], ['What is a promise?', 9, false]]) {
    const before = requests.length, eventOffset = events.length;
    sockets[0].utterance(question, start, speechFinal);
    await until(() => {
      const answerStart = events.slice(eventOffset).find(event => event.type === 'answer-start' && event.question === question);
      return answerStart && events.some(event => event.type === 'answer-done' && event.id === answerStart.id);
    }, `consecutive automatic mic answer: ${question}`);
    const request = requests[before], answerStart = events.slice(eventOffset).find(event => event.type === 'answer-start');
    await until(() => contentUI(`document.getElementById('currentQuestion').textContent===${JSON.stringify(question)} && document.getElementById('answerBody').textContent===${JSON.stringify(request.answerText)} && document.getElementById('answerScroll').getAttribute('aria-busy')==='false'`), `displayed completed answer: ${question}`);
    check(`Next distinct mic question answers automatically in the same session: ${question}`, requests.length === before + 1 && request.question === question && answerStart.automatic === true && !request.aborted && await ui("document.getElementById('listen').textContent==='Stop listening' && document.getElementById('liveAutoAnswer').checked && flowCapture.mic===1 && flowCapture.closed===0"));
  }
  const firstThreeStarts = events.filter(event => event.type === 'answer-start');
  check('Closures, event loop, and promise each finish once with distinct answer IDs and matching transcript rows', requests.length === 3 && new Set(firstThreeStarts.map(event => event.id)).size === 3 && events.filter(event => event.type === 'answer-done').length === 3 && await ui("document.querySelectorAll('.transcript-item').length===3"));
  const beforeFollowup = requests.length, previousRequest = requests.at(-1);
  sockets[0].utterance('How does this handle errors?', 12);
  await until(() => requests.length === beforeFollowup + 1 && events.filter(event => event.type === 'answer-done').length === beforeFollowup + 1, 'contextual follow-up answered');
  const followupRequest = requests.at(-1);
  check('Follow-up receives the previous question and assistant suggestion as context', followupRequest.reference.transcript.includes(previousRequest.question) && followupRequest.reference.transcript.includes(previousRequest.answerText));
  await contentClick('menuButton'); await contentClick('openSetup');
  await until(() => configWin.isVisible() && !contentWin.isVisible(), 'open setup returns to capture-owning configuration');
  check('Opening Setup during a call preserves the live speech connection and locks only saved configuration', !sockets[0].closedByClient && await ui("document.getElementById('listen').textContent==='Stop listening' && document.getElementById('configurationFields').disabled && !document.getElementById('liveAutoAnswer').disabled"));
  await click('liveAutoAnswer');
  await until(() => ui("!document.getElementById('liveAutoAnswer').checked && !document.getElementById('liveAutoAnswer').disabled"), 'auto disabled while live');
  const beforeManualOnly = requests.length;
  sockets[0].utterance('What is a database index?', 15); await delay(1750);
  check('Auto off continues transcription without requesting another answer', requests.length === beforeManualOnly && await ui("document.querySelectorAll('.transcript-item').length===5 && document.getElementById('listen').textContent==='Stop listening'"));
  await click('liveAutoAnswer');
  await until(() => ui("document.getElementById('liveAutoAnswer').checked && !document.getElementById('liveAutoAnswer').disabled"), 'auto re-enabled');
  await click('openContent');
  await until(() => contentWin.isVisible() && !configWin.isVisible(), 'return to live answer window');
  const beforeQueue = requests.length;
  holdNext = true; sockets[0].utterance('Explain async functions?', 18);
  await until(() => requests.length === beforeQueue + 1, 'held answer begins');
  const heldRequest = requests.at(-1);
  for (const [question, start] of [['What is a microtask?', 21], ['How does await schedule continuation?', 24]]) {
    const eventOffset = events.length;
    sockets[0].utterance(question, start);
    await until(() => events.slice(eventOffset).some(event => event.type === 'question' && event.text === question), `question completes while previous answer streams: ${question}`);
  }
  check('Completed questions queue without interrupting an active answer', requests.length === beforeQueue + 1 && !heldRequest.aborted);
  check('Queued next question never relabels the answer that is still streaming', await contentUI("document.getElementById('currentQuestion').textContent==='Explain async functions?' && document.getElementById('answerBody').textContent.includes('held local answer')"));
  heldRequest.complete();
  await until(() => {
    const nextStart = events.find(event => event.type === 'answer-start' && event.question === 'How does await schedule continuation?');
    return nextStart && events.some(event => event.type === 'answer-done' && event.id === nextStart.id);
  }, 'latest queued question answers after active response finishes');
  check('Completing the active stream automatically answers every independent queued question', requests.length === beforeQueue + 3 && requests.at(-1).question === 'How does await schedule continuation?' && requests.some(request => request.question === 'What is a microtask?') && !heldRequest.aborted);
  await until(() => contentUI("document.getElementById('currentQuestion').textContent==='How does await schedule continuation?' && document.getElementById('answerBody').textContent.includes('await continuation') && document.getElementById('answerScroll').getAttribute('aria-busy')==='false'"), 'latest queued answer is paired in popup');

  // Preserve cancellation coverage with a separate request after proving queue
  // draining. Its completed follow-up and unfinished prefix must not run later.
  const beforeStop = requests.length;
  holdNext = true; sockets[0].utterance('Explain promises and error handling.', 27);
  await until(() => requests.length === beforeStop + 1, 'second held answer begins');
  const cancelledRequest = requests.at(-1), requestsAtStop = requests.length, stopEventOffset = events.length;
  sockets[0].utterance('What is a rejection?', 30);
  await until(() => events.slice(stopEventOffset).some(event => event.type === 'question' && event.text === 'What is a rejection?'), 'question queued before Stop');
  sockets[0].transcript('Can you explain me', 33);
  await contentClick('closeContent');
  await until(() => ui("document.getElementById('listen').textContent==='Start listening'"), 'stop completes');
  await until(() => configWin.isVisible() && !contentWin.isVisible(), 'closing answers stops listening and returns to Setup');
  await delay(1700);
  check('Stop aborts the active provider and drops queued automatic work', requests.length === requestsAtStop && cancelledRequest.aborted);
  check('Stop visibly marks the interrupted answer instead of leaving Generating', await contentUI("document.getElementById('statusText').textContent==='Stopped' && /partial|incomplete/i.test(document.getElementById('message').textContent) && document.getElementById('answerScroll').getAttribute('aria-busy')==='false'"));
  check('Stop closes the speech socket and all inert capture resources', sockets[0].closedByClient && await ui('flowCapture.tracks.every(t=>t.stopped) && flowCapture.ports.every(p=>p.closed) && flowCapture.closed===1'));
  await delay(5000);
  check('An incomplete turn cannot generate after Stop even when its deadline passes', requests.length === requestsAtStop);
  for (const [provider, mainModel, fastModel] of [['anthropic','claude-sonnet-5-5','claude-haiku-4-5'],['gemini','gemini-3.8-flash','gemini-3.5-flash-lite'],['compatible','custom/main','custom/quick']]) {
    if (contentWin.isVisible()) { await contentClick('menuButton'); await contentClick('openSetup'); }
    await click('connectionsTab');
    await ui(`document.querySelector('[data-provider="${provider}"]').click()`);
    if (provider==='compatible') await ui("document.getElementById('compatibleBaseUrl').value='http://127.0.0.1:11434/v1'");
    else await ui(`document.getElementById('${provider}Key').value='LOCAL-TEST-${provider.toUpperCase()}-NOT-A-KEY'`);
    await click('answersTab');
    await ui(`document.getElementById('model').value='${mainModel}';document.getElementById('fastModel').value='${fastModel}'`);
    await click('save');
    await until(() => ui(`document.getElementById('settingsMessage').textContent.startsWith('Setup saved.') && document.getElementById('modelList').textContent.includes('${fastModel}')`), `${provider} connection and catalog saved`);
    await click('openContent');
    await until(() => contentWin.isVisible() && !configWin.isVisible(), `${provider} answer view opened`);
    const before = requests.length;
    await contentClick('composeButton');
    await contentUI("document.getElementById('manualQuestion').value='What is lexical scope?';document.getElementById('manualQuestion').dispatchEvent(new Event('input'))");
    await contentClick('askButton');
    await until(() => requests.length===before+1 && contentUI(`document.getElementById('answerBody').textContent.includes('${provider} test answer') && document.getElementById('answerScroll').getAttribute('aria-busy')==='false'`), `${provider} answer displayed`);
    const request = requests.at(-1);
    check(`${provider} Setup routes through its own authenticated protocol and selected quick model`, request.provider===provider && request.model===fastModel && request.keyIsCorrect);
    check(`${provider} starts without prior provider conversation and returns to a content-only answer`, request.reference.transcript==='' && await contentUI(`document.getElementById('answerBody').textContent.includes('${provider} test answer') && document.getElementById('manualQuestion').value==='' && document.getElementById('composer').classList.contains('hidden')`));
    check(`${provider} preserves supplied role and candidate context across provider setup`, JSON.stringify(JSON.parse(request.reference.context)) === JSON.stringify(referenceContext));
  }

  // Spoken fallback crosses the production settings UI, preload, capture
  // owner, SpeechSession, command matcher, pending buffer and provider stream.
  // Only the devices and transports above are inert in-process doubles.
  await contentClick('menuButton'); await contentClick('openSetup');
  await until(() => configWin.isVisible() && !contentWin.isVisible(), 'return to Setup for voice fallback');
  await click('connectionsTab');
  await ui("document.querySelector('[data-provider=\"openai\"]').click()");
  await click('answersTab');
  await ui("document.getElementById('model').value='local-test-model';document.getElementById('fastModel').value='';document.getElementById('autoAnswer').checked=false;document.getElementById('autoAnswer').dispatchEvent(new Event('change'));document.getElementById('voiceFallbackEnabled').checked=true;document.getElementById('voiceFallbackEnabled').dispatchEvent(new Event('change'))");
  await click('save');
  await until(() => ui("document.getElementById('settingsMessage').textContent.startsWith('Setup saved.') && !document.getElementById('save').disabled"), 'voice fallback setup saved');
  await click('callMode');
  await until(() => ui("document.getElementById('callMode').getAttribute('aria-pressed')==='true' && !document.getElementById('listen').disabled"), 'live-call preference saved');
  await ui("document.getElementById('includeMic').checked=false;document.getElementById('includeMic').dispatchEvent(new Event('change'))");
  check('Before Start, commands-only microphone cost is visible while ordinary mic context and Auto are off', await ui("!document.getElementById('includeMic').checked && !document.getElementById('liveAutoAnswer').checked && document.getElementById('voiceStreamCost').textContent.includes('two paid speech streams') && document.getElementById('voiceStreamCost').textContent.includes('commands only')"));
  const voiceSocketOffset = sockets.length, voiceRequestOffset = requests.length;
  const captureBeforeVoice = await ui('({mic:flowCapture.mic,display:flowCapture.display,closed:flowCapture.closed})');
  await click('listen');
  await until(() => ui("document.getElementById('listen').textContent==='Stop listening'"), 'voice fallback listening started');
  await contentReady();
  await until(() => sockets.length === voiceSocketOffset + 2 && sockets.slice(voiceSocketOffset).every(socket => socket.audioChunks > 0), 'call and command microphone PCM streams');
  const remote = sockets[voiceSocketOffset], microphone = sockets[voiceSocketOffset + 1];
  check('Voice fallback opens exactly one call stream and one microphone stream through production capture', sockets.length === voiceSocketOffset + 2 && await ui(`flowCapture.display===${captureBeforeVoice.display + 1} && flowCapture.mic===${captureBeforeVoice.mic + 1} && flowCapture.closed===${captureBeforeVoice.closed}`));
  check('Saved voice controls are locked for the active session', await ui("document.getElementById('configurationFields').disabled && document.getElementById('voiceFallbackEnabled').matches(':disabled') && document.getElementById('voiceCommandPhrases').matches(':disabled') && document.getElementById('voiceCooldownMs').matches(':disabled')"));
  microphone.utterance('I am describing an unrelated bluebird microscope.', 0);
  remote.transcript('Given an array of integers,', 0);
  await delay(200);
  remote.transcript('return two indices whose values sum to a target.', 1);
  const dsaQuestion = 'Given an array of integers, return two indices whose values sum to a target.';
  await until(() => events.some(event => event.type === 'question' && event.text === dsaQuestion), 'remote DSA fragments assembled while Auto is off');
  check('Auto off retains the complete remote DSA task without requesting an answer', requests.length === voiceRequestOffset && await ui(`document.querySelectorAll('.transcript-item').length===1 && document.querySelector('.transcript-item p').textContent===${JSON.stringify(dsaQuestion)}`));
  const firstVoiceEventOffset = events.length;
  microphone.utterance('Give me a minute to think.', 3);
  await until(() => {
    const start = events.slice(firstVoiceEventOffset).find(event => event.type === 'answer-start' && event.question === dsaQuestion);
    return start && events.some(event => event.type === 'answer-done' && event.id === start.id);
  }, 'spoken fallback requests and completes the pending DSA answer');
  const firstVoiceRequest = requests.at(-1);
  check('Local voice command answers the pending remote task with Auto still off', requests.length === voiceRequestOffset + 1 && firstVoiceRequest.question === dsaQuestion && await ui("!document.getElementById('liveAutoAnswer').checked"));
  check('Commands-only microphone speech and the command phrase never enter the provider prompt', !/bluebird|microscope|give me a minute|gimme/i.test(JSON.stringify(firstVoiceRequest.reference)) && !/give me a minute|gimme/i.test(firstVoiceRequest.question));
  await until(() => contentUI("!document.getElementById('voiceCommandStatus').classList.contains('hidden') && document.getElementById('voiceCommandStatus').textContent.includes('Answer requested')"), 'popup shows command acceptance');
  check('Recognized spoken command is visible in the compact popup', events.slice(firstVoiceEventOffset).some(event => event.type === 'voice-command-status' && event.status === 'recognized') && await contentUI(`document.getElementById('currentQuestion').textContent===${JSON.stringify(dsaQuestion)} && document.getElementById('answerScroll').getAttribute('aria-busy')==='false'`));

  // Respect the real default cooldown before a second spoken command, then
  // split its Gimme alias across provider finals on the same microphone socket.
  await delay(3100);
  const secondVoiceQuestion = 'Design an LRU cache with constant time get and put.';
  remote.utterance(secondVoiceQuestion, 6, false);
  await until(() => events.some(event => event.type === 'question' && event.text === secondVoiceQuestion), 'second remote task retained');
  microphone.transcript('Gimme a minute', 7);
  await delay(150);
  check('A partial voice command does not submit an answer prematurely', requests.length === voiceRequestOffset + 1);
  microphone.transcript('to think.', 8);
  await until(() => {
    const start = events.find(event => event.type === 'answer-start' && event.question === secondVoiceQuestion);
    return start && events.some(event => event.type === 'answer-done' && event.id === start.id);
  }, 'split Gimme command submits the second pending task');
  check('Split command aliases recover the second task once without new capture streams', requests.length === voiceRequestOffset + 2 && requests.at(-1).question === secondVoiceQuestion && sockets.length === voiceSocketOffset + 2 && await ui(`flowCapture.mic===${captureBeforeVoice.mic + 1} && flowCapture.display===${captureBeforeVoice.display + 1}`));
  check('No split command fragment or unrelated microphone text leaks into follow-up context', !/gimme|give me a minute|to think|bluebird|microscope/i.test(JSON.stringify(requests.at(-1).reference)));

  // The mocked global shortcut runs the actual main -> event -> popup ->
  // preload path. It must queue without restarting the currently held answer.
  holdNext = true;
  await contentClick('composeButton');
  await contentUI("document.getElementById('manualQuestion').value='Explain async execution.';document.getElementById('manualQuestion').dispatchEvent(new Event('input'))");
  await contentClick('askButton');
  await until(() => requests.length === voiceRequestOffset + 3, 'held manual answer for keyboard queue test');
  const activeBeforeHotkey = requests.at(-1), queuedHotkeyQuestion = 'Compare linked lists and arrays.';
  remote.utterance(queuedHotkeyQuestion, 12);
  await until(() => events.some(event => event.type === 'question' && event.text === queuedHotkeyQuestion), 'next pending remote task while answer streams');
  const hotkeyEventOffset = events.length;
  await shortcuts.get('CommandOrControl+Shift+Space')();
  await until(() => events.slice(hotkeyEventOffset).some(event => event.type === 'question' && event.trigger === 'hotkey' && event.text === queuedHotkeyQuestion), 'keyboard fallback is authoritatively queued');
  check('Production hotkey queues a pending task without restarting the active answer', requests.length === voiceRequestOffset + 3 && !activeBeforeHotkey.aborted && await contentUI("document.getElementById('currentQuestion').textContent==='Explain async execution.' && document.getElementById('answerScroll').getAttribute('aria-busy')==='true'"));
  activeBeforeHotkey.complete();
  await until(() => {
    const start = events.slice(hotkeyEventOffset).find(event => event.type === 'answer-start' && event.question === queuedHotkeyQuestion);
    return start && events.some(event => event.type === 'answer-done' && event.id === start.id);
  }, 'hotkey queued task completes after previous answer');
  check('Keyboard fallback drains once through the same answer queue', requests.length === voiceRequestOffset + 4 && requests.at(-1).question === queuedHotkeyQuestion && !activeBeforeHotkey.aborted);
  const recoveryOffset = requests.length;
  remote.utterance('A bounded buffer using multiple producers and consumers.', 15);
  await until(() => contentUI("!document.getElementById('questionRecovery').classList.contains('hidden') && !document.getElementById('answerCaptured').disabled"), 'held speech is visibly recoverable');
  check('Held capture explains itself instead of silently returning to Listening', requests.length === recoveryOffset && await contentUI("document.getElementById('statusText').textContent==='Question held · Listening' && document.getElementById('questionRecoveryText').textContent.includes('bounded buffer') && document.getElementById('currentQuestion').textContent==='Compare linked lists and arrays.'"));
  await contentWin.loadURL(contentWin.webContents.getURL()); await contentReady();
  check('Popup reload preserves the main-process held question and its recovery control', await contentUI("!document.getElementById('questionRecovery').classList.contains('hidden') && !document.getElementById('answerCaptured').disabled"));
  fs.writeFileSync(path.join(out,'held-question.png'), (await contentWin.webContents.capturePage()).toPNG());
  await contentClick('answerCaptured');
  await until(() => requests.length === recoveryOffset + 1 && contentUI("document.getElementById('answerScroll').getAttribute('aria-busy')==='false' && document.getElementById('questionRecovery').classList.contains('hidden')"), 'visible recovery streams an answer');
  check('Recovery button submits the retained question once through production IPC', requests.at(-1).question === 'A bounded buffer using multiple producers and consumers.');
  await ui("document.getElementById('liveAutoAnswer').checked=true;document.getElementById('liveAutoAnswer').dispatchEvent(new Event('change'))");
  await until(() => ui("document.getElementById('liveAutoAnswer').checked && !document.getElementById('liveAutoAnswer').disabled"), 'Auto enabled after recovery');
  remote.emit('message', Buffer.from(JSON.stringify({type:'SpeechStarted',timestamp:18})));
  remote.transcript('What is binary search?', 19);
  await until(() => requests.length === recoveryOffset + 2 && contentUI("document.getElementById('currentQuestion').textContent==='What is binary search?' && document.getElementById('answerScroll').getAttribute('aria-busy')==='false'"), 'complete next question survives orphan VAD in production flow');
  check('A stray SpeechStarted event cannot block the next automatic answer', requests.at(-1).question === 'What is binary search?');
  const intervalRequestOffset = requests.length;
  const wireResult = (text, start, duration, isFinal) => remote.emit('message', Buffer.from(JSON.stringify({
    type:'Results',is_final:isFinal,speech_final:false,start,duration,channel:{alternatives:[{transcript:text}]}
  })));
  wireResult('Find the longest sum-K subarray. The array includes negative numbers and zeros.',22,5,false);
  wireResult('Find the longest sum-K subarray.',22,2,true);
  remote.emit('message',Buffer.from(JSON.stringify({type:'UtteranceEnd',last_word_end:24})));
  await delay(1100);
  check('Partial provider finals and UtteranceEnd cannot submit a question before its constraint',requests.length===intervalRequestOffset);
  wireResult('The array includes negative numbers and zeros.',24,3,true);
  await until(()=>requests.length===intervalRequestOffset+1 && contentUI("document.getElementById('answerScroll').getAttribute('aria-busy')==='false'"),'final constraint completes the full question');
  check('SpeechSession, turn assembly and provider request retain the complete negative-number constraint',requests.at(-1).question==='Find the longest sum-K subarray. The array includes negative numbers and zeros.');
  wireResult('Find the longest sum-K subarray.',22,2,false);
  wireResult('What is a closure?',29,2,true);
  wireResult('um',31,0.4,false);
  wireResult('',31,1,true);
  await until(()=>requests.length===intervalRequestOffset+2 && contentUI("document.getElementById('currentQuestion').textContent==='What is a closure?' && document.getElementById('answerScroll').getAttribute('aria-busy')==='false'"),'empty final clears retracted interim words');
  check('Late finalized audio and an empty final Results packet do not block the next automatic question',requests.at(-1).question==='What is a closure?');
  await contentClick('closeContent');
  await until(() => remote.closedByClient && microphone.closedByClient && ui("document.getElementById('listen').textContent==='Start listening'"), 'closing voice fallback stops both speech streams');
  check('Closing the popup ends both paid-stream equivalents and all synthetic capture resources', await ui(`flowCapture.closed===${captureBeforeVoice.closed + 1} && flowCapture.tracks.every(track=>track.stopped) && flowCapture.ports.every(port=>port.closed)`));
  check('No browser network requests or real cloud transports were used', blockedRequests.length === 0);
  await finish();
})().catch(finish);
