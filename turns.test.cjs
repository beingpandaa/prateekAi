'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { TurnAssembler, looksLikeQuestion, classifyTurn } = require('./turns.cjs');

class Clock {
  time = 0;
  next = 0;
  timers = new Map();
  now = () => this.time;
  setTimer = (fn, delay) => {
    const id = ++this.next;
    this.timers.set(id, { fn, at: this.time + delay });
    return id;
  };
  clearTimer = id => { this.timers.delete(id); };
  tick(ms) {
    const end = this.time + ms;
    let iterations = 0;
    while (true) {
      const next = [...this.timers].sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
      if (!next || next[1].at > end) break;
      assert.ok(++iterations < 10000, 'Timer did not settle');
      this.time = next[1].at;
      this.timers.delete(next[0]);
      next[1].fn();
    }
    this.time = end;
  }
}

function setup(options = {}) {
  const clock = new Clock();
  const updates = [], turns = [];
  const assembler = new TurnAssembler({ now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer,
    onUpdate: turn => updates.push(turn), onTurn: turn => turns.push(turn), ...options });
  return { clock, updates, turns, assembler };
}
const final = (text, start = 0, duration = 1, source = 'you') => ({ source, text, start, duration, isFinal: true, speechFinal: true });
const interim = (text, start = 1, duration = 1, source = 'you') => ({ source, text, start, duration, isFinal: false });
const endMarker = (source = 'you') => ({ source, text: '', isFinal: true, speechFinal: true });

test('a completed question dispatches exactly 800ms after its final transcript arrives', () => {
  const { assembler, clock, turns } = setup();
  assembler.push(final('What are closures?'));
  clock.tick(799);
  assert.equal(turns.length, 0, 'Keep the short settling window for resumed speech');
  clock.tick(1);
  assert.equal(turns.length, 1, 'Do not add another provider-endpoint or answer-generation delay');
  assert.equal(turns[0].question, true);
  assert.equal(clock.timers.size, 0);
});

test('joins the user example across a two-second pause into one automatic question', () => {
  const { assembler, clock, updates, turns } = setup();
  assembler.push(final('Can you explain me'));
  clock.tick(2000);
  assert.equal(turns.length, 0, 'An incomplete prefix must wait for its subject');
  assembler.push(final('what are closures?', 2, 1));
  assert.equal(updates.length, 2);
  assert.equal(updates[0].id, updates[1].id);
  assert.equal(updates[1].text, 'Can you explain me what are closures?');
  clock.tick(799);
  assert.equal(turns.length, 0);
  clock.tick(1);
  assert.deepEqual(turns, [{ id: updates[0].id, source: 'you', text: 'Can you explain me what are closures?', question: true, reason: 'question', kind: 'question' }]);
});

test('every final restarts quiet settling, even without speechFinal', () => {
  const { assembler, clock, turns } = setup();
  assembler.push(final('Explain closures.'));
  clock.tick(600);
  assembler.push({ ...final('Use a JavaScript example.', 1, 1), speechFinal: false });
  clock.tick(200);
  assert.equal(turns.length, 0, 'The first segment timer must not win');
  clock.tick(599);
  assert.equal(turns.length, 0, 'Settle from the latest final rather than the first one');
  clock.tick(1);
  assert.equal(turns.length, 1);
  assert.equal(turns[0].text, 'Explain closures. Use a JavaScript example.');
  assert.equal(turns[0].question, true);
});

test('spoken filler punctuation does not hide an incomplete request prefix', () => {
  const { assembler, clock, turns, updates } = setup();
  assembler.push(final('Okay. Can you please explain me...'));
  clock.tick(2500);
  assert.equal(turns.length, 0);
  assembler.push(final('what are closures?', 3, 1));
  clock.tick(1500);
  assert.equal(turns.length, 1);
  assert.equal(turns[0].id, updates[0].id);
  assert.equal(turns[0].question, true);
});

test('resumed interim speech prevents an earlier complete question from dispatching', () => {
  const { assembler, clock, turns } = setup();
  assembler.push(final('What are closures?'));
  clock.tick(750);
  assembler.push(interim('and how do', 1, 1));
  clock.tick(800);
  assert.equal(turns.length, 0);
  assembler.push(final('and how do they retain variables?', 1, 2));
  clock.tick(799);
  assert.equal(turns.length, 0);
  clock.tick(1);
  assert.equal(turns.length, 1);
  assert.equal(turns[0].question, true);
  assert.equal(turns[0].text, 'What are closures? and how do they retain variables?');
});

