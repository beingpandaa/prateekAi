'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { SpeechSession } = require('./speech.cjs');

function harness(t, options = {}) {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: 0 });
  const sockets = [];
  class MockWebSocket extends EventEmitter {
    constructor(url, options) {
      super();
      this.url = url;
      this.options = options;
      this.readyState = 0;
      this.bufferedAmount = 0;
      this.sent = [];
      this.terminated = false;
      sockets.push(this);
    }
    open() { this.readyState = 1; this.emit('open'); }
    send(data, options, callback) {
      assert.equal(this.readyState, 1);
      this.sent.push({ data: typeof data === 'string' ? data : Buffer.from(data), options });
      callback?.();
    }
    serverClose(code = 1006) { this.readyState = 3; this.emit('close', code, Buffer.from('untrusted close reason')); }
    terminate() { this.terminated = true; this.readyState = 3; this.emit('close', 1006); }
    result(value) { this.emit('message', Buffer.from(JSON.stringify(value))); }
  }
  const states = [];
  const errors = [];
  const transcripts = [];
  const session = new SpeechSession({
    apiKey: 'secret-token', source: 'remote', sampleRate: 16000, WebSocketImpl: MockWebSocket,
    onState: (state) => states.push(state), onError: (error) => errors.push(error), onTranscript: (text) => transcripts.push(text), ...options
  });
  t.after(async () => {
    const stopped = session.stop();
    t.mock.timers.tick(1500);
    await stopped;
  });
  return { session, sockets, states, errors, transcripts, tick: (ms) => t.mock.timers.tick(ms) };
}

test('connects only to Deepgram with PCM options and authorization outside URL', async (t) => {
  const { session, sockets, states } = harness(t);
  const started = session.start();
  assert.equal(session.start(), started);
  assert.equal(sockets.length, 1);
  const ws = sockets[0];
  const url = new URL(ws.url);
  assert.equal(url.origin, 'wss://api.deepgram.com');
  assert.equal(url.pathname, '/v1/listen');
  assert.equal(url.searchParams.get('model'), 'nova-3');
  assert.equal(url.searchParams.get('language'), 'en');
  assert.equal(url.searchParams.get('encoding'), 'linear16');
  assert.equal(url.searchParams.get('sample_rate'), '16000');
  assert.equal(url.searchParams.get('channels'), '1');
  assert.equal(url.searchParams.get('endpointing'), '500');
  assert.equal(url.searchParams.get('utterance_end_ms'), '1200');
  assert.equal(url.searchParams.get('vad_events'), 'true');
  assert.equal(url.searchParams.get('interim_results'), 'true');
  assert.equal(ws.url.includes('secret-token'), false);
  assert.equal(ws.options.headers.Authorization, 'Token secret-token');
  assert.equal(ws.options.followRedirects, false);
  ws.open();
  await started;
  assert.deepEqual(states, ['connecting', 'listening']);
});

test('ignores legacy vocabulary options and never requests the paid add-on', async (t) => {
  const { session, sockets } = harness(t, { keyterms: ['Siebel CRM', 'eScript', 'Siebel CRM', 'EAI Siebel Adapter'] });
  const started = session.start();
  assert.equal(new URL(sockets[0].url).searchParams.has('keyterm'), false);
  assert.equal(new URL(sockets[0].url).searchParams.has('keywords'), false);
  sockets[0].open(); await started;
});

test('retains source labels, separates final text from empty end-of-turn markers', async (t) => {
  const { session, sockets, transcripts } = harness(t);
  const started = session.start();
  sockets[0].open();
  await started;
  const ws = sockets[0];
  ws.emit('message', Buffer.from('invalid JSON'));
  ws.result({ type: 'Metadata' });
  ws.result({ type: 'Results', channel: { alternatives: [{ transcript: 'How does' }] }, start: 1, duration: 0.5 });
  ws.result({ type: 'Results', channel: { alternatives: [{ transcript: 'How does this work?' }] }, is_final: true, speech_final: true, start: 1, duration: 1.4 });
  ws.result({ type: 'UtteranceEnd', last_word_end: 2.4 });
  assert.deepEqual(transcripts, [
    { eventType: 'Results', fromFinalize: false, source: 'remote', text: 'How does', isFinal: false, speechFinal: false, start: 1, duration: 0.5 },
    { eventType: 'Results', fromFinalize: false, source: 'remote', text: 'How does this work?', isFinal: true, speechFinal: true, start: 1, duration: 1.4 },
    { eventType: 'UtteranceEnd', source: 'remote', text: '', isFinal: true, speechFinal: true, start: 2.4, duration: 0 }
  ]);
});

test('copies queued audio, bounds it to 1 MiB, and visibly reports drops', async (t) => {
  const { session, sockets, errors } = harness(t);
  const started = session.start();
  const chunk = new Uint8Array(64 * 1024);
  for (let index = 0; index < 17; index++) {
    chunk.fill(index);
    assert.equal(session.sendAudio(chunk), true);
  }
  chunk.fill(255);
  assert.equal(session._queuedBytes, 1024 * 1024);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /dropped/);
  sockets[0].open();
  await started;
  const audio = sockets[0].sent.filter((item) => item.options.binary);
  assert.equal(audio.length, 16);
  assert.equal(audio[0].data[0], 1);
  assert.equal(audio.at(-1).data[0], 16);
  assert.equal(audio.reduce((sum, item) => sum + item.data.length, 0), 1024 * 1024);
});

