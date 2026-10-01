'use strict';

// Deepgram Nova streaming protocol: raw mono PCM16, credentials in headers only.
// https://developers.deepgram.com/docs/audio-keep-alive
// https://developers.deepgram.com/docs/close-stream
const MAX_BUFFER_BYTES = 1024 * 1024;
const SEND_HIGH_WATER_BYTES = 256 * 1024;
const CONNECTION_TIMEOUT_MS = 10_000;
const STOP_TIMEOUT_MS = 1_500;
const MAX_RETRIES = 3;

class SpeechSession {
  constructor({ apiKey, source, sampleRate, language = 'en', onTranscript = () => {}, onState = () => {}, onError = () => {}, WebSocketImpl } = {}) {
    if (typeof apiKey !== 'string' || !apiKey.trim() || /[\r\n]/.test(apiKey)) throw new TypeError('A valid Deepgram API key is required.');
    if (typeof source !== 'string' || !source) throw new TypeError('An audio source is required.');
    if (!Number.isInteger(sampleRate) || sampleRate < 8000 || sampleRate > 96000) throw new TypeError('Audio sample rate must be an integer from 8000 to 96000.');
    for (const callback of [onTranscript, onState, onError]) if (typeof callback !== 'function') throw new TypeError('Speech callbacks must be functions.');
    this._apiKey = apiKey.trim();
    this.source = source;
    this.sampleRate = sampleRate;
    if (!['en', 'multi'].includes(language)) throw new TypeError('Choose English or multilingual transcription.');
    this.language = language;
    this._WebSocket = WebSocketImpl || require('ws');
    this._onTranscript = onTranscript;
    this._onState = onState;
    this._onError = onError;
    this._active = false;
    this._terminal = false;
    this._stopping = false;
    this._socket = null;
    this._queue = [];
    this._queuedBytes = 0;
    this._sentBytes = 0;
    this._retries = 0;
    this._overflowReported = false;
    this._startPromise = null;
    this._stopPromise = null;
    this._state = null;
  }

  start() {
    if (this._terminal) return Promise.reject(new Error('This transcription session has stopped. Create a new session.'));
    if (this._startPromise) return this._startPromise;
    this._active = true;
    this._startPromise = new Promise((resolve, reject) => { this._resolveStart = resolve; this._rejectStart = reject; });
    this._connect();
    return this._startPromise;
  }

  sendAudio(audio) {
    if (!this._active) return false;
    if (!(audio instanceof Uint8Array)) throw new TypeError('Audio must be a Buffer or Uint8Array of PCM16 samples.');
    if (audio.byteLength % 2 !== 0) throw new TypeError('PCM16 audio must contain complete two-byte samples.');
    if (!audio.byteLength) return true;
    const socketBytes = this._socket?.bufferedAmount || 0;
    const budget = Math.max(0, MAX_BUFFER_BYTES - socketBytes);
    if (audio.byteLength > budget) {
      this._reportOverflow();
      return false;
    }
    while (this._queuedBytes + audio.byteLength > budget && this._queue.length) {
      this._queuedBytes -= this._queue.shift().byteLength;
      this._reportOverflow();
    }
    // Own the bytes: callers may reuse or transfer their capture buffers.
    const copy = Buffer.from(audio);
    this._queue.push(copy);
    this._queuedBytes += copy.byteLength;
    this._flush();
    return true;
  }

  stop() {
    if (this._stopPromise) return this._stopPromise;
    this._stopPromise = new Promise((resolve) => { this._resolveStop = resolve; });
    this._active = false;
    this._terminal = true;
    this._stopping = true;
    this._clearTimers();
    this._settleStart(new Error('Transcription stopped before connection opened.'));
    if (!this._socket || this._socket.readyState !== 1) {
      this._finishStop();
      return this._stopPromise;
    }
    // CloseStream asks Deepgram to finalize buffered audio before closing.
    this._stopTimer = setTimeout(() => this._finishStop(), STOP_TIMEOUT_MS);
    this._flush();
    return this._stopPromise;
  }

