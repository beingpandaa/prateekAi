'use strict';
const { contextBridge } = require('electron');
let listener, sequence = 0, resolveSnapshot, resolveAsk, rejected = false, holdResize = false;
const resizeResolvers = [];
const settings = { answerFontSize: 20, backgroundOpacity: 92, autoAnswer: true, sessionMode: 'call' };
const calls = { asks: [], cancel: 0, setup: 0, close: 0, hide: 0, stops: 0, fonts: [], opacity: [], resizes: [] };
const emit = event => {
  const seq = Number.isFinite(event.seq) ? event.seq : sequence + 1;
  sequence = Math.max(sequence, seq);
  listener?.({ ...event, seq });
};
contextBridge.exposeInMainWorld('prateekAi', {
  onEvent: callback => { listener = callback; },
  contentState: () => new Promise(resolve => { resolveSnapshot = resolve; }),
  showConfiguration: async () => { calls.setup++; },
  hideContent: async () => { calls.hide++; },
  closeContent: async () => { calls.close++; },
  resizeContent: size => { calls.resizes.push(size); return holdResize ? new Promise(resolve => resizeResolvers.push(() => resolve(size))) : Promise.resolve(size); },
  ask: question => { calls.asks.push(question); if (rejected) { rejected = false; return Promise.reject(new Error('Test provider not connected.')); } return new Promise(resolve => { resolveAsk = resolve; }); },
  cancelAnswer: async () => { calls.cancel++; emit({ type: 'answer-cancelled' }); resolveAsk?.({ ok: true }); },
  stop: async () => { calls.stops++; emit({ type: 'session-stopped', reason: 'Listening stopped.' }); },
  clear: async () => emit({ type: 'session-reset' }),
  setTextSize: async value => { calls.fonts.push(value); settings.answerFontSize = value; emit({ type: 'settings-changed', settings: { ...settings } }); return value; },
  setAppearance: async value => { calls.opacity.push(value); settings.backgroundOpacity = value; emit({ type: 'settings-changed', settings: { ...settings } }); return value; },
});
contextBridge.exposeInMainWorld('contentTest', {
  emit,
  resolveSnapshot: snapshot => { sequence = Math.max(sequence, snapshot.seq || 0); Object.assign(settings, snapshot.settings); resolveSnapshot({ settings: { ...settings }, ...snapshot }); },
  rejectNext: () => { rejected = true; },
  holdResize: value => { holdResize = value; },
  finishResize: () => resizeResolvers.shift()?.(),
  finish: event => { emit(event); resolveAsk?.({ ok: true }); },
  calls: () => calls,
});