test('SpeechStarted cancels pending dispatch before the first resumed word arrives', () => {
  const { assembler, clock, turns } = setup();
  assembler.push(final('Explain closures.'));
  clock.tick(750);
  assembler.push({ source: 'you', text: '', speechStarted: true, start: 1 });
  clock.tick(1000);
  assembler.push(final('Include an example.', 1, 1));
  clock.tick(799);
  assert.equal(turns.length, 0);
  clock.tick(1);
  assert.equal(turns.length, 1);
  assert.equal(turns[0].text, 'Explain closures. Include an example.');
});

test('duplicate utterance-end markers cannot postpone a complete question indefinitely', () => {
  const { assembler, clock, turns } = setup();
  assembler.push(final('Closures?'));
  clock.tick(400);
  assembler.push(endMarker());
  clock.tick(300);
  assembler.push(endMarker());
  clock.tick(100);
  assert.equal(turns.length, 1);
  assert.equal(turns[0].question, true);
  assembler.push(endMarker());
  clock.tick(10000);
  assert.equal(turns.length, 1);
});

test('delayed end marker does not flush newer unfinished speech; fallback is bounded and safe', () => {
  const { assembler, clock, turns } = setup();
  assembler.push(final('Explain closures.'));
  clock.tick(700);
  assembler.push(interim('in relation to', 1, 1));
  clock.tick(1000);
  assembler.push(endMarker());
  clock.tick(5499);
  assert.equal(turns.length, 0);
  clock.tick(1);
  assert.equal(turns.length, 1);
  assert.equal(turns[0].text, 'Explain closures.');
  assert.equal(turns[0].question, false, 'A lost final must not answer the stale earlier fragment');
  assert.equal(clock.timers.size, 0);
});

test('out-of-order older final cannot finish newer interim speech', () => {
  const { assembler, clock, turns, updates } = setup();
  assembler.push(interim('what are closures', 2, 1));
  clock.tick(100);
  assembler.push(final('Can you explain me', 0, 1));
  clock.tick(2000);
  assert.equal(turns.length, 0);
  assembler.push(final('what are closures?', 2, 1));
  clock.tick(1500);
  assert.equal(turns.length, 1);
  assert.equal(turns[0].text, 'Can you explain me what are closures?');
  assert.equal(turns[0].id, updates[0].id);
});

test('unfinished prefixes expire without answering, even when STT inserts punctuation', () => {
  const { assembler, clock, turns } = setup();
  assembler.push(final('Can you explain me?'));
  clock.tick(6499);
  assert.equal(turns.length, 0);
  clock.tick(1);
  assert.equal(turns.length, 1);
  assert.equal(turns[0].question, false);
  assembler.push(final('What are closures?', 8, 1));
  clock.tick(1500);
  assert.equal(turns.length, 2);
  assert.notEqual(turns[0].id, turns[1].id);
  assert.equal(turns[1].text, 'What are closures?');
});

test('new speech renews prefix retention, but unchanged repeated interim does not', () => {
  const { assembler, clock, turns } = setup();
  assembler.push(final('Can you explain me', 0, 1));
  clock.tick(6000);
  const partial = interim('what is the', 6, 1);
  assembler.push(partial);
  clock.tick(6000);
  assembler.push(partial);
  clock.tick(500);
  assert.equal(turns.length, 1);
  assert.equal(turns[0].question, false);
});

test('two sources assemble and settle independently without concatenating speakers', () => {
  const { assembler, clock, turns, updates } = setup();
  assembler.push(final('Can you explain me', 0, 1, 'remote'));
  clock.tick(500);
  assembler.push(final('I am listening.', 0, 1, 'you'));
  clock.tick(1500);
  assert.deepEqual(turns.map(turn => [turn.source, turn.text, turn.question]), [['you', 'I am listening.', false]]);
  assembler.push(final('what are closures?', 2, 1, 'remote'));
  clock.tick(1500);
  assert.equal(turns.length, 2);
  assert.equal(turns[1].source, 'remote');
  assert.equal(turns[1].text, 'Can you explain me what are closures?');
  assert.notEqual(updates[0].id, updates[1].id);
});

