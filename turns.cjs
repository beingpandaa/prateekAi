'use strict';

const { createHash } = require('node:crypto');

// Speech providers finalize pieces of audio, not necessarily whole questions.
// Keep this local assembly independent of the transcription and answer providers.
const MAX_TURN_CHARS = 8000;
const MAX_SEEN_FINALS = 512;
const AUDIO_EPSILON = 0.02;

function cleanText(value) {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
}

function questionBody(text) {
  return cleanText(text).toLowerCase()
    .replace(/^[\s.,!?;:…।'"“”‘’()[\]{}]+|[\s.,!?;:…।'"“”‘’()[\]{}]+$/g, '')
    .replace(/^(?:(?:okay|ok|so|well|now|uh|um|alright|right)[\s.,!?;:…]+)+/, '').trim();
}

function requestBody(body) {
  // Normalize an explicit request to its action, without treating ordinary
  // statements such as "I want to implement a cache" as questions.
  return body.replace(/^i (?:want|need|would like) you to(?: please)?(?:\s+|$)/, '').trim();
}

function incompleteQuestion(text) {
  const body = requestBody(questionBody(text));
  if (!body) return true;
  if (/^(?:(?:can|could|would|will|do|did) you(?: please)?)$/.test(body)) return true;
  if (/^(?:(?:can|could|would|will) you )?(?:please )?(?:explain|describe|clarify|elaborate|compare|design|implement|solve|find|write|optimize|optimise)(?: (?:to )?me)?(?: about| on)?$/.test(body)) return true;
  if (/^(?:(?:can|could|would|will) you )?(?:please )?tell(?: me)?(?: about)?$/.test(body)) return true;
  if (/^(?:(?:can|could|would|will) you )?(?:please )?walk (?:me|us)(?: through)?$/.test(body)) return true;
  if (/^(?:(?:can|could|would|will) you )?(?:please )?(?:talk (?:me|us)(?: through)?|(?:show|give)(?: me| us)?)$/.test(body)) return true;
  if (/^(?:what|how|when|where|which|who|whose)(?: (?:is|are|was|were|does|do|did|can|could|would|will|should|has|have))?$/.test(body)) return true;
  if (/^(?:how|what|why|when|where|which) (?:do|does|did|can|could|would|will|should) (?:you|we|i|it|they)$/.test(body)) return true;
  if (/^(?:(?:explain|describe) )?(?:(?:what|how) (?:is|are) )?(?:the )?(?:difference|differences|relationship|tradeoff|tradeoffs)(?: (?:is|are|between))?$/.test(body)) return true;
  // A terminal question mark is often inserted at a hesitation. It must not
  // turn "can you explain me?" or "what is the difference between?" into a task.
  // Do not treat every trailing preposition as incomplete: "What is this
  // used for?" and "Who do you work with?" are ordinary complete questions.
  if (/\b(?:logical|bitwise|boolean) (?:and|or)$/.test(body)) return false;
  if (/\b(?:is|are|was|were)$/.test(body)) {
    // Embedded clauses reverse the ordinary question order: "what closures
    // are" is complete, while "what are" still needs its subject.
    const embedded = /\b(?:what|who|where) (.+) (?:is|are|was|were)$/.exec(body);
    const subject = embedded?.[1];
    return !subject || /\b(?:the|a|an|of|to|between|and|or|is|are|was|were)$/.test(subject);
  }
  return /\b(?:the|a|an|between|and|or|versus|vs|using)$/.test(body);
}

function classifyTurn(value, { hasContext = false } = {}) {
  const text = cleanText(value);
  const body = questionBody(text).replace(/^(?:new|next) question[\s:,.]+/, '');
  const result = (question, reason, kind = reason) => ({ question, reason, kind });
  if (!body) return result(false, 'empty');
  // Coordination is not an interview task, even when ASR adds a question mark.
  if (/^(?:yes|no|okay|ok|right|sure|hmm|uh|um|thanks|thank you|sorry|hello|hi|fine|good|great|yep|yeah|so|well|you|me|understood|got it|(?:did|do) you (?:get|understand) (?:it|that|this|the question)|(?:can|could) you hear me|am i audible|are you there|does that make sense|samajh (?:aaya|aya)|sun (?:rahe|pa rahe) ho|samajh gaye|समझ आया|समझ गए|सुन रहे हो)$/.test(body)) return result(false, 'acknowledgment');
  if (/^(?:(?:give me|gimme) a minute to think|let me think through this for a moment|let me work through this step by step|ek minute[,]? mujhe sochne dijiye|एक मिनट[,]? मुझे सोचने दीजिए)$/.test(body)) return result(false, 'acknowledgment');
  if (/^(?:kya (?:aap|tum) mujhe sun (?:rahe|pa rahe) (?:ho|hain)|kya samajh (?:aaya|aya)|क्या (?:आप|तुम) मुझे सुन (?:रहे|पा रहे) (?:हो|हैं)|क्या समझ आया)$/.test(body)) return result(false, 'acknowledgment');
  if (/^(?:(?:kya|kaise|kyun|kyon|क्या|कैसे|क्यों)(?: (?:hai|hain|hoga|है|हैं|होगा))?)$/.test(body)) return result(false, 'incomplete');
  if (incompleteQuestion(body)) return result(false, 'incomplete');
  const letters = body.match(/\p{L}/gu) || [];
  if (letters.length < 2 && !/^(?:c(?:\+\+|#)?|r)$/.test(body)) return result(false, 'statement');
  const correction = /^(?:actually\b|correction\b|no[,\s]+(?:i (?:said|meant)|(?:the |a )?(?:subarray|substring|subsequence|array|input|output))|nahi[,\s]|nahi\b|नहीं[\s,])/i.test(body);
  const followup = /^(?:(?:and|also|aur|ab)[,\s]+)*(?:(?:its |the )?(?:time|space|memory)(?: and (?:time|space|memory))?(?: complexity| usage)?|in (?:java|python|javascript|typescript|c\+\+|c#|go|rust)|(?:an? |another )?example|edge cases|test cases|pros and cons|advantages|disadvantages|tradeoffs|please continue|continue|walk through an? example|isi (?:solution|approach).+|इसी (?:समाधान|सॉल्यूशन).+)$/i.test(body);
  if (correction || followup) return result(!!hasContext, hasContext ? (correction ? 'correction' : 'contextual-followup') : 'needs-context');
  // These actions express complete tasks without an interrogative opening.
  const action = /\b(?:return|find|calculate|compute|determine|identify|implement|design|solve|write|explain|describe|compare|optimi[sz]e)\s+\S+/i;
  const setup = /^(?:given\b|suppose\b|you (?:are|have been) given\b|i have (?:an? |the )|we have (?:an? |the )|(?:ek |aapko |apko )?.*\b(?:array|graph|tree|list|input)\b.*\b(?:diya|diye|hai|hain)\b|आपको|एक .*(?:दिया|है))/i.test(body);
  const directTask = /^(?:(?:please|and|then)[,\s]+)*(?:return|calculate|compute|determine|identify)\s+\S+/i.test(body)
    || /^(?:your task is to|the task is to|you (?:need|have) to|we need to|we need)\s+\S+/i.test(body);
  const hindiTask = /(?:\b(?:batao|bataiye|bataye|samjhao|samjhaiye|nikaalo|nikalo|nikaliye|likho)\b|\b(?:solve|implement|design|explain|return|calculate) karo\b|बताओ|बताइए|समझाओ|समझाइए|निकालो|निकालिए|लिखो|हल करो)/i.test(body);
  const hindiQuestion = !/^(?:i know\b|mujhe pata hai\b|main (?:jaanta|janta|jaanti)\b|मुझे पता है|मैं जानता)/i.test(body)
    && (/^(?:(?:ab|aur|toh|अच्छा|अब|और)[,\s]+)*(?:kya|kaise|kyun|kyon|kab|kaun|kahan|क्या|कैसे|क्यों|कब|कौन|कहाँ)\s+\S.+/i.test(body)
      || /(?:\b(?:kya|kaise|kyun|kyon)\b.*\b(?:hai|hain|hoga|hogi|hota|hote|kare|karoge|karenge)|(?:^|\s)(?:क्या|कैसे|क्यों).*(?:है|हैं|होगा|होगी|होता|करोगे))$/i.test(body));
  const setupAction = setup && action.test(body.replace(/^(?:given|suppose)\b/i, ''));
  if (directTask || hindiTask || setupAction) return result(true, 'complete-task', 'task');
  if (hindiQuestion) return result(true, 'question');
  if (setup) return result(false, 'background');
  if (/[?？]/.test(text)) return result(true, 'question');
  if (/^(?:(?:and|please)[,\s]+)*(?:what|why|how|when|where|which|who|whose|can|could|would|will|do|does|did|is|are|was|were|should|have|has|explain|describe|clarify|elaborate|design|implement|solve|compare|find|write|optimize|optimise|tell me|walk (?:me|us) through|talk (?:me|us) through|show (?:me|us)|give (?:me|us))\b/i.test(requestBody(body))) return result(true, 'question');
  return result(false, 'statement');
}

function looksLikeQuestion(value, options) { return classifyTurn(value, options).question; }
function isFreshQuestionStart(value) {
  const body = questionBody(value).replace(/^(?:new|next) (?:question|problem)[\s:,.]+/, '');
  // A repeat after missing audio must stand on its own. Reuse ordinary question
  // recognition (including fillers and Hindi), but reject dependent continuations.
  if (/^(?:(?:and|also|then|aur|ab)[,\s]+)*(?:(?:return|include|use|show)\b|(?:find|calculate|determine|explain|describe|solve)\s+(?:it|its|this|that|these|those)\b|(?:what|how|why) (?:about|is it|is that|is this|does it|does that)\b)/i.test(body)) return false;
  const classification = classifyTurn(body, { hasContext: false });
  return classification.question || classification.reason === 'background';
}

class TurnAssembler {
  constructor({ onUpdate = () => {}, onTurn = () => {}, settleMs = 800, prefixMs = 6500,
    now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout, hasContext = () => false } = {}) {
    for (const callback of [onUpdate, onTurn, now, setTimer, clearTimer, hasContext]) {
      if (typeof callback !== 'function') throw new TypeError('Turn callbacks and clock functions must be functions.');
    }
    if (!Number.isFinite(settleMs) || settleMs < 0 || !Number.isFinite(prefixMs) || prefixMs < 0) {
      throw new TypeError('Turn delays must be nonnegative finite numbers.');
    }
    this.onUpdate = onUpdate;
    this.onTurn = onTurn;
    this.settleMs = settleMs;
    this.prefixMs = Math.max(prefixMs, settleMs);
    this.now = now;
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
    this.hasContext = hasContext;
    this._states = new Map();
    this._seenFinals = new Map();
    this._counter = 0;
  }

  push(result) {
    if (!result || typeof result.source !== 'string' || !result.source) return;
    const source = result.source;
    const text = cleanText(result.text);
    const start = Number.isFinite(result.start) ? result.start : null;
    const duration = Number.isFinite(result.duration) && result.duration >= 0 ? result.duration : null;
    const final = result.isFinal === true && !!text;
    // Without provider timestamps, repeated words may be intentional speech.
    // Only deduplicate a final with the same audio span and content.
    if (final && start !== null && duration !== null) {
      const key = JSON.stringify([source, start, duration, createHash('sha256').update(text).digest('hex')]);
      if (this._seenFinals.has(key)) return;
      this._seenFinals.set(key, source);
      if (this._seenFinals.size > MAX_SEEN_FINALS) this._seenFinals.delete(this._seenFinals.keys().next().value);
    }

    let state = this._states.get(source);
    // Empty utterance-end markers can repeat or arrive after new speech begins.
    // Every final already arms a timer; these markers must never extend it or
    // finalize a committed prefix while a newer interim is unfinished.
    if (!text && !result.speechStarted) return;
    if (!state) {
      state = { id: `${source}:${++this._counter}`, source, text: '', timer: null,
        timerVersion: 0, latestAt: this.now(), unfinished: false, interimStart: null,
        interimKey: null, startedKey: null, hadInterimText: false, truncated: false };
      this._states.set(source, state);
    }

    if (final) {
      const oldFinal = state.unfinished && state.interimStart !== null && start !== null && duration !== null
        && start < state.interimStart && start + duration <= state.interimStart + AUDIO_EPSILON;
      const joined = state.text ? `${state.text} ${text}` : text;
      state.truncated ||= joined.length > MAX_TURN_CHARS;
      state.text = joined.slice(-MAX_TURN_CHARS);
      if (!oldFinal) {
        state.latestAt = this.now();
        state.unfinished = false;
        state.interimStart = null;
        state.interimKey = null;
        state.startedKey = null;
        state.hadInterimText = false;
      }
      this.onUpdate({ id: state.id, source, text: state.text, pending: true });
      // onUpdate may clear the session synchronously.
      if (this._states.get(source) !== state) return;
      this._arm(state, state.unfinished ? this.prefixMs : this.settleMs);
      return;
    }

    if (text) {
      const key = JSON.stringify([start, duration, text]);
      if (state.unfinished && state.interimKey === key) return;
      state.interimKey = key;
      state.hadInterimText = true;
    } else {
      const key = start === null ? 'untimed' : String(start);
      if (state.unfinished && state.startedKey === key) return;
      state.startedKey = key;
    }
    state.latestAt = this.now();
    state.unfinished = true;
    state.interimStart = start;
    this._arm(state, this.prefixMs);
  }

  discardPending(source) {
    if (typeof source === 'string') {
      const state = this._states.get(source);
      if (state) this._cancelTimer(state);
      this._states.delete(source);
    } else {
      for (const state of this._states.values()) this._cancelTimer(state);
      this._states.clear();
    }
  }

  reset(source) {
    if (typeof source === 'string') {
      const state = this._states.get(source);
      if (state) this._cancelTimer(state);
      this._states.delete(source);
      for (const [key, finalSource] of this._seenFinals) if (finalSource === source) this._seenFinals.delete(key);
    } else {
      for (const state of this._states.values()) this._cancelTimer(state);
      this._states.clear();
      this._seenFinals.clear();
    }
    // Keep IDs unique even when the same instance is reused for a new session.
  }

  _cancelTimer(state) {
    state.timerVersion++;
    if (state.timer !== null) this.clearTimer(state.timer);
    state.timer = null;
  }

  _arm(state, delay) {
    this._cancelTimer(state);
    const version = state.timerVersion;
    const remaining = Math.max(0, delay - (this.now() - state.latestAt));
    state.timer = this.setTimer(() => {
      if (this._states.get(state.source) !== state || version !== state.timerVersion) return;
      state.timer = null;
      if (state.unfinished) {
        // A missing final must not cause an older fragment to be answered.
        // Retain its transcript but close it without an automatic question.
        this._finish(state, { question: false, reason: 'incomplete-audio', kind: 'incomplete' });
      } else if (incompleteQuestion(state.text) && this.now() - state.latestAt < this.prefixMs) {
        this._arm(state, this.prefixMs);
      } else {
        this._finish(state, state.truncated ? { question: false, reason: 'too-long', kind: 'incomplete' }
          : classifyTurn(state.text, { hasContext: !!this.hasContext(state.source) }));
      }
    }, remaining);
  }

  _finish(state, decision) {
    this._cancelTimer(state);
    this._states.delete(state.source);
    // Even an interim-only state must notify its owner on expiry; otherwise a
    // separate unresolved-audio guard can block later complete questions forever.
    // This is a lifecycle event, not a fabricated final transcript.
    if (state.text || decision.reason === 'incomplete-audio') this.onTurn({ id: state.id, source: state.source, text: state.text, ...decision,
      ...(decision.reason === 'incomplete-audio' ? { hadInterimText: state.hadInterimText } : {}) });
  }
}

module.exports = { TurnAssembler, looksLikeQuestion, classifyTurn, isFreshQuestionStart };
