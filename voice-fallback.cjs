'use strict';

const { classifyTurn } = require('./turns.cjs');

const DEFAULT_VOICE_PHRASES = Object.freeze([
  'Give me a minute to think.',
  'Let me think through this for a moment.',
  'Let me work through this step by step.',
  'Ek minute, mujhe sochne dijiye.'
]);
const HINDI_ALIAS = 'एक मिनट, मुझे सोचने दीजिए।';
const clean = text => typeof text === 'string' ? text.replace(/\s+/gu, ' ').trim() : '';
function canonical(text) {
  return clean(text).normalize('NFKC').toLowerCase().replace(/\bgimme\b/g, 'give me')
    .replace(/[.,!?;:।？…]/gu, ' ').replace(/\s+/gu, ' ').trim();
}
function normalizeVoicePhrases(value = DEFAULT_VOICE_PHRASES) {
  if (!Array.isArray(value) || !value.length || value.length > 8) throw new TypeError('Choose between one and eight voice phrases.');
  const phrases = [];
  for (const entry of value) {
    const phrase = clean(entry);
    if (typeof entry !== 'string' || phrase.length < 8 || phrase.length > 160 || canonical(phrase).split(' ').length < 3
      || /[\r\n\u0000-\u001f]/u.test(entry) || /["“”‘’`]/u.test(phrase)) throw new TypeError('Voice phrases must contain at least three words and be 8–160 characters long.');
    if (!phrases.some(item => canonical(item) === canonical(phrase))) phrases.push(phrase);
  }
  return phrases;
}
function entries(phrases) {
  const result = normalizeVoicePhrases(phrases).map(phrase => ({ phrase, key: canonical(phrase) }));
  const hindi = result.find(item => item.key === canonical(DEFAULT_VOICE_PHRASES[3]));
  if (hindi) result.push({ phrase: hindi.phrase, key: canonical(HINDI_ALIAS) });
  return result;
}
function commandPositionAllowed(prefix, suffix, original) {
  // Quotes, negation and metalinguistic mentions must not execute commands.
  // A quoted task before an unquoted command remains usable.
  if (/["“”‘’`]/u.test(suffix) || /^["'“‘`]/u.test(suffix) || /["'”’`]\s*[.!?।]?$/u.test(original)) return false;
  const quoteChars = prefix.match(/["“”`]/gu) || [];
  if (quoteChars.length % 2) return false;
  const before = canonical(prefix);
  if (!before) return true;
  if (/(?:\b(?:not|never|dont|don't|do not|cannot|can't|avoid|nahi|nahin|mat)\b|नहीं|मत)[^.!?।]*$/iu.test(prefix)) return false;
  const previousClause = prefix.replace(/[\s.!?।]+$/u, '');
  if (/(?:\b(?:say|said|says|saying|phrase|phrases|command|commands|quote|quoted|mention|mentioned|words|word|means|called|contains|bolo|likho)\b|\b(?:for example|example of)\b|कहा|वाक्य|बोलो)[^.!?।]*$/iu.test(previousClause)) return false;
  // An explicit clause boundary permits recovery of a task that the normal
  // question classifier missed. Without one, require an identifiable task.
  if (/[.!?;।]\s*$/u.test(prefix)) return true;
  const preceding = prefix.replace(/[\s,;.!?।:]+$/u, '').trim();
  return classifyTurn(preceding, { hasContext: true }).question;
}
function* suffixCandidates(text) {
  yield { prefix: '', suffix: text, start: 0 };
  for (let i = 0; i < text.length; i++) if (/\s/u.test(text[i]) && i + 1 < text.length) {
    yield { prefix: text.slice(0, i + 1).trimEnd(), suffix: text.slice(i + 1), start: i + 1 };
  }
}
function detectVoiceCommand(value, { phrases = DEFAULT_VOICE_PHRASES } = {}) {
  const text = clean(value), options = entries(phrases);
  for (const candidate of suffixCandidates(text)) {
    const key = canonical(candidate.suffix);
    const match = options.find(item => item.key === key);
    if (!match || !commandPositionAllowed(candidate.prefix, candidate.suffix, text)) continue;
    const questionText = candidate.prefix.replace(/[\s,;]+$/u, '').trim();
    return { matched: true, phrase: match.phrase, questionText, commandOnly: !questionText };
  }
  return { matched: false, questionText: text, commandOnly: false };
}
function splitCommandPrefix(value, { phrases = DEFAULT_VOICE_PHRASES } = {}) {
  const text = clean(value), options = entries(phrases);
  for (const candidate of suffixCandidates(text)) {
    const key = canonical(candidate.suffix);
    if (!key || !options.some(item => item.key.startsWith(`${key} `))) continue;
    if (!commandPositionAllowed(candidate.prefix, candidate.suffix, text)) continue;
    return { questionText: candidate.prefix.replace(/[\s,;]+$/u, '').trim(), heldText: candidate.suffix };
  }
  return { questionText: text, heldText: '' };
}

// Main owns the timeout and session lifecycle. Only final transcripts execute
// commands; interim command prefixes never enter question assembly or context.
class VoiceCommandMatcher {
  constructor({ phrases = DEFAULT_VOICE_PHRASES } = {}) { this.phrases = normalizeVoicePhrases(phrases); this.reset(); }
  reset() { this.held = []; this.seenFinals = new Set(); this.literalContext = false; this.quote = null; this.source = null; }
  flush() { const forward = this.held; this.held = []; return { forward, holding: false }; }
  _trackQuotes(text) {
    for (let i = 0; i < text.length; i++) {
      const char = text[i];
      if (this.quote) { if (char === this.quote) this.quote = null; continue; }
      if (char === '"' || char === '`') this.quote = char;
      else if (char === '“') this.quote = '”';
      else if (char === '‘') this.quote = '’';
      else if (char === "'" && !/[\p{L}\p{N}]/u.test(text[i - 1] || '') && /[\p{L}\p{N}]/u.test(text[i + 1] || '')) this.quote = "'";
    }
  }
  push(result) {
    if (!result || typeof result.source !== 'string') return { forward: [], holding: !!this.held.length };
    const text = clean(result.text);
    if (!text) return { forward: [result], holding: !!this.held.length };
    const forward = [];
    if (this.source && this.source !== result.source) { forward.push(...this.flush().forward); this.literalContext = false; this.quote = null; }
    this.source = result.source;
    if (result.isFinal === true && Number.isFinite(result.start) && Number.isFinite(result.duration)) {
      const fingerprint = JSON.stringify([result.source, result.start, result.duration, text]);
      if (this.seenFinals.has(fingerprint)) return { forward, holding: !!this.held.length, duplicate: true };
      this.seenFinals.add(fingerprint);
      if (this.seenFinals.size > 512) this.seenFinals.delete(this.seenFinals.values().next().value);
    }
    const combined = [...this.held.map(item => item.text), text].join(' ');
    const literal = this.literalContext || !!this.quote;
    const command = detectVoiceCommand(combined, { phrases: this.phrases });
    const prefix = splitCommandPrefix(combined, { phrases: this.phrases });
    if (result.isFinal !== true) {
      if ((command.matched || prefix.heldText) && !literal) return { forward, holding: true };
      return { forward: [...forward, result], holding: !!this.held.length };
    }
    this._trackQuotes(text);
    if (command.matched && !literal) {
      const first = this.held[0] || result;
      this.held = [];
      if (command.questionText) forward.push({ ...first, text: command.questionText, isFinal: true });
      return { forward, command, holding: false };
    }
    if (prefix.heldText && !literal) {
      if (this.held.length) this.held.push({ ...result, text });
      else {
        if (prefix.questionText) forward.push({ ...result, text: prefix.questionText });
        this.held.push({ ...result, text: prefix.heldText });
      }
      return { forward, holding: true };
    }
    forward.push(...this.flush().forward, { ...result, text });
    this.literalContext = /(?:\b(?:say|said|says|phrase|command|quote|words|do not|don't|never)|(?:the )?(?:phrase|command|instruction) is|मत कहो|कहा)\s*[.!?।:,-]*$/iu.test(text);
    return { forward, holding: false };
  }
}

class PendingQuestionBuffer {
  constructor({ now = Date.now, maxChars = 8000, maxAgeMs = 90000 } = {}) {
    if (typeof now !== 'function' || !Number.isInteger(maxChars) || maxChars < 1 || !Number.isFinite(maxAgeMs) || maxAgeMs < 1) throw new TypeError('Invalid pending-question limits.');
    this.now = now; this.maxChars = maxChars; this.maxAgeMs = maxAgeMs; this.counter = 0; this.reset({});
  }
  reset({ sessionId = null, source = null } = {}) {
    this.sessionId = sessionId; this.source = source; this.parts = new Map(); this.consumedParts = new Map(); this.seenUpdates = new Map();
    this.current = { id: null, revision: 0, sessionId, source, text: '', status: 'empty', reason: 'empty', updatedAt: null, canRecover: false };
    return this.snapshot();
  }
  _expire() {
    if (this.current.status === 'pending' && this.now() - this.current.updatedAt >= this.maxAgeMs) {
      this.current = { ...this.current, status: 'expired', reason: 'expired', canRecover: false };
      this.parts.clear();
    }
  }
  snapshot() { this._expire(); return { ...this.current }; }
  invalidate(reason = 'audio-gap') {
    this.parts.clear();
    this.current = { ...this.current, revision: this.current.revision + 1, status: 'incomplete', reason, canRecover: false };
    return this.snapshot();
  }
  observe({ id, source, text, sessionId = this.sessionId, reason = 'statement' } = {}) {
    this._expire();
    if (sessionId !== this.sessionId || source !== this.source || typeof id !== 'string' || !id || !clean(text)) return this.snapshot();
    if (['acknowledgment', 'empty', 'voice-command'].includes(reason)) return this.snapshot();
    const rawText = clean(text), consumed = this.consumedParts.get(id);
    // A settling decision can mark the exact text previously published by
    // onUpdate as incomplete. It must invalidate that revision even unchanged.
    if (['incomplete-audio', 'audio-gap', 'reconnecting', 'too-long'].includes(reason)
      && this.seenUpdates.get(id) === rawText && this.current.status === 'pending') return this.invalidate(reason);
    if (this.seenUpdates.get(id) === rawText) return this.snapshot();
    this.seenUpdates.set(id, rawText);
    if (this.seenUpdates.size > 512) this.seenUpdates.delete(this.seenUpdates.keys().next().value);
    let pendingText = rawText;
    if (consumed) {
      if (rawText === consumed) return this.snapshot();
      if (!rawText.startsWith(`${consumed} `)) return this.snapshot();
      pendingText = rawText.slice(consumed.length).trim();
    }
    if (this.parts.get(id)?.rawText === rawText) return this.snapshot();
    const previousTurns = [...this.parts].filter(([turnId]) => turnId !== id).map(([, part]) => part.text).join(' ');
    const prior = classifyTurn(previousTurns, { hasContext: false });
    const next = classifyTurn(pendingText, { hasContext: !!this.current.text });
    const refersToPrior = /^(?:(?:and|also|then|aur|ab)[,\s]+|(?:return|include|use|show)\s+(?:only|the|its|this|that|an? example)\b)/i.test(pendingText);
    const independent = !!previousTurns && prior.question && next.question
      && ['question', 'task'].includes(next.kind) && !refersToPrior;
    const newTopic = /^(?:new|next) question[\s:,.]/i.test(pendingText) || independent;
    if (this.current.status !== 'pending' || newTopic) {
      this.parts.clear();
      this.current = { id: `${this.sessionId}:${source}:${++this.counter}`, revision: 0, sessionId: this.sessionId, source,
        text: '', status: 'pending', reason, updatedAt: this.now(), canRecover: true };
    }
    this.parts.set(id, { text: pendingText, rawText });
    const merged = [...this.parts.values()].map(item => item.text).join(' ');
    this.current = { ...this.current, revision: this.current.revision + 1, text: merged.slice(0, this.maxChars), updatedAt: this.now(), reason,
      status: merged.length > this.maxChars ? 'incomplete' : 'pending', canRecover: merged.length <= this.maxChars };
    if (merged.length > this.maxChars) { this.current.reason = 'too-long'; this.parts.clear(); }
    else if (['incomplete-audio', 'audio-gap', 'reconnecting'].includes(reason)) this.invalidate(reason);
    return this.snapshot();
  }
  consume({ id, revision } = {}) {
    const current = this.snapshot();
    if (id !== current.id || revision !== current.revision) return { ...current, ok: false, reason: 'stale' };
    if (current.status === 'consumed') return { ...current, ok: false, reason: 'already-submitted' };
    if (!current.canRecover) return { ...current, ok: false, reason: current.reason };
    for (const [turnId, value] of this.parts) this.consumedParts.set(turnId, value.rawText);
    while (this.consumedParts.size > 512) this.consumedParts.delete(this.consumedParts.keys().next().value);
    this.parts.clear();
    this.current = { ...this.current, status: 'consumed', reason: 'submitted', canRecover: false };
    return { ...this.current, ok: true };
  }
}

module.exports = { DEFAULT_VOICE_PHRASES, normalizeVoicePhrases, detectVoiceCommand, splitCommandPrefix, VoiceCommandMatcher, PendingQuestionBuffer };