test('identical finals for the same audio span are deduplicated before and after settling', () => {
  const { assembler, clock, turns, updates } = setup();
  const event = final('Closures?', 1, 1);
  assembler.push(event);
  clock.tick(500);
  assembler.push(event);
  clock.tick(300);
  assert.equal(updates.length, 1);
  assert.equal(turns.length, 1);
  assembler.push(event);
  clock.tick(1500);
  assert.equal(turns.length, 1);
  assembler.push(final('Closures?', 3, 1));
  clock.tick(1500);
  assert.equal(turns.length, 2, 'Repeating a question in a different audio span is intentional speech');
});

test('untimed repeated words are not assumed to be duplicate provider results', () => {
  const { assembler, clock, turns } = setup();
  assembler.push({ source: 'you', text: 'Really?', isFinal: true });
  clock.tick(100);
  assembler.push({ source: 'you', text: 'Really?', isFinal: true });
  clock.tick(1500);
  assert.equal(turns[0].text, 'Really? Really?');
});

test('reset cancels work, invalidates even a raced timer callback, and forgets old final IDs', () => {
  const { assembler, clock, turns, updates } = setup();
  const event = final('Closures?');
  assembler.push(event);
  const racedCallback = [...clock.timers.values()][0].fn;
  assembler.reset();
  racedCallback();
  clock.tick(10000);
  assert.equal(turns.length, 0);
  assert.equal(clock.timers.size, 0);
  assembler.push(event);
  clock.tick(1500);
  assert.equal(turns.length, 1);
  assert.notEqual(updates[0].id, updates[1].id);
});

test('empty or abandoned interim-only speech never produces a fabricated final turn', () => {
  const { assembler, clock, turns, updates } = setup();
  assembler.push(endMarker());
  assembler.push(interim('can you'));
  clock.tick(6500);
  assert.equal(updates.length, 0);
  assert.equal(turns.length, 1, 'Notify the owner that unresolved ASR text expired, without inventing finalized text');
  assert.equal(turns[0].text, ''); assert.equal(turns[0].question, false);
  assert.equal(turns[0].reason, 'incomplete-audio'); assert.equal(turns[0].hadInterimText, true);
  assert.equal(clock.timers.size, 0);
});

test('a source reconnect reset drops its pending question without disturbing the other speaker', () => {
  const { assembler, clock, turns, updates } = setup();
  assembler.push(final('Closures?', 0, 1, 'remote'));
  assembler.push(final('I am listening.', 0, 1, 'you'));
  assembler.reset('remote');
  clock.tick(1500);
  assert.equal(turns.length, 1);
  assert.equal(turns[0].source, 'you');
  assembler.push(final('Closures?', 0, 1, 'remote'));
  clock.tick(1500);
  assert.equal(turns.length, 2);
  assert.notEqual(turns[1].id, updates[0].id);
});

test('bounded turn text cannot silently dispatch an incomplete truncated prompt', () => {
  const { assembler, clock, turns, updates } = setup();
  assembler.push(final(`Explain ${'very large input '.repeat(1000)}?`));
  assert.ok(updates[0].text.length <= 8000);
  clock.tick(1500);
  assert.equal(turns.length, 1);
  assert.equal(turns[0].question, false);
});

test('deduplication history is bounded so a long session does not retain every transcript', () => {
  const { assembler, clock, turns } = setup();
  for (let i = 0; i < 514; i++) {
    assembler.push(final('Closures?', i * 2, 1));
    clock.tick(1500);
  }
  assert.equal(turns.length, 514);
  assembler.push(final('Closures?', 0, 1));
  clock.tick(1500);
  assert.equal(turns.length, 515, 'Old duplicate fingerprints should be evicted');
  assembler.push(final('Closures?', 1026, 1));
  clock.tick(1500);
  assert.equal(turns.length, 515, 'Recent duplicate fingerprints should still be retained');
});

test('question detection accepts short technical questions and meaningful requests', () => {
  for (const text of ['Closures?', 'C++?', 'C#?', 'Why?', 'How so?', 'Explain closures.', 'What is a closure',
    'Compare TCP and UDP.', 'Can you explain me what are closures?', 'Who are you?', 'Tell me more.',
    'And its disadvantages?', 'What about memory?', 'Can you show an example?', 'And in Java?',
    'Show me an example.', 'Talk me through the design.', 'What is Redis used for?', 'Who do you work with?',
    'What does CPU stand for?', 'What are you referring to?', 'Explain logical AND?', 'Explain bitwise OR?']) {
    assert.equal(looksLikeQuestion(text, { hasContext: true }), true, text);
  }
});

