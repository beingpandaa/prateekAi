'use strict';

// Local routing is deliberately conservative and makes no classification request.
// Model capabilities: https://developers.openai.com/api/docs/models/gpt-6-luna
// https://developers.openai.com/api/docs/models/gpt-5.6-luna
// https://developers.openai.com/api/docs/models/gpt-5.6-sol
const LIGHT_MODELS = ['gpt-6-luna', 'gpt-5.6-luna'];
const LOW_EFFORT_MODELS = new Set(['gpt-6-astra', 'gpt-5.6-sol']);
// Only known text-model IDs can be chosen automatically, and only when the
// selected provider's authenticated catalog also offers that exact ID.
// https://platform.claude.com/docs/en/models/haiku-4-5/overview
// https://ai.google.dev/gemini-api/docs/models/gemini-3.5-flash-lite
// https://ai.google.dev/gemini-api/docs/models/gemini-3.1-flash-lite
// https://ai.google.dev/gemini-api/docs/models/gemini-2.5-flash-lite
const LIGHT_MODELS_BY_PROVIDER = Object.freeze({
  openai: LIGHT_MODELS,
  chatgpt: LIGHT_MODELS,
  anthropic: ['claude-haiku-4-5', 'claude-haiku-4-5-20251001'],
  gemini: ['gemini-3.5-flash-lite', 'gemini-3.1-flash-lite', 'gemini-2.5-flash-lite'],
  compatible: [], // Model names on custom servers do not establish capabilities.
});

function normalize(value) {
  return typeof value === 'string' ? value.trim().replace(/\s+/g, ' ').toLowerCase() : '';
}

function standaloneSimple(question, depth, previousQuestion, mode) {
  const text = normalize(question);
  if (!text || depth === 'senior' || depth === 'applied') return false;
  if (text.length > 190 || text.split(' ').length > 28) return false;
  // Multiple questions/clauses, source code, and requested depth are not cheap guesses.
  if ((text.match(/\?/g) || []).length > 1 || /[\n\r]/.test(question) || /[;{}]|```|\b(?:in depth|in detail|comprehensive|rigorous|advanced|complex|prove|proof|derive|derivation)\b/.test(text)) return false;
  if (/\b(?:implement|implementation|algorithm|pseudocode|write (?:the |some |a )?code|solve|optimi[sz]e|debug|troubleshoot|diagnose|root cause|stack trace|production|deadlock|race condition|tradeoffs?|trade-offs?|bottlenecks?|at scale|large scale|distributed|concurrenc\w*|capacity|threat model|attack chain|exploit|vulnerabilit\w*|incident|migration|deploy\w*|version-specific)\b/.test(text)) return false;
  if (/\b(?:design|architect|build|calculate|estimate|analy[sz]e|evaluate|recommend)\b/.test(text) && !/^(?:(?:can|could) you )?(?:explain\s+(?:to me\s+)?|what (?:is|are)\s+|define\s+)(?:(?:a|an|the)\s+)?(?:system design|software architecture|design patterns?)\??$/.test(text)) return false;
  if (/\b(?:time|space) complexity\b|\b(?:under|given|consider|assuming|constraints?|requirements?)\b/.test(text)) return false;
  if (/\b(?:best|better|right choice|should|suitable|appropriate|recommendation)\b/.test(text)) return false;
  // A short prompt may still require a proof, a concrete calculation, code
  // interpretation, or an operational decision. Brevity is not simplicity.
  if (/\b(?:correctness|optimality|invariants?|termination|guarantees?|minimum|maximum|shortest|longest|safest|least (?:number|cost)|most (?:efficient|secure))\b/.test(text)) return false;
  if (/\b(?:output|return value|result|answer|solution)\s+(?:of|for|to)\b|\bthe (?:output|return value|result|answer|solution)\b/.test(text)) return false;
  if (/[`_{}\[\]=<>]|\b[A-Za-z_$]\w*\s*\(|\b[A-Za-z_$]\w*\.[A-Za-z_$]\w*/.test(question)) return false;
  if (/\b(?:supplied|provided|attached|shown)\b|\b(?:lock[- ]free|wait[- ]free|memory reclamation)\b/.test(text)) return false;
  if (/\b(?:rollback|rollbacks|failover|reconcil\w*|retr(?:y|ies)|revocation|invalidation|validation|mitigation|spikes?|leaks?|timeouts?|duplicates?|downtime|transaction boundar\w*|signature verification|redirect uri checks?)\b/.test(text)) return false;
  // Conditions turn even a comparison into a task-specific judgment.
  if (/\b(?:without|unless|after|before|despite|except|while|because|if)\b/.test(text)) return false;
  if (/\b(?:hipaa|gdpr|tax|legal|medical|diagnosis|dosage|investment|financial advice)\b/.test(text)) return false;
  if (/\bsiebel\b/.test(text) && /\b(?:\d+(?:\.\d+)*|release|version|patch|hotfix|upgrade|property|properties|command|commands)\b/.test(text)) return false;
  const siebelContext = mode === 'siebel' || /\b(?:siebel|buscomp|eai|eim|mvg)\b/.test(text) || /\bsiebel\b/.test(normalize(previousQuestion));
  if (siebelContext && /\b(?:visibility|access control|data access|record access|positions?|responsibilities|search expressions?|search specs?|user propert\w*|configuration|customi[sz]\w*|escript)\b/.test(text)) return false;
  // Do not downgrade follow-ups whose actual task lives in earlier conversation.
  if (/\b(?:it|its|they|them|their|this|that|these|those|above|earlier|previous|same|my|our|your)\b/.test(text)) return false;
  if (/\b(?:former|latter|first|second|third|last|next|alternative|recommended|proposed|chosen)\s+(?:approach|option|plan|solution|design|strategy|method|example)\b|\b(?:option|plan|approach|solution)\s+(?:[a-z]|\d+)\b/.test(text)) return false;
  if (/\b(?:achievements?|accomplishments?|employment|experience|recent project)\b/.test(text)) return false;
  if (/^(?:and\b|also\b|what about\b|how about\b|why\b|how\b|could we\b|can we\b)/.test(text)) return false;
  if (/\b(?:and then|and (?:why|how|what|explain|compare|give|show|include|discuss)|as well as|along with)\b/.test(text)) return false;

  const unwrapped = text.replace(/^(?:(?:please|okay|ok|so)\s*[,.:]?\s*)+/, '')
    .replace(/^(?:can|could|would) you\s+(?:please\s+)?/, '')
    .replace(/^(?:please\s+)?(?:tell me\s+|explain\s+(?:to me\s+|me\s+)?)(?=what\b)/, '');
  // Incomplete speech and self-corrections are uncertain input, not an easy
  // question. Turn assembly still decides when a question may be submitted.
  if (/(?:\.\.\.|…|—|--)\s*$/.test(unwrapped) || /\b(?:sorry|i mean|correction|actually)\b/.test(unwrapped)) return false;
  const completeText = unwrapped.replace(/[?.!]+$/, '').trim();
  if (/\b(?:a|an|the|me|you|to|in|for|of|on|at|with|without|and|or|but|because|between|versus|vs|is|are|um|uh|please)$/.test(completeText)) return false;
  if (normalize(previousQuestion)) {
    const facet = '(?:latency|costs?|performance|security|failure handling|recovery|fallback|complexity|edge cases|limitations|scalability|assumptions|advantages|disadvantages|impact|approach)';
    // "What is latency?" can introduce a new definition. "What is the
    // latency?" or "Explain performance" usually refers to the prior task.
    if (new RegExp(`^(?:(?:explain|describe) (?:the )?|what (?:is|are) the )${facet}[?.!]*$`).test(unwrapped)) return false;
  }
  // These are task shapes, not a topic whitelist: any domain may match.
  const comparison = /^(?:(?:what (?:is|are) (?:the )?)?(?:differences? between)|compare|(?:what (?:is|are) (?:the )?)?difference (?:in|of))\s+(.+?)[?.!]*$/.exec(unwrapped);
  if (comparison) {
    const subject = comparison[1];
    return subject.split(' ').length <= 12 && !/\b(?:why|how|when|which|whether|for|in|with|using|by)\b/.test(subject) && (subject.match(/\band\b|\bversus\b|\bvs\.?\b/g) || []).length === 1;
  }
  const definition = /^(?:what (?:is|are)|define|explain|describe)\s+(.+?)[?.!]*$/.exec(unwrapped);
  if (definition) {
    const subject = definition[1].replace(/^(?:a|an|the|to me|me)\s+/, '').replace(/[?.!]+$/, '');
    // A standalone concept, not an embedded scenario or multiple separate requests.
    return subject.length > 1 && subject.split(' ').length <= 12 && !/\b(?:how|why|when|which|whether)\b|\band\b|\.(?:\s|$)/.test(subject);
  }
  return false;
}