  finalize() {
    // Finalize does not close the socket. Never flush past locally buffered
    // audio: that would falsely suggest all captured speech was finalized.
    if (!this._active || this._stopping || this._socket?.readyState !== 1) return false;
    this._flush();
    if (this._queuedBytes || this._socket.bufferedAmount > SEND_HIGH_WATER_BYTES) return false;
    this._sendControl(this._socket, { type: 'Finalize' });
    return true;
  }

  _connect() {
    if (!this._active) return;
    this._setState(this._retries ? 'reconnecting' : 'connecting');
    const params = new URLSearchParams({
      model: 'nova-3', language: this.language, encoding: 'linear16', sample_rate: String(this.sampleRate),
      channels: '1', interim_results: 'true', punctuate: 'true', smart_format: 'true',
      endpointing: '500', utterance_end_ms: '1200', vad_events: 'true'
    });
    let socket;
    try {
      socket = new this._WebSocket(`wss://api.deepgram.com/v1/listen?${params}`, {
        headers: { Authorization: `Token ${this._apiKey}` },
        handshakeTimeout: CONNECTION_TIMEOUT_MS, maxPayload: MAX_BUFFER_BYTES,
        perMessageDeflate: false, followRedirects: false
      });
    } catch {
      this._connectionFailed(null, 'Could not connect to transcription service.');
      return;
    }
    this._socket = socket;
    // Times are in the submitted-audio timeline, not wall clock. Gaps or dropped
    // samples are reported visibly; already sent audio is never replayed.
    const offset = this._sentBytes / (this.sampleRate * 2);
    this._connectionTimer = setTimeout(() => this._connectionFailed(socket, 'Transcription connection timed out.'), CONNECTION_TIMEOUT_MS);
    socket.on('open', () => {
      if (socket !== this._socket || !this._active) return;
      clearTimeout(this._connectionTimer);
      this._connectionTimer = null;
      this._lastAudioAt = Date.now();
      this._setState('listening');
      this._settleStart();
      this._keepAliveTimer = setInterval(() => {
        if (socket === this._socket && this._active && Date.now() - this._lastAudioAt >= 3000 && !this._queuedBytes && !socket.bufferedAmount) {
          this._sendControl(socket, { type: 'KeepAlive' });
        }
      }, 3000);
      this._flush();
    });
    socket.on('message', (data) => this._receive(socket, data, offset));
    socket.on('error', () => this._connectionFailed(socket, 'Transcription network connection failed.'));
    socket.on('unexpected-response', (_request, response) => {
      const status = response.statusCode;
      response.resume?.(); // Discard the response body; it may contain secrets.
      const retry = status === 429 || status >= 500;
      const message = status === 401 || status === 403 ? 'Deepgram rejected the API key or its permissions.'
        : status === 429 ? 'Deepgram rate limit reached.' : 'Deepgram rejected the transcription connection.';
      this._connectionFailed(socket, message, retry);
    });
    socket.on('close', (code) => {
      if (socket !== this._socket) return;
      if (this._stopping) { this._finishStop(); return; }
      this._connectionFailed(socket, 'Transcription disconnected; recent audio may be missing.', code !== 1008 && code !== 1003);
    });
  }

  _receive(socket, data, offset) {
    if (socket !== this._socket || (!this._active && !this._stopping)) return;
    let message;
    try { message = JSON.parse(data.toString()); } catch { return; }
    if (message.type === 'Error') {
      this._connectionFailed(socket, 'Deepgram reported a transcription error. Check the service settings.', false);
      return;
    }
    if (message.type === 'Results') {
      const text = message.channel?.alternatives?.[0]?.transcript;
      if (typeof text !== 'string' || (!text.trim() && !message.speech_final && !message.is_final)) return;
      this._onTranscript({
        eventType: 'Results', fromFinalize: message.from_finalize === true,
        source: this.source, text, isFinal: message.is_final === true, speechFinal: message.speech_final === true,
        start: Number.isFinite(message.start) && message.start >= 0 ? offset + message.start : null,
        duration: Number.isFinite(message.duration) ? message.duration : 0
      });
    } else if (message.type === 'SpeechStarted') {
      // Resume the local turn before the next transcript result arrives.
      // https://developers.deepgram.com/docs/speech-started
      this._onTranscript({ eventType: 'SpeechStarted', source: this.source, text: '', isFinal: false, speechFinal: false, speechStarted: true,
        start: Number.isFinite(message.timestamp) && message.timestamp >= 0 ? offset + message.timestamp : null, duration: 0 });
    } else if (message.type === 'UtteranceEnd') {
      // An empty turn marker, never a duplicate of the previously final text.
      this._onTranscript({ eventType: 'UtteranceEnd', source: this.source, text: '', isFinal: true, speechFinal: true,
        start: Number.isFinite(message.last_word_end) && message.last_word_end >= 0 ? offset + message.last_word_end : null, duration: 0 });
    }
  }

