'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { selectRoute } = require('./routing.cjs');
const model = 'gpt-5.6-sol';
const availableModels = [{ slug: 'gpt-5.6-luna', display_name: 'Luna' }, { slug: model }];
const route = (question, extra = {}) => selectRoute({ question, model, availableModels, ...extra });

test('short standalone explanations and comparisons use an available lighter model across domains', () => {
  for (const question of [
    'What are closures?',
    'Can you explain me what are closures?',
    'Please explain recursion.',
    'What is authentication?',
    'Explain SQL injection.',
    'What is Siebel CRM?',
    'Describe Siebel business components.',
    'What is the difference between authentication and authorization?',
    'Compare SQL and NoSQL.',
    'What is product market fit?',
    'Explain photosynthesis.',
  ]) {
    const result = route(question);
    assert.equal(result.kind, 'quick', question);
    assert.equal(result.model, 'gpt-5.6-luna', question);
    assert.equal(result.reasoningEffort, 'none', question);
    assert.equal(result.concise, true, question);
  }
});

test('routing requires catalog evidence and prefers the newer Luna when both are offered', () => {
  assert.equal(route('What are closures?', { availableModels: [...availableModels, { slug: 'gpt-6-luna' }] }).model, 'gpt-6-luna');
  for (const list of [[], null, undefined, [{ slug: 'gpt-6-luna-preview' }], ['gpt-6-luna'], [{ id: 'gpt-6-luna' }]]) {
    const result = route('What are closures?', { availableModels: list });
    assert.equal(result.model, model);
    assert.equal(result.reasoningEffort, 'low');
  }
});

test('detailed, scenario, implementation, debugging, and version-specific questions retain chosen model', () => {
  for (const question of [
    'Design a URL shortener.',
    'Explain a distributed cache.',
    'What is a good algorithm for this problem?',
    'Implement a linked list in Java.',
    'What is the time complexity of quicksort?',
    'Explain why an HTTP retry creates duplicate orders.',
    'Why is the app crashing?',
    'Debug this race condition.',
    'Explain an OAuth threat model.',
    'What is the Siebel 23.7 workspace deployment process?',
    'What is the Siebel version supporting this property?',
    'What is the best database for financial transactions?',
    'What are closures? How do they work?',
    'Explain closures and give an example.',
    'Explain closures in detail.',
    'Explain closures; include their limitations.',
    'Explain closures. Include an example.',
    'Explain closures\nDiscuss performance.',
    'What is the right dosage for a child?',
    'Define a transaction under network partition constraints.',
    'What is the best way to index a data set given a sustained peak workload with uneven sharding and at least a million writes per second?',
  ]) {
    const result = route(question);
    assert.equal(result.kind, 'deep', question);
    assert.equal(result.model, model, question);
    assert.equal(Object.hasOwn(result, 'reasoningEffort'), false, question);
    assert.equal(result.concise, false, question);
  }
});

test('context-dependent follow-ups never downgrade a complex prior request', () => {
  for (const question of ['What about performance?', 'How does it scale?', 'Explain that.', 'And security?', 'Why?', 'What is its bottleneck?']) {
    const result = route(question, { previousQuestion: 'Design a payment platform that safely retries orders.' });
    assert.equal(result.kind, 'deep', question);
    assert.equal(result.model, model, question);
  }
  assert.equal(route('What is a closure?', { previousQuestion: 'Design a payment platform.' }).kind, 'quick');
});

test('senior/applied depth preserve chosen model while focus does not restrict topics', () => {
  for (const depth of ['senior', 'applied']) assert.equal(route('What is a closure?', { depth }).kind, 'deep');
  assert.equal(route('What is a closure?', { depth: 'foundational', mode: 'security' }).kind, 'quick');
});

test('disabling adaptive routing preserves exact chosen model and default reasoning', () => {
  const result = route('What are closures?', { adaptiveModels: false });
  assert.equal(result.model, model);
  assert.equal(result.kind, 'fixed');
  assert.equal(result.concise, false);
  assert.equal(Object.hasOwn(result, 'reasoningEffort'), false);
});

