'use strict';

// Protocol references:
// https://platform.claude.com/docs/en/build-with-claude/streaming
// https://platform.claude.com/docs/en/api/models/list
// https://ai.google.dev/gemini-api/docs/generate-content/text-generation
// https://ai.google.dev/api/models
// Compatible endpoints implement the OpenAI Chat Completions streaming protocol.
const { streamAnswer, buildInstructions } = require('./providers.cjs');
const LABELS = Object.freeze({ openai: 'OpenAI', chatgpt: 'ChatGPT', anthropic: 'Claude', gemini: 'Gemini', compatible: 'Custom provider' });
const MAX_EVENT = 2 * 1024 * 1024;
const MAX_OUTPUT = 256 * 1024;
const SAFE_ERROR_CODES = Object.freeze({
  authentication_error: 'authentication_error', invalid_api_key: 'authentication_error', unauthenticated: 'authentication_error',
  permission_error: 'permission_error', permission_denied: 'permission_error',
  rate_limit_error: 'rate_limit_error', rate_limit_exceeded: 'rate_limit_error',
  insufficient_quota: 'insufficient_quota', resource_exhausted: 'resource_exhausted',
});

class AdapterError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'ProviderError';
    Object.assign(this, details);
  }
}

function invalid(message) { return new AdapterError(message, { code: 'INVALID_INPUT', partialText: '' }); }
function checkAborted(signal) {
  if (signal?.aborted) throw Object.assign(new Error('Answer generation cancelled.'), { name: 'AbortError', code: 'ABORT_ERR' });
}
function textInput(value, name, required = false) {
  if (typeof value !== 'string' || (required && !value.trim())) throw invalid(`${name} must be ${required ? 'a nonempty' : 'a'} string.`);
  return value;
}
function providerLabel(provider) {
  if (!Object.hasOwn(LABELS, provider)) throw invalid('Unknown answer provider.');
  return LABELS[provider];
}

function normalizeUsage(value, provider) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const usage = { ...value };
  const input = provider === 'gemini' ? value.promptTokenCount : value.prompt_tokens;
  const output = provider === 'gemini' ? value.candidatesTokenCount : value.completion_tokens;
  const total = provider === 'gemini' ? value.totalTokenCount : value.total_tokens;
  if (Number.isFinite(input)) usage.input_tokens = input;
  if (Number.isFinite(output)) usage.output_tokens = output;
  if (Number.isFinite(total)) usage.total_tokens = total;
  return usage;
}

function safeStreamErrorCode(event) {
  const error = event.error || event;
  for (const value of [error.code, error.type, error.status]) {
    if (typeof value === 'string' && value.length <= 64 && Object.hasOwn(SAFE_ERROR_CODES, value.toLowerCase())) return SAFE_ERROR_CODES[value.toLowerCase()];
  }
  return 'RESPONSE_FAILED';
}

function isLoopbackHost(host) {
  return host === 'localhost' || host === '[::1]' || /^127(?:\.\d{1,3}){3}$/.test(host);
}

function validateBaseUrl(value) {
  textInput(value, 'API base URL', true);
  let url;
  try { url = new URL(value.trim()); } catch { throw invalid('Enter a valid API base URL.'); }
  const loopback = isLoopbackHost(url.hostname);
  if (url.username || url.password || url.search || url.hash || !['https:', 'http:'].includes(url.protocol) || (url.protocol === 'http:' && !loopback)) {
    throw invalid('Use an HTTPS API base URL, or HTTP on localhost, without credentials, query parameters, or a fragment.');
  }
  return url.href.replace(/\/+$/, '');
}

function connection(provider, apiKey, baseUrl) {
  const label = providerLabel(provider);
  textInput(apiKey, `${label} API key`, provider !== 'compatible');
  const headers = { 'Content-Type': 'application/json' };
  let base;
  if (provider === 'anthropic') {
    base = 'https://api.anthropic.com/v1';
    headers['x-api-key'] = apiKey.trim();
    headers['anthropic-version'] = '2023-06-01';
  } else if (provider === 'gemini') {
    base = 'https://generativelanguage.googleapis.com/v1beta';
    headers['x-goog-api-key'] = apiKey.trim();
  } else {
    base = provider === 'compatible' ? validateBaseUrl(baseUrl) : 'https://api.openai.com/v1';
    const host = new URL(base).hostname;
    if (provider === 'compatible' && !apiKey.trim() && !isLoopbackHost(host)) throw invalid('A remote custom provider requires an API key.');
    if (apiKey.trim()) headers.Authorization = `Bearer ${apiKey.trim()}`;
  }
  return { base, headers, label };
}

