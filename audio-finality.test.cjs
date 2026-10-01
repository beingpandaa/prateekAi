'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { AudioFinality } = require('./audio-finality.cjs');

const interim = (start, duration, text = 'Question and constraint') => ({ eventType: 'Results', text, start, duration, isFinal: false });
const final = (start, duration, text = 'A finalized question', speechFinal = true) => ({ eventType: 'Results', text, start, duration, isFinal: true, speechFinal });
const vad = start => ({ eventType: 'SpeechStarted', speechStarted: true, start, text: '', isFinal: false });
const span = (start, end, hasText = true) => ({ start, end, hasText });

test('a late interim wholly within a final cannot reopen the completed question', () => {
  const tracker = new AudioFinality();
  tracker.push(final(4, 2));
  assert.deepEqual(tracker.push(interim(4, 2)), { ignored: true, reason: 'already-finalized', pending: [] });
});

test('a covering empty final Results clears a retracted interim without adding words', () => {
  const tracker = new AudioFinality();
  tracker.push(final(4, 2));
  tracker.push(interim(6, 0.4, 'um'));
  assert.deepEqual(tracker.push(final(6, 1, '', false)), { ignored: false, pending: [] });
  assert.equal(tracker.push(interim(6, 0.4)).ignored, true);
});

test('a late interim from a previous question cannot block the next complete question', () => {
  const tracker = new AudioFinality();
  tracker.push(final(0, 2));
  assert.equal(tracker.push(interim(0, 2)).ignored, true);
  assert.deepEqual(tracker.push(final(4, 2)).pending, []);
});

test('a short final preserves the unfinished tail of a longer earlier interim', () => {
  const tracker = new AudioFinality();
  tracker.push(interim(4, 5));
  assert.deepEqual(tracker.push(final(4, 2, 'Question only', false)).pending, [span(6, 9)]);
  assert.deepEqual(tracker.push(final(6, 3, 'Additional constraint')).pending, []);
});

test('float32 rounding at the final end does not leave a microscopic pending tail', () => {
  const tracker = new AudioFinality();
  tracker.push(interim(4, 5));
  tracker.push(final(4, 2));
  assert.deepEqual(tracker.push(final(6, 2.9999998)).pending, []);
  assert.equal(tracker.push(interim(4, 5)).ignored, true);
});

test('real uncovered tails longer than one millisecond remain pending', () => {
  const tracker = new AudioFinality();
  tracker.push(interim(4, 5));
  const result = tracker.push(final(4, 4.998));
  assert.equal(result.pending.length, 1);
  assert.equal(result.pending[0].hasText, true);
  assert.ok(Math.abs(result.pending[0].start - 8.998) < 1e-9);
  assert.equal(result.pending[0].end, 9);
});

test('fully covered intervals shorter than the arithmetic tolerance still settle', () => {
  const tracker = new AudioFinality();
  tracker.push(interim(4, 0.0005));
  assert.deepEqual(tracker.push(final(4, 0.0005)).pending, []);
});

test('a final in the middle of an interim preserves both uncovered pieces', () => {
  const tracker = new AudioFinality();
  tracker.push(interim(0, 10));
  assert.deepEqual(tracker.push(final(3, 2)).pending, [span(0, 3), span(5, 10)]);
  assert.deepEqual(tracker.push(final(0, 3)).pending, [span(5, 10)]);
});

test('a late interim overlapping several finalized ranges retains only uncovered gaps', () => {
  const tracker = new AudioFinality();
  tracker.push(final(0, 2));
  tracker.push(final(4, 2));
  assert.deepEqual(tracker.push(interim(1, 6)).pending, [span(2, 4), span(6, 7)]);
});

test('partial final end shifts do not remove a text-bearing constraint tail', () => {
  const tracker = new AudioFinality();
  tracker.push(interim(4, 5));
  tracker.push(final(3.5, 2.5));
  assert.deepEqual(tracker.snapshot(), [span(6, 9)]);
  tracker.push(interim(5, 5));
  assert.deepEqual(tracker.snapshot(), [span(6, 10)]);
});

test('an empty UtteranceEnd does not finalize newer speech, even with a fabricated duration', () => {
  const tracker = new AudioFinality();
  tracker.push(interim(4, 3));
  for (const duration of [0, 5]) {
    const result = tracker.push({ eventType: 'UtteranceEnd', text: '', start: 4, duration, isFinal: true, speechFinal: true });
    assert.equal(result.ignored, true);
    assert.deepEqual(result.pending, [span(4, 7)]);
  }
});

test('an empty final requires explicit Results identity and a positive valid interval', () => {
  const tracker = new AudioFinality();
  tracker.push(interim(4, 3));
  for (const result of [
    { text: '', start: 4, duration: 3, isFinal: true },
    final(4, 0, ''), final(4, -3, ''), final(4, NaN, ''), final(4, Infinity, ''),
    final(NaN, 3, ''), final(-1, 10, ''), final(4, undefined, ''),
  ]) {
    assert.equal(tracker.push(result).ignored, true);
    assert.deepEqual(tracker.snapshot(), [span(4, 7)]);
  }
});

test('unrelated empty final coverage cannot clear genuine unfinished text', () => {
  const tracker = new AudioFinality();
  tracker.push(interim(4, 3));
  assert.deepEqual(tracker.push(final(0, 2, '')).pending, [span(4, 7)]);
  assert.deepEqual(tracker.push(final(8, 2, '')).pending, [span(4, 7)]);
  assert.deepEqual(tracker.push(final(5, 1, '')).pending, [span(4, 5), span(6, 7)]);
});