test('unknown custom model receives no unsupported reasoning parameter', () => {
  const result = route('What are closures?', { model: 'private-custom-model', availableModels: [] });
  assert.equal(result.model, 'private-custom-model');
  assert.equal(result.kind, 'quick');
  assert.equal(result.concise, true);
  assert.equal(Object.hasOwn(result, 'reasoningEffort'), false);
  assert.equal(route('What are closures?', { model: 'gpt-6-astra', availableModels: [] }).reasoningEffort, 'low');
});

test('empty and malformed question input safely keeps the chosen model', () => {
  for (const question of ['', '   ', null, {}, undefined]) assert.equal(route(question).kind, 'deep');
  assert.equal(selectRoute().model, '');
});

test('Claude uses only catalog-confirmed Haiku 4.5 alias or its verified snapshot', () => {
  for (const slug of ['claude-haiku-4-5', 'claude-haiku-4-5-20251001']) {
    const result = route('What are closures?', {
      provider: 'anthropic', model: 'claude-sonnet-5', availableModels: [{ slug }],
    });
    assert.equal(result.model, slug);
    assert.equal(result.concise, true);
    assert.equal(Object.hasOwn(result, 'reasoningEffort'), false);
  }
  for (const slug of ['claude-haiku-5', 'claude-haiku-4-5-preview', 'claude-haiku-4-5-20990101']) {
    const result = route('What are closures?', {
      provider: 'anthropic', model: 'claude-sonnet-5', availableModels: [{ slug }],
    });
    assert.equal(result.model, 'claude-sonnet-5', 'Do not infer a new model capability from its name');
    assert.equal(result.concise, true);
  }
});

test('Gemini prefers current stable Flash-Lite and requires the exact catalog ID for older models', () => {
  const candidates = ['gemini-3.5-flash-lite', 'gemini-3.1-flash-lite', 'gemini-2.5-flash-lite'];
  for (let i = 0; i < candidates.length; i++) {
    const result = route('What is Siebel CRM?', {
      provider: 'gemini', model: 'gemini-3.5-flash',
      availableModels: candidates.slice(i).reverse().map(slug => ({ slug })),
    });
    assert.equal(result.model, candidates[i], 'Use known preference order, not server ordering');
    assert.equal(Object.hasOwn(result, 'reasoningEffort'), false);
  }
  for (const slug of ['gemini-2.5-flash-lite-preview-09-2025', 'gemini-flash-lite-latest', 'gemini-3.5-flash-lite-preview']) {
    assert.equal(route('Explain recursion.', {
      provider: 'gemini', model: 'gemini-3.5-flash', availableModels: [{ slug }],
    }).model, 'gemini-3.5-flash');
  }
});

test('automatic model selection never crosses provider families', () => {
  const catalog = [
    { slug: 'gpt-6-luna' }, { slug: 'claude-haiku-4-5' }, { slug: 'gemini-3.5-flash-lite' },
  ];
  for (const [provider, expected] of [
    ['openai', 'gpt-6-luna'], ['chatgpt', 'gpt-6-luna'],
    ['anthropic', 'claude-haiku-4-5'], ['gemini', 'gemini-3.5-flash-lite'],
  ]) {
    assert.equal(route('Explain recursion.', { provider, availableModels: catalog }).model, expected);
  }
  assert.equal(route('Explain recursion.', {
    provider: 'anthropic', model: 'claude-sonnet-5', availableModels,
  }).model, 'claude-sonnet-5', 'An OpenAI catalog must not create a Claude route');
});