test('forwards speech resumption immediately without inventing transcript text', async (t) => {
  const { session, sockets, transcripts } = harness(t);
  const started = session.start(); sockets[0].open(); await started;
  sockets[0].result({ type: 'SpeechStarted', channel: [0, 1], timestamp: 9.54 });
  assert.deepEqual(transcripts, [{ eventType: 'SpeechStarted', source: 'remote', text: '', isFinal: false, speechFinal: false, speechStarted: true, start: 9.54, duration: 0 }]);
});

test('empty finalized Results preserve audio coverage independently of speech-final and utterance markers', async t => {
  const {session,sockets,transcripts}=harness(t); const start=session.start(); sockets[0].open(); await start;
  sockets[0].result({type:'Results',is_final:true,speech_final:false,from_finalize:true,start:6,duration:1,channel:{alternatives:[{transcript:''}]}});
  sockets[0].result({type:'UtteranceEnd',last_word_end:7});
  assert.equal(transcripts.length,2);
  assert.equal(transcripts[0].eventType,'Results'); assert.equal(transcripts[0].isFinal,true);
  assert.equal(transcripts[0].speechFinal,false); assert.equal(transcripts[0].fromFinalize,true);
  assert.equal(transcripts[0].duration,1); assert.equal(transcripts[1].eventType,'UtteranceEnd'); assert.equal(transcripts[1].duration,0);
});

test('handles socket backpressure without busy-looping or an unbounded queue', async (t) => {
  const { session, sockets, errors, tick } = harness(t);
  const started = session.start();
  const ws = sockets[0];
  ws.open();
  await started;
  ws.bufferedAmount = 1024 * 1024;
  assert.equal(session.sendAudio(Buffer.alloc(3200)), false);
  assert.equal(session._queuedBytes, 0);
  assert.match(errors[0], /buffer full/);
  ws.bufferedAmount = 300 * 1024;
  session.sendAudio(Buffer.alloc(3200, 4));
  assert.equal(ws.sent.length, 0);
  tick(50);
  assert.equal(ws.sent.length, 0);
  ws.bufferedAmount = 0;
  tick(50);
  assert.equal(ws.sent.length, 1);
  assert.equal(ws.sent[0].data[0], 4);
});

test('sends KeepAlive as text at idle intervals, not during recent audio', async (t) => {
  const { session, sockets, tick } = harness(t);
  const started = session.start();
  const ws = sockets[0];
  ws.open();
  await started;
  tick(3000);
  assert.deepEqual(ws.sent[0], { data: '{"type":"KeepAlive"}', options: { binary: false } });
  tick(1000);
  session.sendAudio(Buffer.alloc(3200));
  tick(2000);
  assert.equal(ws.sent.filter((item) => !item.options.binary).length, 1);
  tick(3000);
  assert.equal(ws.sent.filter((item) => !item.options.binary).length, 2);
});

test('retries network failures only three times and never exposes transport errors', async (t) => {
  const { session, sockets, states, errors, tick } = harness(t);
  const started = session.start();
  sockets[0].open();
  await started;
  for (const delay of [500, 1000, 2000]) {
    const previous = sockets.at(-1);
    previous.emit('error', new Error('Authorization: Token secret-token'));
    const count = sockets.length;
    tick(delay - 1);
    assert.equal(sockets.length, count);
    tick(1);
    assert.equal(sockets.length, count + 1);
    sockets.at(-1).open();
  }
  sockets.at(-1).serverClose();
  tick(60_000);
  assert.equal(sockets.length, 4);
  assert.equal(states.at(-1), 'stopped');
  assert.equal(errors.some((error) => error.includes('secret-token')), false);
  assert.equal(session.sendAudio(Buffer.alloc(2)), false);
});

test('times out a hung handshake and stops retries immediately when stopped', async (t) => {
  const { session, sockets, states, errors, tick } = harness(t);
  const started = session.start();
  const rejected = assert.rejects(started, /stopped before connection/);
  tick(10_000);
  assert.equal(sockets[0].terminated, true);
  assert.match(errors[0], /timed out/);
  assert.equal(states.at(-1), 'reconnecting');
  await session.stop();
  await rejected;
  tick(60_000);
  assert.equal(sockets.length, 1);
  assert.equal(states.at(-1), 'stopped');
  await assert.rejects(session.start(), /has stopped/);
});

test('fails authentication without retries or leaking HTTP bodies', async (t) => {
  const { session, sockets, errors, states, tick } = harness(t);
  const rejected = assert.rejects(session.start(), /rejected the API key/);
  let discarded = false;
  sockets[0].emit('unexpected-response', {}, { statusCode: 401, body: 'secret-token', resume() { discarded = true; } });
  await rejected;
  tick(60_000);
  assert.equal(discarded, true);
  assert.equal(sockets.length, 1);
  assert.equal(states.at(-1), 'stopped');
  assert.equal(errors.join(' ').includes('secret-token'), false);
});