test('question detection rejects empty prefixes, filler, and incidental keywords in answers', () => {
  for (const text of ['', '?', 'Okay?', 'Thanks?', 'Can you explain me?', 'Can you explain to me...',
    'Could you tell me?', 'Please explain.', 'What is?', 'How would you?', 'What is the difference between?',
    'Can you explain the difference between', 'Okay. Can you please explain me...', 'Show me...', 'Talk me through',
    'Can you explain me about', 'I know how closures work.', 'The interviewer asked what closures are.']) {
    assert.equal(looksLikeQuestion(text), false, text);
  }
});

test('embedded questions may end in is or are without being incomplete prefixes', () => {
  for (const text of ['Can you explain what closures are?', 'Tell me what a closure is.',
    'Could you describe what these alternatives were?', 'Explain where the previous bottleneck was.']) {
    assert.equal(looksLikeQuestion(text), true, text);
  }
  for (const text of ['What is?', 'What are?', 'Tell me what is', 'Explain what the', 'Explain what the is']) {
    assert.equal(looksLikeQuestion(text), false, text);
  }
});

test('recognizes explicit natural request openings without requiring a question mark', () => {
  for (const text of ['I want you to implement a cache.', 'Walk us through your design.', 'Give me an example.',
    'Elaborate on that.', 'Optimize this solution.', 'I need you to explain what closures are.',
    'I would like you to please compare the two approaches.', 'Please give us an example.']) {
    assert.equal(looksLikeQuestion(text), true, text);
  }
});

test('request openings still reject unfinished instructions and related declarative statements', () => {
  for (const text of ['I want you to', 'I want you to implement', 'Walk us through', 'Give me',
    'Elaborate on', 'Optimize', 'I want to implement a cache.', 'I optimized this solution.',
    'We should optimize the solution.', 'I know what closures are.', 'I want you to know I implemented a cache.']) {
    assert.equal(looksLikeQuestion(text), false, text);
  }
});

test('custom timer settings preserve deterministic settling', () => {
  const { assembler, clock, turns } = setup({ settleMs: 200, prefixMs: 1000 });
  assembler.push(final('Closures?'));
  clock.tick(199);
  assert.equal(turns.length, 0);
  clock.tick(1);
  assert.equal(turns.length, 1);
});

test('statement-form DSA objectives and Hinglish instructions do not need question punctuation', () => {
  for (const text of [
    'You are given an array of integers. Return the length of the longest subarray whose sum is K.',
    'Given an array including negative numbers, find the longest contiguous subarray with sum K.',
    'Return the length, not the count, of matching subarrays.',
    'We need to find the longest contiguous subarray summing to K.',
    'Your task is to implement a least recently used cache.',
    'Ek integer array diya hai. Negative numbers bhi allowed hain. Longest contiguous subarray ki length nikaalo.',
    'Array zero zero zero hai. K zero hai. Zero based start aur end indices batao.',
    'एक array दिया है। Negative numbers भी allowed हैं। Longest contiguous subarray की length निकालो।',
    'Closure kya hota hai', 'Kya binary search ke liye sorted array chahiye', 'इस solution की complexity क्या है', 'क्या binary search को sorted input चाहिए',
    'New question: how would you design an API rate limiter?'
  ]) assert.equal(classifyTurn(text).question, true, text);
});

test('background-only setup and communication checks never trigger technical answers', () => {
  for (const text of ['Given an array of integers.', 'Suppose negative numbers are allowed.', 'You are given an integer array.',
    'Ek integer array diya hai.', 'एक array दिया है।', 'Did you get it?', 'Can you hear me?', 'Does that make sense?',
    'Am I audible?', 'Are you there?', 'Samajh aaya?', 'समझ आया।', 'Kya aap mujhe sun rahe hain', 'क्या समझ आया',
    'Mujhe pata hai closure kya hota hai', 'kya hai']) {
    assert.equal(classifyTurn(text).question, false, text);
  }
  assert.equal(classifyTurn('Did you get it?').reason, 'acknowledgment');
  assert.equal(classifyTurn('Given an array of integers.').reason, 'background');
});