test('newer finalized audio clears an older VAD-only onset but not newer speech', () => {
  const tracker = new AudioFinality();
  tracker.push(vad(0)); tracker.push(vad(4)); tracker.push(vad(5));
  assert.deepEqual(tracker.push(final(2, 2)).pending, [span(4, null, false), span(5, null, false)]);
});

test('a late VAD onset inside finalized audio is ignored but its end boundary is new speech', () => {
  const tracker = new AudioFinality();
  tracker.push(final(2, 2));
  assert.equal(tracker.push(vad(2)).ignored, true);
  assert.equal(tracker.push(vad(3.998)).ignored, true);
  assert.deepEqual(tracker.push(vad(4)).pending, [span(4, null, false)]);
});

test('repeated interim spans merge without accumulating duplicate pending entries', () => {
  const tracker = new AudioFinality();
  tracker.push(vad(0));
  tracker.push(interim(0, 2)); tracker.push(interim(0, 2)); tracker.push(interim(0, 3));
  assert.deepEqual(tracker.snapshot(), [span(0, 3)]);
});

test('untimed text compatibility never treats missing timing as known audio coverage', () => {
  const tracker = new AudioFinality();
  tracker.push({ text: 'An untimed interim', isFinal: false });
  tracker.push(interim(4, 2));
  assert.deepEqual(tracker.push({ text: 'An untimed final', isFinal: true }).pending, [span(4, 6)]);
  assert.equal(tracker.push(interim(0, 2)).ignored, false);
  assert.deepEqual(tracker.snapshot(), [span(0, 2), span(4, 6)]);
});

test('invalid-duration nonempty finals do not settle known timed spans', () => {
  const tracker = new AudioFinality();
  tracker.push(interim(4, 3));
  for (const duration of [-1, 0, NaN, Infinity, undefined]) {
    assert.deepEqual(tracker.push(final(4, duration)).pending, [span(4, 7)]);
  }
});

test('empty coverage cannot settle text lacking a known audio interval', () => {
  const tracker = new AudioFinality();
  tracker.push({ text: 'Untimed words', isFinal: false });
  assert.deepEqual(tracker.push(final(0, 20, '')).pending, [span(null, null)]);
  assert.deepEqual(tracker.push(final(0, 20, 'Final words')).pending, []);
});

test('known ranges cannot hide a text-bearing observation whose end is unknown', () => {
  const tracker = new AudioFinality();
  tracker.push(interim(4, 2));
  tracker.push(interim(5, undefined));
  assert.deepEqual(tracker.push(final(4, 2, '')).pending, [span(5, null)]);
  assert.deepEqual(tracker.push(final(5, 2)).pending, []);
});

test('clearPending removes expired state while retaining finalized coverage', () => {
  const tracker = new AudioFinality();
  tracker.push(final(0, 2)); tracker.push(interim(4, 3)); tracker.push(vad(8));
  assert.deepEqual(tracker.clearPending({ vadOnly: true }), [span(4, 7)]);
  assert.deepEqual(tracker.clearPending(), []);
  assert.equal(tracker.push(interim(0, 2)).ignored, true);
});

test('reset isolates a new source/connection timeline and discards all previous coverage', () => {
  const tracker = new AudioFinality();
  tracker.push(final(0, 2)); tracker.push(interim(4, 3));
  tracker.reset();
  assert.deepEqual(tracker.snapshot(), []);
  assert.deepEqual(tracker.push(interim(0, 2)).pending, [span(0, 2)]);
});

test('separate instances never transfer finalized coverage between audio sources', () => {
  const remote = new AudioFinality(), microphone = new AudioFinality();
  remote.push(final(0, 2));
  assert.deepEqual(microphone.push(interim(0, 2)).pending, [span(0, 2)]);
});

test('pending snapshots are copies and cannot mutate the tracker', () => {
  const tracker = new AudioFinality();
  const result = tracker.push(interim(0, 2));
  result.pending[0].end = 100; result.pending.push(span(10, 20));
  tracker.snapshot()[0].hasText = false;
  assert.deepEqual(tracker.snapshot(), [span(0, 2)]);
});

test('pending overflow is bounded and latched until explicit discard or reset', () => {
  const tracker = new AudioFinality();
  let result;
  for (let i = 0; i < 33; i++) result = tracker.push(interim(i * 2, 1));
  assert.equal(result.overflow, true);
  assert.equal(result.pending.length, 32);
  assert.equal(tracker.push(final(0, 100)).overflow, true);
  tracker.clearPending({ vadOnly: true });
  assert.equal(tracker.push(final(100, 1)).overflow, true);
  tracker.clearPending();
  assert.equal(tracker.push(interim(102, 1)).overflow, undefined);
});

test('finalized interval history is bounded without filling unfinalized gaps', () => {
  const tracker = new AudioFinality();
  for (let i = 0; i < 200; i++) tracker.push(final(i * 2, 1));
  assert.equal(tracker._finalized.length, 128);
  assert.equal(tracker.push(interim(398, 1)).ignored, true);
  assert.deepEqual(tracker.push(interim(397, 1)).pending, [span(397, 398)]);
});

test('adjacent finalized intervals merge and jointly cover a later interim', () => {
  const tracker = new AudioFinality();
  tracker.push(final(0, 1)); tracker.push(final(1, 1)); tracker.push(final(2, 1));
  assert.deepEqual(tracker._finalized, [{ start: 0, end: 3 }]);
  assert.equal(tracker.push(interim(0, 3)).ignored, true);
});