test('reconnection never replays sent audio and offsets server timestamps', async (t) => {
  const { session, sockets, transcripts, tick } = harness(t);
  const started = session.start();
  sockets[0].open();
  await started;
  session.sendAudio(Buffer.alloc(32000, 1)); // one second, sent once
  sockets[0].serverClose();
  session.sendAudio(Buffer.alloc(3200, 2)); // queued while reconnecting
  tick(500);
  const current = sockets[1];
  current.open();
  assert.equal(current.sent.length, 1);
  assert.equal(current.sent[0].data.length, 3200);
  current.result({ type: 'Results', start: 0.1, duration: 0.2, channel: { alternatives: [{ transcript: 'new words' }] }, is_final: true });
  assert.equal(transcripts[0].start, 1.1);
  // A retired transport cannot emit duplicate results or schedule another retry.
  sockets[0].result({ type: 'Results', channel: { alternatives: [{ transcript: 'stale' }] } });
  assert.equal(transcripts.length, 1);
});

test('stop drains queued audio before CloseStream and accepts the final result', async (t) => {
  const { session, sockets, transcripts, tick } = harness(t);
  const started = session.start();
  const ws = sockets[0];
  ws.open();
  await started;
  ws.bufferedAmount = 300 * 1024;
  session.sendAudio(Buffer.alloc(3200));
  const stopped = session.stop();
  assert.equal(session.stop(), stopped);
  assert.equal(session.sendAudio(Buffer.alloc(2)), false);
  ws.bufferedAmount = 0;
  tick(50);
  assert.equal(ws.sent[0].options.binary, true);
  assert.deepEqual(ws.sent[1], { data: '{"type":"CloseStream"}', options: { binary: false } });
  ws.result({ type: 'Results', channel: { alternatives: [{ transcript: 'last words' }] }, is_final: true, speech_final: true });
  ws.serverClose(1000);
  await stopped;
  assert.equal(transcripts[0].text, 'last words');
  const sent = ws.sent.length;
  tick(60_000);
  assert.equal(ws.sent.length, sent);
  assert.equal(sockets.length, 1);
});

test('forces a bounded shutdown if the server never closes', async (t) => {
  const { session, sockets, states, tick } = harness(t);
  const started = session.start();
  sockets[0].open();
  await started;
  const stopped = session.stop();
  tick(1499);
  assert.equal(sockets[0].terminated, false);
  tick(1);
  await stopped;
  assert.equal(sockets[0].terminated, true);
  assert.equal(states.at(-1), 'stopped');
  tick(60_000);
  assert.equal(sockets.length, 1);
});

test('rejects malformed capture bytes before sending to the paid service', async (t) => {
  const { session, sockets } = harness(t);
  const started = session.start();
  sockets[0].open();
  await started;
  assert.throws(() => session.sendAudio('audio'), /Buffer or Uint8Array/);
  assert.throws(() => session.sendAudio(Buffer.alloc(3)), /complete two-byte/);
  assert.equal(sockets[0].sent.length, 0);
});

test('Finalize flushes without closing a healthy stream and accepts another question', async t => {
  const h = harness(t, {language:'multi'}); const starting = h.session.start(); h.sockets[0].open(); await starting;
  assert.equal(new URL(h.sockets[0].url).searchParams.get('language'), 'multi');
  h.session.sendAudio(Buffer.from([0,0,0,0]));
  assert.equal(h.session.finalize(), true);
  assert.equal(h.sockets[0].sent.filter(x => typeof x.data === 'string' && JSON.parse(x.data).type === 'Finalize').length, 1);
  assert.equal(h.sockets[0].terminated, false);
  assert.equal(h.session.sendAudio(Buffer.from([0,0])), true);
});

test('Finalize cannot claim to flush a disconnected or backlogged stream', async t => {
  const h = harness(t); assert.equal(h.session.finalize(), false);
  const starting = h.session.start(); h.sockets[0].open(); await starting;
  h.sockets[0].bufferedAmount = 300000;
  h.session.sendAudio(Buffer.from([0,0])); assert.equal(h.session.finalize(), false);
  h.sockets[0].bufferedAmount = 0;
});

test('invalid provider timestamps cannot invent finalized audio coverage', async t => {
  const h=harness(t); const starting=h.session.start(); h.sockets[0].open(); await starting;
  for (const start of [undefined, null, -1, '0']) {
    h.sockets[0].result({type:'Results',is_final:true,start,duration:2,channel:{alternatives:[{transcript:''}]}});
    assert.equal(h.transcripts.at(-1).start,null);
    h.sockets[0].result({type:'SpeechStarted',timestamp:start});
    assert.equal(h.transcripts.at(-1).start,null);
    h.sockets[0].result({type:'UtteranceEnd',last_word_end:start});
    assert.equal(h.transcripts.at(-1).start,null);
  }
});
