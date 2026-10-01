'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { DEFAULT_VOICE_PHRASES, normalizeVoicePhrases, detectVoiceCommand, splitCommandPrefix, VoiceCommandMatcher, PendingQuestionBuffer } = require('./voice-fallback.cjs');
const final = (text, start = 0, source = 'you') => ({ source, text, isFinal: true, start, duration: 1 });

test('four approved phrases match strict clauses with case, punctuation, gimme and Hindi aliases', () => {
  for (const text of [...DEFAULT_VOICE_PHRASES, 'GIMME a minute to think!', 'Ek minute mujhe sochne dijiye', 'एक मिनट, मुझे सोचने दीजिए।']) {
    const result = detectVoiceCommand(text);
    assert.equal(result.matched, true, text); assert.equal(result.commandOnly, true); assert.equal(result.questionText, '');
  }
});
test('a microphone question plus a trailing command strips only the command', () => {
  for (const text of ['What are closures? Give me a minute to think.', 'What are closures give me a minute to think']) {
    const result = detectVoiceCommand(text);
    assert.equal(result.matched, true); assert.match(result.questionText, /^What are closures\??$/); assert.equal(result.commandOnly, false);
  }
  const result = detectVoiceCommand("Explain the term 'closure'. Let me think through this for a moment.");
  assert.equal(result.matched, true); assert.equal(result.questionText, "Explain the term 'closure'.");
  const missed = detectVoiceCommand('Longest contiguous subarray length for target K. Give me a minute to think.');
  assert.equal(missed.matched, true); assert.equal(missed.questionText, 'Longest contiguous subarray length for target K.');
  assert.equal(detectVoiceCommand('Give me an example. Give me a minute to think.').matched, true);
});
test('negative, quoted, incidental and metalinguistic phrases never execute', () => {
  for (const text of ["Don't give me a minute to think.", 'Do not give me a minute to think.', 'Never give me a minute to think.',
    'The phrase is give me a minute to think.', 'Say give me a minute to think.', 'What does the phrase give me a minute to think mean?',
    'What if I say give me a minute to think.', 'Explain the command give me a minute to think.',
    '"Give me a minute to think."', "'Give me a minute to think.'", '“Give me a minute to think.”',
    'He said: give me a minute to think.', 'Give me a minute to think about databases.', 'Let me think through this for a moment, please do not answer.',
    'Ek minute mujhe sochne dijiye mat bolo.', 'यह मत कहो एक मिनट मुझे सोचने दीजिए।']) {
    assert.equal(detectVoiceCommand(text).matched, false, text);
  }
});
test('configured phrases replace defaults; validation rejects unsafe or ambiguous definitions', () => {
  const phrases = ['Please answer my latest question.'];
  assert.equal(detectVoiceCommand(phrases[0], { phrases }).matched, true);
  assert.equal(detectVoiceCommand(DEFAULT_VOICE_PHRASES[0], { phrases }).matched, false);
  assert.deepEqual(normalizeVoicePhrases(['Give me a minute to think.', 'Gimme a minute to think!']), [DEFAULT_VOICE_PHRASES[0]]);
  for (const invalid of [[], ['answer'], ['one two'], ['say\nthese words'], ['"quoted phrase here"'], Array(9).fill('some phrase here')]) {
    assert.throws(() => normalizeVoicePhrases(invalid));
  }
});
test('partial suffix exposes clean question and an exact held command prefix', () => {
  assert.deepEqual(splitCommandPrefix('What is a closure? Give me a minute'), { questionText: 'What is a closure?', heldText: 'Give me a minute' });
  assert.deepEqual(splitCommandPrefix('Please explain the phrase give me a minute'), { questionText: 'Please explain the phrase give me a minute', heldText: '' });
});
test('split final commands execute once while command interims are never forwarded', () => {
  const matcher = new VoiceCommandMatcher();
  assert.deepEqual(matcher.push({ ...final('Gimme a'), isFinal: false }).forward, []);
  assert.equal(matcher.push(final('Gimme a minute')).holding, true);
  const result = matcher.push(final('to think.', 1));
  assert.equal(result.command.matched, true); assert.deepEqual(result.forward, []); assert.equal(result.holding, false);
  assert.deepEqual(matcher.flush(), { forward: [], holding: false });
});
test('question preceding split command is forwarded once with original source/timing', () => {
  const matcher = new VoiceCommandMatcher();
  const result = matcher.push(final('Explain closures. Let me think', 4));
  assert.deepEqual(result.forward, [final('Explain closures.', 4)]); assert.equal(result.holding, true);
  const next = matcher.push(final('through this for a moment.', 5));
  assert.ok(next.command); assert.deepEqual(next.forward, []);
});
test('abandoned prefixes flush losslessly; sources and sessions cannot complete each other', () => {
  const matcher = new VoiceCommandMatcher();
  matcher.push(final('Give me a'));
  const result = matcher.push(final('definition of closures.', 1));
  assert.deepEqual(result.forward.map(item => item.text), ['Give me a', 'definition of closures.']); assert.equal(result.command, undefined);
  matcher.push(final('Give me a minute', 2));
  const remote = matcher.push(final('to think.', 3, 'remote'));
  assert.equal(remote.command, undefined); assert.equal(remote.forward[0].source, 'you');
  matcher.push(final('Give me a minute', 4)); matcher.reset();
  assert.equal(matcher.push(final('to think.', 5)).command, undefined);
});
test('interim complete commands never execute and quoted split finals remain literal text', () => {
  const matcher = new VoiceCommandMatcher();
  assert.equal(matcher.push({ ...final(DEFAULT_VOICE_PHRASES[0]), isFinal: false }).command, undefined);
  const first = matcher.push(final('The phrase is give me a minute'));
  const second = matcher.push(final('to think.', 1));
  assert.equal(first.command, undefined); assert.equal(second.command, undefined);
  assert.equal(first.forward[0].text, 'The phrase is give me a minute');
});

