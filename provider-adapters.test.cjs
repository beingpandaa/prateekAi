'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { streamProviderAnswer, listProviderModels, validateBaseUrl } = require('./provider-adapters.cjs');
const key = 'offline-secret-value';
const base = { apiKey: key, model: 'test-model', question: 'What is a closure?' };
const sse = (event) => `data: ${JSON.stringify(event)}\r\n\r\n`;
const anthropicStart = { type: 'message_start', message: { id: 'msg_test', model: 'claude-haiku-4-5', usage: { input_tokens: 10, output_tokens: 0 } } };
const anthropicText = (text) => ({ type: 'content_block_delta', delta: { type: 'text_delta', text } });
const anthropicFinish = sse({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 5 } }) + sse({ type: 'message_stop' });
const geminiText = (text) => ({ candidates: [{ index: 0, content: { parts: [{ text }] } }] });
const geminiFinish = sse({ candidates: [{ index: 0, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 11, candidatesTokenCount: 7 }, modelVersion: 'gemini-3.8-flash', responseId: 'gemini_test' });
const compatibleText = (text) => ({ id: 'custom_test', choices: [{ index: 0, delta: { content: text } }] });
const compatibleFinish = sse({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }) + sse({ choices: [], usage: { prompt_tokens: 3, completion_tokens: 4 } }) + 'data: [DONE]\r\n\r\n';

function stream(source, chunkSize = 999999) {
  const bytes = new TextEncoder().encode(source);
  let offset = 0;
  return new Response(new ReadableStream({
    pull(controller) {
      if (offset >= bytes.length) { controller.close(); return; }
      controller.enqueue(bytes.slice(offset, offset += chunkSize));
    },
  }), { headers: { 'Content-Type': 'text/event-stream' } });
}
function mock(t, responses) {
  const queue = Array.isArray(responses) ? responses : [responses];
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (...args) => {
    calls.push(args);
    assert.ok(queue.length, 'No extra requests or retries are allowed');
    return queue.shift();
  });
  return calls;
}

test('Claude streams text across UTF-8/CRLF boundaries without exposing thinking and preserves grounded context', async (t) => {
  const calls = mock(t, stream(': ping\r\n\r\n' + sse(anthropicStart) + sse({ type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: 'private' } }) + sse(anthropicText('A closure retains 缓存 👍.')) + anthropicFinish, 1));
  const pieces = [];
  const result = await streamProviderAnswer({ ...base, provider: 'anthropic', context: 'Verified profile', transcript: 'Earlier question', concise: true, onDelta: (part) => pieces.push(part) });
  assert.equal(result.text, 'A closure retains 缓存 👍.');
  assert.deepEqual(pieces, ['A closure retains 缓存 👍.']);
  assert.equal(result.responseId, 'msg_test');
  assert.equal(result.model, 'claude-haiku-4-5');
  assert.deepEqual(result.usage, { input_tokens: 10, output_tokens: 5 });
  const [url, request] = calls[0];
  assert.equal(url, 'https://api.anthropic.com/v1/messages');
  assert.equal(request.headers['x-api-key'], key);
  assert.equal(request.headers['anthropic-version'], '2023-06-01');
  assert.equal(request.redirect, 'error');
  const body = JSON.parse(request.body);
  assert.equal(body.stream, true);
  assert.equal(body.max_tokens, 1200);
  assert.match(body.system, /untrusted quoted source material/);
  assert.match(body.system, /Never invent the user/);
  assert.match(body.system, /2–4 direct sentences/);
  assert.deepEqual(JSON.parse(body.messages[0].content), { reference_material: { transcript: 'Earlier question', context: 'Verified profile' } });
  assert.equal(body.messages[1].content, base.question);
  assert.equal(Object.hasOwn(body, 'reasoning'), false);
});