test('elliptical followups and corrections require previous task context', () => {
  for (const text of ['Time complexity.', 'And space?', 'And in Java.', 'Please continue.', 'Walk through an example.',
    'Actually, negative numbers are allowed.', 'No, I said contiguous subarray, not subsequence.',
    'Ab isi solution ki time aur space complexity batao.']) {
    assert.equal(classifyTurn(text).question, false, text);
    assert.equal(classifyTurn(text).reason, 'needs-context');
    assert.equal(classifyTurn(text, { hasContext: true }).question, true, text);
  }
});

test('long problem setup settles without a request; final objective and contextual followup are accepted', () => {
  const { assembler, clock, turns } = setup({ hasContext: () => true });
  assembler.push(final('You are given an integer array.', 0)); clock.tick(1400);
  assembler.push(final('Negative numbers and zero are allowed.', 2)); clock.tick(1400);
  assembler.push(final('Return the longest contiguous subarray length with sum K.', 4)); clock.tick(1400);
  assembler.push(final('Did you get it?', 6)); clock.tick(1400);
  assembler.push(final('And in Java.', 8)); clock.tick(1400);
  assert.deepEqual(turns.map(turn => [turn.question, turn.reason]), [
    [false, 'background'], [false, 'statement'], [true, 'complete-task'], [false, 'acknowledgment'], [true, 'contextual-followup']
  ]);
});

test('explicit submission discards pending timers while preserving packet dedupe and turn identity counters', () => {
  const { assembler, clock, turns, updates } = setup();
  const remote = final('Explain closures.', 0, 1, 'remote');
  assembler.push(remote);
  assembler.push(final('I am listening.', 0, 1, 'you'));
  const raced = [...clock.timers.values()][0].fn;
  const previousId = updates[0].id;
  assembler.discardPending('remote'); raced();
  assembler.push(remote); clock.tick(800);
  assert.deepEqual(turns.map(item => item.source), ['you']);
  assembler.push(final('What is binary search?', 2, 1, 'remote')); clock.tick(800);
  assert.equal(turns.length, 2); assert.notEqual(turns[1].id, previousId);
  assembler.push(final('Explain graphs.', 4, 1, 'remote'));
  assembler.discardPending(); clock.tick(6500); assert.equal(turns.length, 2);
});

test('approved pause phrases are coordination globally while actual task requests stay actionable', () => {
  for (const text of ['Give me a minute to think.', 'Gimme a minute to think!', 'Let me think through this for a moment.',
    'Let me work through this step by step.', 'Ek minute, mujhe sochne dijiye.', 'एक मिनट, मुझे सोचने दीजिए।']) {
    const result = classifyTurn(text, { hasContext: true });
    assert.equal(result.question, false, text); assert.equal(result.reason, 'acknowledgment');
  }
  assert.equal(classifyTurn('Give me an example of closures.').question, true);
  assert.equal(classifyTurn('Give me a minute-by-minute breakdown of the algorithm.').question, true);
});

test('orphan VAD-only expiry notifies once and is distinguished from missing ASR text', () => {
  const { assembler, clock, turns, updates } = setup();
  assembler.push({ source: 'you', text: '', speechStarted: true, start: 2 });
  clock.tick(6499); assert.equal(turns.length, 0);
  clock.tick(1); assert.equal(turns.length, 1); assert.equal(updates.length, 0);
  assert.equal(turns[0].text, ''); assert.equal(turns[0].reason, 'incomplete-audio'); assert.equal(turns[0].hadInterimText, false);
  clock.tick(6500); assert.equal(turns.length, 1);
  assembler.push(final('What is binary search?', 10, 2)); clock.tick(800);
  assert.equal(turns.length, 2); assert.equal(turns[1].question, true); assert.notEqual(turns[1].id, turns[0].id);
});

test('a completed final clears the missing-interim marker before a subsequent VAD-only pause', () => {
  const { assembler, clock, turns } = setup();
  assembler.push(interim('Explain closures.', 0, 1));
  assembler.push(final('Explain closures.', 0, 1));
  clock.tick(700); assembler.push({ source: 'you', text: '', speechStarted: true, start: 2 });
  clock.tick(6500);
  assert.equal(turns[0].reason, 'incomplete-audio'); assert.equal(turns[0].hadInterimText, false);
  assert.equal(turns[0].text, 'Explain closures.');
});