function pending(options = {}) { let time = 0; const buffer = new PendingQuestionBuffer({ now: () => time, ...options }); buffer.reset({ sessionId: 7, source: 'remote' }); return { buffer, tick: ms => time += ms }; }
test('pending fragments merge across rejected turns and same-turn revisions replace in place', () => {
  const { buffer } = pending();
  const first = buffer.observe({ id: 'r1', source: 'remote', text: 'You are given an array.', reason: 'background' });
  buffer.observe({ id: 'r1', source: 'remote', text: 'You are given an integer array.', reason: 'background' });
  const last = buffer.observe({ id: 'r2', source: 'remote', text: 'Negative numbers are allowed.', reason: 'statement' });
  assert.equal(last.id, first.id); assert.equal(last.revision, 3);
  assert.equal(last.text, 'You are given an integer array. Negative numbers are allowed.'); assert.equal(last.canRecover, true);
});
test('acknowledgments, commands, foreign sources and old sessions do not corrupt pending question', () => {
  const { buffer } = pending(); const original = buffer.observe({ id: 'r1', source: 'remote', text: 'Explain closures.' });
  for (const input of [{ id: 'r2', source: 'remote', text: 'Did you get it?', reason: 'acknowledgment' },
    { id: 'r3', source: 'remote', text: DEFAULT_VOICE_PHRASES[0], reason: 'voice-command' },
    { id: 'y1', source: 'you', text: 'Unrelated question?' }, { id: 'r4', source: 'remote', text: 'Old question?', sessionId: 6 }]) buffer.observe(input);
  assert.deepEqual(buffer.snapshot(), original);
});
test('consume binds exact revision, retains submitted identity and blocks duplicate replay', () => {
  const { buffer } = pending(); const old = buffer.observe({ id: 'r1', source: 'remote', text: 'Explain closures.' });
  const current = buffer.observe({ id: 'r1', source: 'remote', text: 'Explain closures. Include an example.' });
  assert.equal(buffer.consume(old).reason, 'stale');
  assert.equal(buffer.consume(current).ok, true); assert.equal(buffer.snapshot().status, 'consumed');
  assert.equal(buffer.consume(current).reason, 'already-submitted');
  assert.equal(buffer.observe({ id: 'r1', source: 'remote', text: current.text }).status, 'consumed');
  const next = buffer.observe({ id: 'r1', source: 'remote', text: `${current.text} And memory risks.` });
  assert.notEqual(next.id, current.id); assert.equal(next.text, 'And memory risks.');
});
test('90-second expiry is not prolonged by duplicate finals, and fresh speech starts a new identity', () => {
  const { buffer, tick } = pending(); const input = { id: 'r1', source: 'remote', text: 'Explain closures.' };
  const first = buffer.observe(input); tick(89999); buffer.observe(input); assert.equal(buffer.snapshot().canRecover, true);
  tick(1); assert.equal(buffer.snapshot().status, 'expired'); assert.equal(buffer.consume(first).ok, false);
  const next = buffer.observe({ ...input, id: 'r2', text: 'What is the event loop?' }); assert.notEqual(next.id, first.id); assert.equal(next.text, 'What is the event loop?');
});
test('an audio gap or oversized input cannot silently recover an incomplete prompt', () => {
  const { buffer } = pending({ maxChars: 30 });
  buffer.observe({ id: 'r1', source: 'remote', text: 'Explain closures.' });
  const invalid = buffer.invalidate('audio-gap'); assert.equal(invalid.canRecover, false); assert.equal(buffer.consume(invalid).ok, false);
  const long = buffer.observe({ id: 'r2', source: 'remote', text: 'Explain '.repeat(20) });
  assert.equal(long.status, 'incomplete'); assert.equal(long.reason, 'too-long'); assert.equal(long.text.length, 30); assert.equal(long.canRecover, false);
  buffer.reset({ sessionId: 8, source: 'you' }); assert.equal(buffer.snapshot().text, ''); assert.equal(buffer.snapshot().status, 'empty');
});
test('explicit new-topic phrase replaces stale unsent background', () => {
  const { buffer } = pending(); const old = buffer.observe({ id: 'r1', source: 'remote', text: 'Given an array.' });
  const next = buffer.observe({ id: 'r2', source: 'remote', text: 'New question: explain closures.' });
  assert.notEqual(next.id, old.id); assert.equal(next.text, 'New question: explain closures.');
});