  _flush() {
    const socket = this._socket;
    if (!socket || socket.readyState !== 1 || (!this._active && !this._stopping)) return;
    while (this._queue.length && (socket.bufferedAmount || 0) < SEND_HIGH_WATER_BYTES) {
      const audio = this._queue.shift();
      this._queuedBytes -= audio.byteLength;
      this._sentBytes += audio.byteLength;
      this._lastAudioAt = Date.now();
      try {
        socket.send(audio, { binary: true }, (error) => {
          if (error) this._connectionFailed(socket, 'Could not send audio to transcription service.');
        });
      } catch {
        this._connectionFailed(socket, 'Could not send audio to transcription service.');
      }
      if (socket !== this._socket) return;
    }
    if (!this._queue.length && !(socket.bufferedAmount || 0)) this._overflowReported = false;
    if (this._stopping && !this._queue.length && !this._closeStreamSent) {
      this._closeStreamSent = true;
      this._sendControl(socket, { type: 'CloseStream' });
    } else if (this._queue.length && !this._drainTimer) {
      this._drainTimer = setTimeout(() => { this._drainTimer = null; this._flush(); }, 50);
    }
  }

  _sendControl(socket, message) {
    try {
      socket.send(JSON.stringify(message), { binary: false }, (error) => {
        if (error) this._connectionFailed(socket, 'Transcription connection failed.');
      });
    } catch { this._connectionFailed(socket, 'Transcription connection failed.'); }
  }

  _connectionFailed(socket, message, retry = true) {
    if (socket !== this._socket) return;
    if (this._stopping) { this._finishStop(); return; }
    if (!this._active) return;
    this._clearTimers();
    this._disposeSocket();
    this._onError(message); // Never pass provider bodies, close reasons, or Error.message.
    if (!retry || this._retries >= MAX_RETRIES) {
      this._active = false;
      this._terminal = true;
      this._queue = [];
      this._queuedBytes = 0;
      this._settleStart(new Error(message));
      this._setState('stopped');
      return;
    }
    const delay = 500 * (2 ** this._retries++);
    this._setState('reconnecting');
    this._retryTimer = setTimeout(() => { this._retryTimer = null; this._connect(); }, delay);
  }

  _reportOverflow() {
    if (!this._overflowReported) this._onError('Audio buffer full; some audio was dropped. Check your connection.');
    this._overflowReported = true;
  }

  _setState(state) {
    if (this._state !== state) { this._state = state; this._onState(state); }
  }

  _settleStart(error) {
    if (!this._resolveStart) return;
    const resolve = this._resolveStart;
    const reject = this._rejectStart;
    this._resolveStart = this._rejectStart = null;
    if (error) reject(error); else resolve();
  }

  _clearTimers() {
    clearTimeout(this._connectionTimer);
    clearTimeout(this._retryTimer);
    clearTimeout(this._drainTimer);
    clearInterval(this._keepAliveTimer);
    this._connectionTimer = this._retryTimer = this._drainTimer = this._keepAliveTimer = null;
  }

  _disposeSocket() {
    const socket = this._socket;
    this._socket = null;
    if (!socket) return;
    socket.removeAllListeners();
    socket.on('error', () => {}); // Ignore late transport errors during shutdown.
    if (socket.readyState !== 3) { try { socket.terminate(); } catch {} }
  }

  _finishStop() {
    this._clearTimers();
    clearTimeout(this._stopTimer);
    this._stopTimer = null;
    this._disposeSocket();
    this._queue = [];
    this._queuedBytes = 0;
    this._stopping = false;
    this._setState('stopped');
    this._resolveStop?.();
    this._resolveStop = null;
  }
}

module.exports = { SpeechSession };