test('Gemini uses key header and native SSE, hides thoughts, and returns usage', async (t) => {
  const calls = mock(t, stream(sse({ candidates: [{ content: { parts: [{ text: 'private', thought: true }, { text: 'A closure ' }] } }] }) + sse(geminiText('retains its scope.')) + geminiFinish, 3));
  const result = await streamProviderAnswer({ ...base, provider: 'gemini', model: 'models/gemini-3.8-flash', reasoningEffort: 'none', context: 'Profile' });
  assert.equal(result.text, 'A closure retains its scope.');
  assert.equal(result.model, 'gemini-3.8-flash');
  assert.equal(result.responseId, 'gemini_test');
  assert.equal(result.usage.candidatesTokenCount, 7);
  assert.equal(result.usage.input_tokens, 11);
  assert.equal(result.usage.output_tokens, 7);
  const [url, request] = calls[0];
  assert.equal(url, 'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:streamGenerateContent?alt=sse');
  assert.equal(url.includes(key), false);
  assert.equal(request.headers['x-goog-api-key'], key);
  const body = JSON.parse(request.body);
  assert.match(body.systemInstruction.parts[0].text, /untrusted quoted source material/);
  assert.equal(JSON.parse(body.contents[0].parts[0].text).reference_material.context, 'Profile');
  assert.equal(body.contents[1].parts[0].text, base.question);
  assert.equal(body.generationConfig.maxOutputTokens, 8192);
  assert.equal(Object.hasOwn(body, 'reasoning'), false);
});

test('compatible endpoint supports local no-key service and reads final usage before DONE', async (t) => {
  const calls = mock(t, stream(sse(compatibleText('Local answer')) + compatibleFinish));
  const result = await streamProviderAnswer({ ...base, provider: 'compatible', apiKey: '', baseUrl: 'http://localhost:1234/v1/', model: 'vendor/model' });
  assert.equal(result.text, 'Local answer');
  assert.equal(result.usage.completion_tokens, 4);
  assert.equal(result.usage.input_tokens, 3);
  assert.equal(result.usage.output_tokens, 4);
  assert.equal(calls[0][0], 'http://localhost:1234/v1/chat/completions');
  assert.equal(Object.hasOwn(calls[0][1].headers, 'Authorization'), false);
  const body = JSON.parse(calls[0][1].body);
  assert.equal(body.model, 'vendor/model');
  assert.equal(body.messages[0].role, 'system');
  assert.equal(body.messages[2].content, base.question);
  assert.equal(body.max_tokens, 4096);
});

test('compatible HTTPS provider sends only its own key and accepts explicit stop followed by EOF', async (t) => {
  const calls = mock(t, stream(sse(compatibleText('Answer')) + sse({ choices: [{ delta: {}, finish_reason: 'stop' }] })));
  assert.equal((await streamProviderAnswer({ ...base, provider: 'compatible', baseUrl: 'https://provider.example/api/v1' })).text, 'Answer');
  assert.equal(calls[0][1].headers.Authorization, `Bearer ${key}`);
  assert.equal(calls[0][1].redirect, 'error');
});

for (const provider of ['chatgpt', 'openai']) {
  test(`${provider} delegates to existing Responses protocol with correct auth mode`, async (t) => {
    const calls = mock(t, stream(sse({ type: 'response.output_text.delta', delta: 'Answer' }) + sse({ type: 'response.completed', response: { status: 'completed' } })));
    assert.equal((await streamProviderAnswer({ ...base, provider, reasoningEffort: 'low' })).text, 'Answer');
    assert.equal(calls[0][0], 'https://api.openai.com/v1/responses');
    const body = JSON.parse(calls[0][1].body);
    assert.equal(Object.hasOwn(body, 'max_output_tokens'), provider === 'openai');
    assert.deepEqual(body.reasoning, { effort: 'low' });
  });
}