test('explicit quick model overrides automatic preference only with catalog evidence', () => {
  const catalog = [{ slug: 'gpt-6-luna' }, { slug: 'gpt-5.6-luna' }];
  assert.equal(route('What are closures?', {
    fastModel: '  gpt-5.6-luna  ', availableModels: catalog,
  }).model, 'gpt-5.6-luna');
  const missing = route('What are closures?', {
    fastModel: 'private-quick-model', availableModels: catalog,
  });
  assert.equal(missing.model, model, 'An explicit unavailable choice must not silently choose another lightweight model');
  assert.equal(missing.concise, true);
  assert.equal(route('What are closures?', { fastModel: ' ', availableModels: catalog }).model, 'gpt-6-luna');
});

test('compatible endpoints require a user-specified catalog-confirmed quick model', () => {
  const catalog = [{ slug: 'my-local-small-model' }, { slug: 'gpt-6-luna' }];
  const base = { provider: 'compatible', model: 'my-default-model', availableModels: catalog };
  assert.equal(route('What are closures?', base).model, 'my-default-model');
  const explicit = route('What are closures?', { ...base, fastModel: 'my-local-small-model' });
  assert.equal(explicit.model, 'my-local-small-model');
  assert.equal(explicit.kind, 'quick');
  assert.equal(Object.hasOwn(explicit, 'reasoningEffort'), false);
  assert.equal(route('What are closures?', { ...base, fastModel: 'unlisted-model' }).model, 'my-default-model');
  assert.equal(route('What are closures?', {
    ...base, fastModel: 'gpt-6-luna',
  }).reasoningEffort, undefined, 'OpenAI-like model names on another server do not establish reasoning support');
});

test('non-OpenAI providers never receive OpenAI reasoning parameters, even with matching names', () => {
  for (const provider of ['anthropic', 'gemini', 'compatible', 'unknown']) {
    const result = route('What are closures?', { provider, model: 'gpt-6-luna', availableModels: [] });
    assert.equal(result.model, 'gpt-6-luna');
    assert.equal(result.concise, true);
    assert.equal(Object.hasOwn(result, 'reasoningEffort'), false);
  }
});

test('unknown and malformed providers cannot invent a route from a valid-looking catalog', () => {
  for (const provider of ['unknown', 'constructor', '__proto__', '', null, {}, 42]) {
    const result = route('What are closures?', { provider, fastModel: 'gpt-5.6-luna' });
    assert.equal(result.model, model);
    assert.equal(result.concise, true);
    assert.equal(Object.hasOwn(result, 'reasoningEffort'), false);
  }
});

test('detailed and contextual requests retain the main model for every provider and explicit quick choice', () => {
  for (const provider of ['openai', 'chatgpt', 'anthropic', 'gemini', 'compatible']) {
    for (const question of ['Implement a cache.', 'What about performance?', 'Explain that.', 'Design a payment platform.']) {
      const result = route(question, {
        provider, model: 'selected-main-model', fastModel: 'selected-quick-model',
        availableModels: [{ slug: 'selected-quick-model' }],
      });
      assert.equal(result.model, 'selected-main-model');
      assert.equal(result.kind, 'deep');
      assert.equal(Object.hasOwn(result, 'reasoningEffort'), false);
    }
  }
});

test('disabled routing ignores explicit quick choices for every provider', () => {
  for (const provider of ['openai', 'chatgpt', 'anthropic', 'gemini', 'compatible']) {
    const result = route('What are closures?', {
      provider, adaptiveModels: false, fastModel: 'selected-quick-model',
      availableModels: [{ slug: 'selected-quick-model' }],
    });
    assert.equal(result.model, model);
    assert.equal(result.kind, 'fixed');
    assert.equal(result.concise, false);
    assert.equal(Object.hasOwn(result, 'reasoningEffort'), false);
  }
});