test('duplicate command finals cannot corrupt a held prefix or execute again', () => {
  const matcher = new VoiceCommandMatcher(); const prefix = final('Give me a minute');
  matcher.push(prefix); assert.equal(matcher.push(prefix).duplicate, true);
  const ending = final('to think.', 1); assert.ok(matcher.push(ending).command);
  assert.equal(matcher.push(ending).command, undefined);
});
test('negation and mention in a preceding final still suppress the following command', () => {
  for (const prefix of ['Do not', 'He said:', 'He said.', 'The phrase is']) {
    const matcher = new VoiceCommandMatcher(); matcher.push(final(prefix));
    const result = matcher.push(final(DEFAULT_VOICE_PHRASES[0], 1));
    assert.equal(result.command, undefined, prefix); assert.equal(result.forward[0].text, DEFAULT_VOICE_PHRASES[0]);
  }
});
test('expired and gap-invalidated fragments cannot be resurrected by identical replay', () => {
  const { buffer, tick } = pending(); const input = { id: 'r1', source: 'remote', text: 'Explain closures.' };
  buffer.observe(input); tick(90000); assert.equal(buffer.observe(input).status, 'expired');
  buffer.observe({ ...input, id: 'r2' }); buffer.invalidate('audio-gap');
  assert.equal(buffer.observe({ ...input, id: 'r2' }).status, 'incomplete');
});
test('terminal incomplete decisions invalidate unchanged text already published by onUpdate', () => {
  for (const reason of ['incomplete-audio', 'too-long']) {
    const { buffer } = pending(); const input = { id: 'r1', source: 'remote', text: 'Explain closures.' };
    const ready = buffer.observe(input); const unsafe = buffer.observe({ ...input, reason });
    assert.equal(unsafe.status, 'incomplete'); assert.equal(unsafe.reason, reason); assert.equal(unsafe.canRecover, false);
    assert.equal(buffer.consume(ready).reason, 'stale'); assert.equal(buffer.consume(unsafe).ok, false);
  }
  const { buffer } = pending(); const input = { id: 'r1', source: 'remote', text: 'Explain closures.' };
  const ready = buffer.observe(input); buffer.consume(ready);
  assert.equal(buffer.observe({ ...input, reason: 'incomplete-audio' }).status, 'consumed');
});
test('a fresh independent manual question replaces the complete unsubmitted predecessor', () => {
  const { buffer } = pending(); const old = buffer.observe({ id: 'r1', source: 'remote', text: 'Explain closures.' });
  const next = buffer.observe({ id: 'r2', source: 'remote', text: 'What is binary search?' });
  assert.notEqual(next.id, old.id); assert.equal(next.text, 'What is binary search?');
  const task = buffer.observe({ id: 'r3', source: 'remote', text: 'Design a least recently used cache.' });
  assert.notEqual(task.id, next.id); assert.equal(task.text, 'Design a least recently used cache.');
  buffer.observe({ id: 'r4', source: 'remote', text: 'Can you explain', reason: 'incomplete' });
  const completed = buffer.observe({ id: 'r4', source: 'remote', text: 'Can you explain binary search?' });
  assert.notEqual(completed.id, task.id); assert.equal(completed.text, 'Can you explain binary search?');
});
test('background, constraints, objective and dependent followups stay together until submitted', () => {
  const { buffer } = pending();
  buffer.observe({ id: 'r1', source: 'remote', text: 'Given an integer array.' });
  buffer.observe({ id: 'r2', source: 'remote', text: 'Negative numbers are allowed.' });
  const task = buffer.observe({ id: 'r3', source: 'remote', text: 'Return the longest contiguous subarray with sum K.' });
  assert.equal(task.text, 'Given an integer array. Negative numbers are allowed. Return the longest contiguous subarray with sum K.');
  const amended = buffer.observe({ id: 'r4', source: 'remote', text: 'Actually, return only its length.' });
  assert.equal(amended.id, task.id); assert.ok(amended.text.endsWith('Actually, return only its length.'));
  const last = buffer.observe({ id: 'r5', source: 'remote', text: 'And in Java.' });
  assert.equal(last.id, task.id); assert.ok(last.text.endsWith('And in Java.'));
});