test('Claude model catalog paginates with its own headers and deduplicates IDs', async (t) => {
  const calls = mock(t, [Response.json({ data: [{ id: 'claude-haiku-4-5', display_name: 'Haiku' }], has_more: true, last_id: 'first' }), Response.json({ data: [{ id: 'claude-haiku-4-5', display_name: 'Haiku' }, { id: 'claude-sonnet-5-5', display_name: 'Sonnet' }], has_more: false })]);
  const models = await listProviderModels({ provider: 'anthropic', apiKey: key });
  assert.deepEqual(models, [{ slug: 'claude-haiku-4-5', display_name: 'Haiku' }, { slug: 'claude-sonnet-5-5', display_name: 'Sonnet' }]);
  assert.match(calls[1][0], /after_id=first/);
  assert.equal(calls[0][1].headers['x-api-key'], key);
  assert.equal(calls[0][1].method, 'GET');
});

test('Gemini model catalog filters generation support and paginates without putting key in URL', async (t) => {
  const calls = mock(t, [Response.json({ models: [{ name: 'models/gemini-3.8-flash', displayName: 'Flash', supportedGenerationMethods: ['generateContent'] }, { name: 'models/embedding', supportedGenerationMethods: ['embedContent'] }, { name: 4, supportedGenerationMethods: ['generateContent'] }], nextPageToken: 'page two' }), Response.json({ models: [{ name: 'models/gemini-3.5-flash-lite', supportedGenerationMethods: ['generateContent'] }] })]);
  const models = await listProviderModels({ provider: 'gemini', apiKey: key });
  assert.deepEqual(models.map((item) => item.slug), ['gemini-3.8-flash', 'gemini-3.5-flash-lite']);
  assert.equal(models[0].display_name, 'Flash');
  assert.match(calls[1][0], /pageToken=page\+two/);
  assert.equal(calls[0][0].includes(key), false);
  assert.equal(calls[0][1].headers['x-goog-api-key'], key);
});

for (const provider of ['openai', 'compatible']) {
  test(`${provider} model catalog normalizes IDs without assuming proprietary model names`, async (t) => {
    const calls = mock(t, Response.json({ data: [{ id: 'vendor/model' }, { id: 'local-model' }, { id: '' }, { id: 'bad\nvalue' }, null] }));
    const result = await listProviderModels({ provider, apiKey: key, baseUrl: 'https://custom.example/v1' });
    assert.deepEqual(result.map((item) => item.slug), ['vendor/model', 'local-model']);
    assert.equal(calls[0][1].headers.Authorization, `Bearer ${key}`);
    assert.equal(calls[0][1].redirect, 'error');
  });
}

test('compatible local catalog omits Authorization when key is blank', async (t) => {
  const calls = mock(t, [Response.json({ data: [] }), Response.json({ data: [] })]);
  await listProviderModels({ provider: 'compatible', baseUrl: 'http://127.0.0.1:11434/v1' });
  await listProviderModels({ provider: 'compatible', baseUrl: 'http://127.0.0.2:11434/v1' });
  assert.equal(Object.hasOwn(calls[0][1].headers, 'Authorization'), false);
  assert.equal(Object.hasOwn(calls[1][1].headers, 'Authorization'), false);
});

test('custom URL validation allows HTTPS and loopback HTTP and rejects embedded credentials or routing parameters', () => {
  for (const value of ['https://provider.example/v1/', 'http://localhost:1234/v1/', 'http://127.0.0.1:11434/v1', 'http://[::1]:1234/v1']) assert.equal(validateBaseUrl(value), value.replace(/\/+$/, ''));
  for (const value of ['', 'invalid', 'http://provider.example/v1', 'https://key@provider.example/v1', 'https://a:b@provider.example/v1', 'https://provider.example/v1?key=secret', 'https://provider.example/v1#secret', 'file:///tmp/app', 'ftp://localhost/test']) assert.throws(() => validateBaseUrl(value), { code: 'INVALID_INPUT' }, value);
});

