'use strict';

// One tracker belongs to one audio source and connection timeline. Finalization
// covers audio intervals, not words: an empty Results packet can finalize audio,
// while UtteranceEnd only reports the end time of a previously recognized word.
const MAX_FINAL_RANGES = 128;
const MAX_PENDING_SPANS = 32;
// Provider timestamps can contain float32 rounding noise. Ignore residuals no
// longer than 1 ms; larger uncovered audio remains pending.
const EPSILON = 0.001;

function timing(result) {
  const start = Number.isFinite(result.start) && result.start >= 0 ? result.start : null;
  const duration = result.duration;
  const end = start !== null && Number.isFinite(duration) && duration > 0
    && Number.isFinite(start + duration) ? start + duration : null;
  return { start, end };
}

function subtract(span, ranges) {
  let pieces = [{ ...span }];
  for (const range of ranges) {
    pieces = pieces.flatMap(piece => {
      if (range.end <= piece.start || range.start >= piece.end) return [piece];
      const remaining = [];
      if (range.start > piece.start + EPSILON) remaining.push({ ...piece, end: Math.min(range.start, piece.end) });
      if (range.end < piece.end - EPSILON) remaining.push({ ...piece, start: Math.max(range.end, piece.start) });
      return remaining;
    });
    if (!pieces.length) break;
  }
  return pieces;
}

function mergeRanges(ranges) {
  const merged = [];
  for (const range of [...ranges].sort((a, b) => a.start - b.start || a.end - b.end)) {
    const previous = merged.at(-1);
    if (previous && range.start <= previous.end + EPSILON) previous.end = Math.max(previous.end, range.end);
    else merged.push({ ...range });
  }
  return merged;
}

function normalizePending(spans) {
  const textRanges = mergeRanges(spans.filter(span => span.hasText && span.start !== null && span.end !== null));
  const other = [];
  for (const span of spans) {
    if (span.hasText && span.start !== null && span.end !== null) continue;
    // Text already accounts for VAD inside its interval. A text-bearing marker
    // with an unknown end must remain: a known shorter range cannot cover it.
    if (!span.hasText && span.start !== null && textRanges.some(range => span.start >= range.start - EPSILON && span.start < range.end - EPSILON)) continue;
    const existing = other.find(item => item.start === span.start);
    if (existing) existing.hasText ||= span.hasText;
    else other.push({ ...span });
  }
  return [...textRanges, ...other].sort((a, b) => (a.start ?? Infinity) - (b.start ?? Infinity));
}

class AudioFinality {
  constructor() {
    this._pending = [];
    this._finalized = [];
    this._overflow = false;
  }

  snapshot() { return this._pending.map(span => ({ ...span })); }

  reset() {
    this._pending = [];
    this._finalized = [];
    this._overflow = false;
  }

  clearPending({ vadOnly = false } = {}) {
    this._pending = vadOnly ? this._pending.filter(span => span.hasText) : [];
    // A caller must explicitly discard the incomplete state after an overflow;
    // later finals cannot make discarded, untracked spans safe again.
    if (!vadOnly) this._overflow = false;
    return this.snapshot();
  }

  _result(ignored, reason) {
    return { ignored, ...(reason ? { reason } : {}), pending: this.snapshot(), ...(this._overflow ? { overflow: true } : {}) };
  }

  _setPending(spans) {
    const pending = normalizePending(spans);
    this._overflow ||= pending.length > MAX_PENDING_SPANS;
    this._pending = pending.slice(0, MAX_PENDING_SPANS);
  }

  push(result) {
    if (!result || typeof result !== 'object') return this._result(true, 'invalid-result');
    const hasText = typeof result.text === 'string' && !!result.text.trim();
    const { start, end } = timing(result);
    const interval = start !== null && end !== null ? { start, end } : null;
    const final = result.isFinal === true;

    if (final && (hasText || (result.eventType === 'Results' && interval))) {
      if (interval) {
        this._finalized = mergeRanges([...this._finalized, interval]).slice(-MAX_FINAL_RANGES);
        this._setPending(this._pending.flatMap(span => {
          if (!span.hasText) {
            // A valid newer final settles an older VAD onset, even when its
            // transcript starts later. An onset at the final end is new speech.
            if (span.start !== null && span.start < end - EPSILON) return [];
            return span.start === null && hasText ? [] : [span];
          }
          if (span.start !== null && span.end !== null) return subtract(span, [interval]);
          // Legacy untimed text is settled only by actual finalized words.
          // An empty final cannot prove coverage of an unknown audio interval.
          if (hasText && (span.start === null || (span.start >= start - EPSILON && span.start < end - EPSILON))) return [];
          return [span];
        }));
      } else if (hasText) {
        // Preserve tests/callers that have no provider timing. Never use absent
        // or invalid duration to clear a known timed span or create coverage.
        this._setPending(this._pending.filter(span => span.start !== null));
      }
      return this._result(false);
    }

    if (hasText && !final) {
      const span = { start, end, hasText: true };
      const uncovered = interval ? subtract(span, this._finalized) : [span];
      if (!uncovered.length) return this._result(true, 'already-finalized');
      this._setPending([...this._pending, ...uncovered]);
      return this._result(false);
    }

    if (result.speechStarted === true || result.eventType === 'SpeechStarted') {
      if (start !== null && this._finalized.some(range => start >= range.start - EPSILON && start < range.end - EPSILON)) {
        return this._result(true, 'already-finalized');
      }
      this._setPending([...this._pending, { start, end: null, hasText: false }]);
      return this._result(false);
    }

    return this._result(true, result.eventType === 'UtteranceEnd' ? 'utterance-end' : final ? 'empty-final-without-coverage' : 'empty-result');
  }
}

module.exports = { AudioFinality };