test('quotes opened in a previous final keep subsequent complete commands literal until closed', () => {
  for (const [open, close] of [['He said "', '"'], ['He said “', '”'], ['He said `', '`'], ["He said 'quoted", "words'"]]) {
    const matcher = new VoiceCommandMatcher(); matcher.push(final(open));
    const quoted = matcher.push(final('Give me a minute to think.', 1));
    assert.equal(quoted.command, undefined, open); assert.equal(quoted.forward[0].text, 'Give me a minute to think.');
    assert.equal(matcher.push(final('Let me think through this for a moment.', 2)).command, undefined);
    matcher.push(final(close, 3));
    assert.ok(matcher.push(final('Give me a minute to think.', 4)).command, 'A later unquoted cue remains available');
  }
});
test('quote context resets with session or source; apostrophes in contractions do not open quotes', () => {
  const matcher = new VoiceCommandMatcher(); matcher.push(final("I don't know the answer."));
  assert.ok(matcher.push(final('Give me a minute to think.', 1)).command);
  matcher.push(final('He said "', 2)); matcher.reset();
  assert.ok(matcher.push(final('Give me a minute to think.', 3)).command);
  matcher.push(final('He said “', 4));
  assert.ok(matcher.push(final('Give me a minute to think.', 5, 'remote')).command);
});