async function request(url, { headers, signal, body, label }) {
  checkAborted(signal);
  let response;
  try {
    response = await fetch(url, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { ...headers, Accept: body === undefined ? 'application/json' : 'text/event-stream' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal,
      redirect: 'error',
    });
  } catch (error) {
    checkAborted(signal);
    if (error?.name === 'AbortError') throw error;
    // Never include fetch errors or raw provider bodies; either may echo a key/URL.
    throw new AdapterError(`Could not connect to ${label}. Check the network and API endpoint.`, { code: 'NETWORK_ERROR', partialText: '' });
  }
  checkAborted(signal);
  if (!response.ok) {
    const help = response.status === 401 ? 'Check the saved API key.'
      : response.status === 403 ? 'Check the key permissions and model access.'
        : response.status === 429 ? 'Check provider quota, billing, or rate limits.'
          : response.status === 400 || response.status === 404 ? 'Check the model ID and API settings.'
            : 'Try again when the provider is available.';
    await response.body?.cancel().catch(() => {});
    throw new AdapterError(`${label} request failed (${response.status}). ${help}`, { code: 'HTTP_ERROR', status: response.status, partialText: '' });
  }
  return response;
}

async function readEvents(response, signal, onEvent, isComplete) {
  if (!response.body || typeof response.body.getReader !== 'function') throw new AdapterError('The provider returned no readable response stream.', { code: 'INVALID_STREAM' });
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '', lines = [], eventName = '', eventChars = 0;
  const cancel = () => { reader.cancel().catch(() => {}); };
  signal?.addEventListener('abort', cancel, { once: true });
  const fail = () => { throw new AdapterError('The provider sent an invalid or oversized streaming event.', { code: 'INVALID_STREAM' }); };
  const dispatch = () => {
    if (!lines.length) { eventName = ''; eventChars = 0; return; }
    const data = lines.join('\n');
    lines = []; eventChars = 0;
    const name = eventName; eventName = '';
    if (data.trim() === '[DONE]') { onEvent({ done: true }, name); return; }
    let event;
    try { event = JSON.parse(data); } catch { fail(); }
    if (!event || typeof event !== 'object' || Array.isArray(event)) fail();
    onEvent(event, name);
    checkAborted(signal);
  };
  const consume = (line) => {
    if (!line) return dispatch();
    if (line.startsWith(':')) return;
    const colon = line.indexOf(':');
    const field = colon < 0 ? line : line.slice(0, colon);
    const value = colon < 0 ? '' : line.slice(colon + 1).replace(/^ /, '');
    if (field === 'data') { eventChars += value.length; if (eventChars > MAX_EVENT) fail(); lines.push(value); }
    else if (field === 'event') eventName = value;
  };
  const process = (eof) => {
    while (!isComplete()) {
      const index = buffer.search(/[\r\n]/);
      if (index < 0) break;
      if (buffer[index] === '\r' && index === buffer.length - 1 && !eof) break;
      const length = buffer[index] === '\r' && buffer[index + 1] === '\n' ? 2 : 1;
      const line = buffer.slice(0, index); buffer = buffer.slice(index + length);
      consume(line);
    }
    if (!isComplete() && buffer.length > MAX_EVENT) fail();
    if (eof && !isComplete()) {
      if (buffer) { consume(buffer); buffer = ''; }
      dispatch();
    }
  };
  try {
    while (!isComplete()) {
      checkAborted(signal);
      const chunk = await reader.read();
      checkAborted(signal);
      buffer += chunk.done ? decoder.decode() : decoder.decode(chunk.value, { stream: true });
      process(chunk.done);
      if (chunk.done) break;
    }
  } finally {
    signal?.removeEventListener('abort', cancel);
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

async function streamProviderAnswer(options = {}) {
  const { provider, apiKey = '', model, question, transcript = '', context = '', mode = 'auto', depth = 'auto', concise = false, baseUrl, signal, onDelta = () => {} } = options;
  providerLabel(provider);
  checkAborted(signal);
  if (provider === 'openai' || provider === 'chatgpt') return streamAnswer({ ...options, authType: provider === 'chatgpt' ? 'chatgpt' : 'api-key' });
  textInput(model, 'Model', true); textInput(question, 'Question', true);
  textInput(transcript, 'Transcript'); textInput(context, 'Context');
  if (typeof onDelta !== 'function') throw invalid('onDelta must be a function.');
  const instructions = buildInstructions(mode, depth, concise);
  const reference = JSON.stringify({ reference_material: { transcript, context } });
  const connectionInfo = connection(provider, apiKey, baseUrl);
  const selectedModel = model.trim();
  let url, body;
  if (provider === 'anthropic') {
    url = `${connectionInfo.base}/messages`;
    body = { model: selectedModel, max_tokens: concise ? 1200 : 4096, system: instructions,
      messages: [{ role: 'user', content: reference }, { role: 'user', content: question.trim() }], stream: true };
  } else if (provider === 'gemini') {
    const id = selectedModel.replace(/^models\//, '');
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,199}$/.test(id)) throw invalid('Enter a valid Gemini model ID.');
    url = `${connectionInfo.base}/models/${encodeURIComponent(id)}:streamGenerateContent?alt=sse`;
    body = { systemInstruction: { parts: [{ text: instructions }] },
      contents: [{ role: 'user', parts: [{ text: reference }] }, { role: 'user', parts: [{ text: question.trim() }] }],
      generationConfig: { maxOutputTokens: concise ? 2048 : 8192 } };
  } else {
    url = `${connectionInfo.base}/chat/completions`;
    body = { model: selectedModel, messages: [{ role: 'system', content: instructions }, { role: 'user', content: reference }, { role: 'user', content: question.trim() }], stream: true, max_tokens: concise ? 1200 : 4096 };
  }
  const response = await request(url, { ...connectionInfo, signal, body });
  let text = '', usage = null, responseId = null, responseModel = selectedModel, completed = false, finishReason = null;
  const fail = (message, code = 'RESPONSE_FAILED') => { throw new AdapterError(message, { code, partialText: text }); };
  const append = (part) => {
    if (typeof part !== 'string') fail('The provider sent an invalid text fragment.', 'INVALID_STREAM');
    if (text.length + part.length > MAX_OUTPUT) fail('The answer exceeded the output size limit.', 'RESPONSE_INCOMPLETE');
    text += part; onDelta(part); checkAborted(signal);
  };
  const onEvent = (event, name) => {
    if (event.error || event.type === 'error' || name === 'error') fail(`${connectionInfo.label} could not complete the answer. Check its status and quota.`, safeStreamErrorCode(event));
    if (provider === 'anthropic') {
      const type = event.type || name;
      if (type === 'message_start') {
        responseId = event.message?.id || responseId; responseModel = event.message?.model || responseModel;
        usage = event.message?.usage || usage;
      } else if (type === 'content_block_start' && event.content_block?.type === 'text' && event.content_block.text) append(event.content_block.text);
      else if (type === 'content_block_delta' && event.delta?.type === 'text_delta') append(event.delta.text);
      else if (type === 'message_delta') { finishReason = event.delta?.stop_reason || finishReason; usage = { ...(usage || {}), ...(event.usage || {}) }; }
      else if (type === 'message_stop') {
        if (!['end_turn', 'stop_sequence'].includes(finishReason)) fail('Claude stopped before completing a text answer.', 'RESPONSE_INCOMPLETE');
        completed = true;
      }
    } else if (provider === 'gemini') {
      responseId = event.responseId || responseId; responseModel = event.modelVersion || responseModel;
      usage = normalizeUsage(event.usageMetadata, provider) || usage;
      if (event.promptFeedback?.blockReason) fail('Gemini could not answer this prompt because it was blocked.', 'CONTENT_BLOCKED');
      const candidate = event.candidates?.find((item) => item.index === 0) || event.candidates?.[0];
      for (const part of candidate?.content?.parts || []) if (part.thought !== true && typeof part.text === 'string') append(part.text);
      if (candidate?.finishReason) {
        finishReason = candidate.finishReason;
        if (finishReason !== 'STOP') fail(finishReason === 'MAX_TOKENS' ? 'Gemini reached its output limit before completing the answer.' : 'Gemini stopped before completing a text answer.', 'RESPONSE_INCOMPLETE');
        completed = true;
      }
    } else {
      responseId = event.id || responseId; responseModel = event.model || responseModel; usage = normalizeUsage(event.usage, provider) || usage;
      if (event.done) { if (!finishReason) fail('The provider ended without confirming completion.', 'STREAM_INTERRUPTED'); completed = true; return; }
      const choice = event.choices?.find((item) => item.index === 0) || event.choices?.[0];
      if (choice?.delta?.content != null) append(choice.delta.content);
      if (choice?.delta?.refusal != null) append(choice.delta.refusal);
      if (choice?.finish_reason) {
        finishReason = choice.finish_reason;
        if (finishReason !== 'stop') fail('The provider stopped before completing a text answer.', 'RESPONSE_INCOMPLETE');
      }
    }
  };
  try {
    await readEvents(response, signal, onEvent, () => completed);
    checkAborted(signal);
    if (!completed && !(provider === 'compatible' && finishReason === 'stop')) fail('The connection ended before the answer completed. Retry when ready.', 'STREAM_INTERRUPTED');
    return { text, usage, responseId, model: responseModel };
  } catch (error) {
    checkAborted(signal);
    if (error?.name === 'AbortError') throw error;
    if (error instanceof AdapterError) { error.partialText = text; throw error; }
    throw new AdapterError(`${connectionInfo.label} answer streaming failed. Check the connection and try again.`, { code: 'STREAM_ERROR', partialText: text });
  }
}

async function readModelPage(response, signal) {
  if (!response.body || typeof response.body.getReader !== 'function') throw new AdapterError('The provider returned an invalid model catalog.', { code: 'INVALID_RESPONSE' });
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let value = '', bytes = 0;
  const cancel = () => { reader.cancel().catch(() => {}); };
  signal?.addEventListener('abort', cancel, { once: true });
  try {
    while (true) {
      checkAborted(signal);
      const chunk = await reader.read();
      checkAborted(signal);
      if (chunk.done) { value += decoder.decode(); break; }
      bytes += chunk.value.byteLength;
      if (bytes > MAX_EVENT) throw new AdapterError('The model catalog exceeded the size limit.', { code: 'INVALID_RESPONSE' });
      value += decoder.decode(chunk.value, { stream: true });
    }
    try { return JSON.parse(value); } catch { throw new AdapterError('The provider returned an invalid model catalog.', { code: 'INVALID_RESPONSE' }); }
  } catch (error) {
    checkAborted(signal);
    if (error?.name === 'AbortError' || error instanceof AdapterError) throw error;
    throw new AdapterError('Could not read the model catalog. Check the connection and try again.', { code: 'NETWORK_ERROR', partialText: '' });
  } finally {
    signal?.removeEventListener('abort', cancel);
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

async function listProviderModels({ provider, apiKey = '', baseUrl, signal } = {}) {
  providerLabel(provider);
  checkAborted(signal);
  if (provider === 'chatgpt') throw invalid('Load ChatGPT models through the connected account.');
  const connectionInfo = connection(provider, apiKey, baseUrl);
  const models = new Map();
  const cursors = new Set();
  let cursor;
  for (let page = 0; page < 10; page++) {
    const url = new URL(`${connectionInfo.base}/models`);
    if (provider === 'anthropic') { url.searchParams.set('limit', '100'); if (cursor) url.searchParams.set('after_id', cursor); }
    if (provider === 'gemini') { url.searchParams.set('pageSize', '100'); if (cursor) url.searchParams.set('pageToken', cursor); }
    const response = await request(url.href, { ...connectionInfo, signal });
    const data = await readModelPage(response, signal);
    const list = provider === 'gemini' ? data?.models : data?.data;
    if (!Array.isArray(list)) throw new AdapterError('The provider returned an invalid model catalog.', { code: 'INVALID_RESPONSE', partialText: '' });
    for (const item of list) {
      if (provider === 'gemini' && (!Array.isArray(item?.supportedGenerationMethods) || !item.supportedGenerationMethods.includes('generateContent'))) continue;
      const id = provider === 'gemini' ? (typeof item?.name === 'string' ? item.name.replace(/^models\//, '') : '') : item?.id;
      if (typeof id !== 'string' || !id.trim() || id.length > 256 || /[\u0000-\u001f\u007f]/.test(id)) continue;
      const display = item.display_name || item.displayName || id;
      models.set(id, { slug: id, display_name: typeof display === 'string' ? display.slice(0, 200) : id });
      if (models.size >= 1000) return [...models.values()];
    }
    const next = provider === 'anthropic' && data.has_more ? data.last_id : provider === 'gemini' ? data.nextPageToken : null;
    if (!next) return [...models.values()];
    if (typeof next !== 'string' || next.length > 4096 || cursors.has(next)) throw new AdapterError('The provider returned an invalid model catalog cursor.', { code: 'INVALID_RESPONSE', partialText: '' });
    cursors.add(next); cursor = next;
  }
  return [...models.values()];
}

module.exports = { streamProviderAnswer, listProviderModels, validateBaseUrl };