test('invalid settings and pre-abort do not send requests', async (t) => {
  const calls = mock(t, []);
  await assert.rejects(streamProviderAnswer({ ...base, provider: 'unknown' }), { code: 'INVALID_INPUT' });
  await assert.rejects(streamProviderAnswer({ ...base, provider: 'anthropic', mode: 'toString' }), { code: 'INVALID_INPUT' });
  await assert.rejects(streamProviderAnswer({ ...base, provider: 'anthropic', concise: 'yes' }), { code: 'INVALID_INPUT' });
  await assert.rejects(streamProviderAnswer({ ...base, provider: 'gemini', model: '../unexpected' }), { code: 'INVALID_INPUT' });
  await assert.rejects(streamProviderAnswer({ ...base, provider: 'compatible', apiKey: '', baseUrl: 'https://remote.example/v1' }), { code: 'INVALID_INPUT' });
  await assert.rejects(listProviderModels({ provider: 'chatgpt', apiKey: key }), { code: 'INVALID_INPUT' });
  const controller = new AbortController(); controller.abort();
  await assert.rejects(streamProviderAnswer({ ...base, provider: 'anthropic', signal: controller.signal }), { name: 'AbortError' });
  assert.equal(calls.length, 0);
});

test('HTTP error bodies and fetch failures cannot leak credentials', async (t) => {
  const calls = mock(t, new Response(JSON.stringify({ error: { message: key } }), { status: 401 }));
  await assert.rejects(streamProviderAnswer({ ...base, provider: 'anthropic' }), (error) => error.status === 401 && !error.message.includes(key));
  assert.equal(calls.length, 1);
  t.mock.method(globalThis, 'fetch', async () => { throw new Error(`Fetch failed with ${key}`); });
  await assert.rejects(listProviderModels({ provider: 'gemini', apiKey: key }), (error) => error.code === 'NETWORK_ERROR' && !error.message.includes(key));
});

test('in-band SSE provider error is sanitized while retaining partial text', async (t) => {
  const calls = mock(t, stream(sse(anthropicText('Already shown')) + sse({ type: 'error', error: { type: 'overloaded_error', message: key } })));
  await assert.rejects(streamProviderAnswer({ ...base, provider: 'anthropic' }), (error) => error.code === 'RESPONSE_FAILED' && error.partialText === 'Already shown' && !error.message.includes(key));
  assert.equal(calls.length, 1);
});

test('recognized quota/authentication SSE codes support safe auto-answer pauses without echoing arbitrary codes', async (t) => {
  const cases = [
    [{ type: 'rate_limit_error' }, 'rate_limit_error'],
    [{ type: 'authentication_error' }, 'authentication_error'],
    [{ type: 'permission_error' }, 'permission_error'],
    [{ code: 'insufficient_quota' }, 'insufficient_quota'],
    [{ code: 429, status: 'RESOURCE_EXHAUSTED' }, 'resource_exhausted'],
    [{ status: 'UNAUTHENTICATED' }, 'authentication_error'],
    [{ type: 'overloaded_error' }, 'RESPONSE_FAILED'],
    [{ code: key }, 'RESPONSE_FAILED'],
  ];
  const calls = mock(t, cases.map(([error]) => stream(sse(anthropicText('partial')) + sse({ type: 'error', error: { ...error, message: key } }))));
  for (const [, expected] of cases) {
    await assert.rejects(streamProviderAnswer({ ...base, provider: 'anthropic' }), (error) => error.code === expected && error.partialText === 'partial' && !error.message.includes(key));
  }
  assert.equal(calls.length, cases.length);
});

test('truncated streams are not accepted as successful answers', async (t) => {
  mock(t, [stream(sse(anthropicText('partial'))), stream(sse(geminiText('partial'))), stream(sse(compatibleText('partial')) + 'data: [DONE]\n\n')]);
  for (const provider of ['anthropic', 'gemini', 'compatible']) await assert.rejects(streamProviderAnswer({ ...base, provider, baseUrl: 'https://custom.example/v1' }), (error) => error.code === 'STREAM_INTERRUPTED' && error.partialText === 'partial');
});