function selectRoute({ question, model, provider = 'openai', fastModel = '', adaptiveModels = true, availableModels = [], mode = 'auto', depth = 'auto', previousQuestion } = {}) {
  const selectedModel = typeof model === 'string' ? model.trim() : '';
  const selectedProvider = normalize(provider);
  const requestedFastModel = typeof fastModel === 'string' ? fastModel.trim() : '';
  const base = { model: selectedModel, kind: 'fixed', concise: false, reason: 'Using the selected model.' };
  if (!adaptiveModels) return base;
  if (!standaloneSimple(question, depth, previousQuestion, mode)) return { ...base, kind: 'deep', reason: 'Keeping the selected model for a detailed, contextual, or uncertain question.' };
  const offered = new Set(Array.isArray(availableModels) ? availableModels.map((entry) => entry?.slug).filter((slug) => typeof slug === 'string') : []);
  const knownProvider = Object.hasOwn(LIGHT_MODELS_BY_PROVIDER, selectedProvider);
  // An explicit choice is an instruction, not a hint: an unavailable choice
  // must not silently select a different model or switch provider/billing.
  const lightweight = knownProvider ? (requestedFastModel
    ? (offered.has(requestedFastModel) ? requestedFastModel : undefined)
    : LIGHT_MODELS_BY_PROVIDER[selectedProvider].find((slug) => offered.has(slug))) : undefined;
  const routedModel = lightweight || selectedModel;
  const route = {
    model: routedModel,
    kind: 'quick',
    concise: true,
    reason: lightweight
      ? (requestedFastModel ? 'A short standalone question can use your available quick-answer model.' : 'A short standalone question can use an available lighter model.')
      : 'A short standalone question can use a brief answer on the selected model.',
  };
  if (selectedProvider === 'openai' || selectedProvider === 'chatgpt') {
    if (LIGHT_MODELS.includes(routedModel)) route.reasoningEffort = 'none';
    else if (LOW_EFFORT_MODELS.has(routedModel)) route.reasoningEffort = 'low';
  }
  return route;
}

module.exports = { selectRoute };