// Council-authored intent fixtures. The expected route is a conservative policy
// judgment, independent of the router's keyword implementation. These check
// routing decisions only, not model answer quality or real-world accuracy.
const councilCases = [
  ['fundamentals', 'What are closures?', 'quick'],
  ['fundamentals', 'Can you explain me what are closures?', 'quick'],
  ['fundamentals', 'What is lexical scope?', 'quick'],
  ['fundamentals', 'Explain garbage collection.', 'quick'],
  ['DSA', 'What is a trie?', 'quick'],
  ['DSA', 'Explain recursion.', 'quick'],
  ['DSA', 'What is a hash map?', 'quick'],
  ['systems', 'What is CAP theorem?', 'quick'],
  ['systems', 'Define linearizability.', 'quick'],
  ['systems', 'What is system design?', 'quick'],
  ['systems', 'Define idempotency.', 'quick'],
  ['systems', 'Compare TCP and UDP.', 'quick'],
  ['security', 'Explain SQL injection.', 'quick'],
  ['security', 'What is authentication?', 'quick'],
  ['security', 'What is OAuth 2.0?', 'quick'],
  ['security', 'Define least privilege.', 'quick'],
  ['security', 'What is CSRF?', 'quick'],
  ['security', 'What is the difference between authentication and authorization?', 'quick'],
  ['Siebel', 'What is Siebel CRM?', 'quick'],
  ['Siebel', 'Describe Siebel business components.', 'quick'],
  ['Siebel', 'What is EAI?', 'quick'],
  ['Siebel', 'What is EIM?', 'quick'],
  ['general', 'What is product market fit?', 'quick'],
  ['general', 'What is adverse selection?', 'quick'],
  ['unfamiliar domain', 'Explain chiaroscuro.', 'quick'],
  ['unfamiliar domain', 'What is an alluvial fan?', 'quick'],
  ['unfamiliar domain', 'Define participatory budgeting.', 'quick'],
  ['unfamiliar domain', 'What is phototropism?', 'quick'],
  ['new question after complex topic', 'What is a closure?', 'quick', 'Design a payment platform that safely retries orders.'],
  ['new question after complex topic', 'What is latency?', 'quick', 'Design a payment platform that safely retries orders.'],
  ['new question after complex topic', 'Explain encryption.', 'quick', 'Design a payment platform that safely retries orders.'],
  ['short hard DSA', 'Explain correctness of quicksort.', 'deep'],
  ['short hard DSA', 'Explain optimality of Dijkstra.', 'deep'],
  ['short hard DSA', 'What is the invariant?', 'deep'],
  ['code-dependent', 'What is the output?', 'deep'],
  ['code-dependent', 'What is the return value?', 'deep'],
  ['code-dependent', 'What is the result of foo(3)?', 'deep'],
  ['code-dependent', 'Explain integer overflow in the supplied code.', 'deep'],
  ['short hard DSA', 'What is the minimum number of swaps?', 'deep'],
  ['short hard DSA', 'Explain termination of the loop.', 'deep'],
  ['short hard DSA', 'Describe lock-free memory reclamation.', 'deep'],
  ['coding', 'Implement a linked list in Java.', 'deep'],
  ['coding', 'Solve two sum.', 'deep'],
  ['coding', 'What is the time complexity of quicksort?', 'deep'],
  ['systems', 'Design a URL shortener.', 'deep'],
  ['systems', 'Explain exactly-once delivery under partial failure.', 'deep'],
  ['systems', 'Describe payment rollback.', 'deep'],
  ['systems', 'Explain Saga transaction boundaries.', 'deep'],
  ['systems', 'Compare Postgres and MongoDB for payments.', 'deep'],
  ['systems', 'Compare SQL and NoSQL in our architecture.', 'deep'],
  ['systems', 'Explain cache invalidation after writes.', 'deep'],
  ['systems', 'Describe replication with synchronous failover.', 'deep'],
  ['Siebel access', 'Explain Siebel visibility for partner portals.', 'deep'],
  ['Siebel release', 'What is the Siebel 23.7 workspace deployment process?', 'deep'],
  ['Siebel EIM', 'Explain Siebel EIM reconciliation.', 'deep'],
  ['Siebel EAI', 'Describe Siebel EAI retry recovery.', 'deep'],
  ['Siebel EAI', 'What is the Siebel Upsert guarantee?', 'deep'],
  ['Siebel customization', 'Explain BusComp.SetSearchExpr behavior.', 'deep'],
  ['Siebel access', 'Explain Siebel MVG access control.', 'deep'],
  ['Siebel EIM', 'What is EIM_BATCH?', 'deep'],
  ['security controls', 'Explain JWT signature validation.', 'deep'],
  ['security controls', 'Explain OAuth redirect URI checks.', 'deep'],
  ['security controls', 'Explain CSRF mitigation.', 'deep'],
  ['security incident', 'Describe the incident response.', 'deep'],
  ['security constraints', 'Explain token revocation without downtime.', 'deep'],
  ['security decision', 'What is the safest way to store tokens?', 'deep'],
  ['debugging', 'Explain the CPU spike.', 'deep'],
  ['debugging', 'Explain a memory leak.', 'deep'],
  ['debugging', 'Describe timeout recovery.', 'deep'],
  ['debugging', 'Explain duplicate payments after retries.', 'deep'],
  ['experience', 'Describe your recent project.', 'deep'],
  ['experience', 'Explain my achievements at InsuranceDekho.', 'deep'],
  ['experience', 'Describe customer impact of our changes.', 'deep'],
  ['dependent reference', 'Explain the former approach.', 'deep', 'Compare strong consistency and eventual consistency for a payment platform.'],
  ['dependent reference', 'Describe the second option.', 'deep', 'Design a payment platform.'],
  ['dependent reference', 'What is option B?', 'deep', 'Design a payment platform.'],
  ['dependent reference', 'Explain the alternative approach.', 'deep', 'Design a payment platform.'],
  ['dependent reference', 'What is plan A?', 'deep', 'Design a payment platform.'],
  ['context facet', 'Explain the failure handling.', 'deep', 'Design a payment platform.'],
  ['context facet', 'What is the latency?', 'deep', 'Design a payment platform.'],
  ['context facet', 'Explain security.', 'deep', 'Design a payment platform.'],
  ['context facet', 'Describe performance.', 'deep', 'Design a payment platform.'],
  ['ambiguous follow-up', 'What about performance?', 'deep', 'Design a payment platform.'],
  ['ambiguous follow-up', 'Explain that.', 'deep', 'Design a payment platform.'],
  ['ambiguous follow-up', 'How does it scale?', 'deep', 'Design a payment platform.'],
  ['interrupted ASR', 'Explain the', 'deep'],
  ['interrupted ASR', 'What are the', 'deep'],
  ['interrupted ASR', 'Can you explain me', 'deep'],
  ['interrupted ASR', 'Compare SQL and', 'deep'],
  ['interrupted ASR', 'What is the difference between', 'deep'],
  ['interrupted ASR', 'What is a closure in', 'deep'],
  ['interrupted ASR', 'What is a closure for', 'deep'],
  ['interrupted ASR', 'Explain closures because', 'deep'],
  ['interrupted ASR', 'Explain um...', 'deep'],
  ['ASR correction', 'What are closures, sorry, recursion?', 'deep'],
  ['multi-part', 'What are closures? How do they work?', 'deep'],
  ['multi-part', 'Explain closures and give an example.', 'deep'],
  ['explicit depth', 'Explain closures in detail.', 'deep'],
  ['multi-part', 'Explain closures. Include an example.', 'deep'],
  ['constrained comparison', 'Compare closures and classes without using allocation.', 'deep'],
];

for (const [area, question, expected, previousQuestion] of councilCases) {
  test(`council fixture — ${area}: ${question}`, () => {
    const result = route(question, { previousQuestion });
    assert.equal(result.kind, expected);
    assert.equal(result.model, expected === 'quick' ? 'gpt-5.6-luna' : model);
    assert.equal(result.concise, expected === 'quick');
    if (expected === 'deep') assert.equal(Object.hasOwn(result, 'reasoningEffort'), false);
  });
}