test('output limits and blocked prompts are explicit failures, without hidden retries', async (t) => {
  const calls = mock(t, [stream(sse(anthropicText('partial')) + sse({ type: 'message_delta', delta: { stop_reason: 'max_tokens' } }) + sse({ type: 'message_stop' })), stream(sse({ promptFeedback: { blockReason: 'SAFETY' } })), stream(sse({ candidates: [{ content: { parts: [{ text: 'partial' }] }, finishReason: 'MAX_TOKENS' }] })), stream(sse({ choices: [{ delta: { content: 'partial' }, finish_reason: 'length' }] }))]);
  await assert.rejects(streamProviderAnswer({ ...base, provider: 'anthropic' }), { code: 'RESPONSE_INCOMPLETE', partialText: 'partial' });
  await assert.rejects(streamProviderAnswer({ ...base, provider: 'gemini' }), { code: 'CONTENT_BLOCKED' });
  await assert.rejects(streamProviderAnswer({ ...base, provider: 'gemini' }), { code: 'RESPONSE_INCOMPLETE', partialText: 'partial' });
  await assert.rejects(streamProviderAnswer({ ...base, provider: 'compatible', baseUrl: 'https://custom.example/v1' }), { code: 'RESPONSE_INCOMPLETE', partialText: 'partial' });
  assert.equal(calls.length, 4);
});

test('malformed and oversized SSE events fail safely', async (t) => {
  mock(t, [stream('data: {broken}\n\n'), stream('data: ' + 'x'.repeat(2 * 1024 * 1024 + 1)), stream(sse(anthropicText('x'.repeat(256 * 1024 + 1))))]);
  for (const code of ['INVALID_STREAM', 'INVALID_STREAM', 'RESPONSE_INCOMPLETE']) await assert.rejects(streamProviderAnswer({ ...base, provider: 'anthropic' }), { code });
});

test('cancellation during a stalled response cancels the reader', async (t) => {
  let cancelled = false;
  const controller = new AbortController();
  mock(t, new Response(new ReadableStream({ cancel() { cancelled = true; } })));
  const pending = streamProviderAnswer({ ...base, provider: 'anthropic', signal: controller.signal });
  await new Promise((resolve) => setImmediate(resolve));
  controller.abort();
  await assert.rejects(pending, { name: 'AbortError' });
  assert.equal(cancelled, true);
});

test('cancellation from a delta prevents later buffered text', async (t) => {
  mock(t, stream(sse(anthropicText('first')) + sse(anthropicText('second')) + anthropicFinish));
  const controller = new AbortController();
  const parts = [];
  await assert.rejects(streamProviderAnswer({ ...base, provider: 'anthropic', signal: controller.signal, onDelta(text) { parts.push(text); controller.abort(); } }), { name: 'AbortError' });
  assert.deepEqual(parts, ['first']);
});

test('malformed catalogs and repeated cursors are rejected without unbounded requests', async (t) => {
  const calls = mock(t, [Response.json({ data: {} }), Response.json({ models: [], nextPageToken: 'same' }), Response.json({ models: [], nextPageToken: 'same' })]);
  await assert.rejects(listProviderModels({ provider: 'anthropic', apiKey: key }), { code: 'INVALID_RESPONSE' });
  await assert.rejects(listProviderModels({ provider: 'gemini', apiKey: key }), { code: 'INVALID_RESPONSE' });
  assert.equal(calls.length, 3);
});

test('catalog cancellation and stream read errors never expose raw error messages', async (t) => {
  const controller = new AbortController();
  let cancelled = false;
  mock(t, new Response(new ReadableStream({ cancel() { cancelled = true; } })));
  const pending = listProviderModels({ provider: 'gemini', apiKey: key, signal: controller.signal });
  await new Promise((resolve) => setImmediate(resolve)); controller.abort();
  await assert.rejects(pending, { name: 'AbortError' });
  assert.equal(cancelled, true);
  mock(t, new Response(new ReadableStream({ start(streamController) { streamController.error(new Error(key)); } })));
  await assert.rejects(listProviderModels({ provider: 'gemini', apiKey: key }), (error) => error.code === 'NETWORK_ERROR' && !error.message.includes(key));
});
