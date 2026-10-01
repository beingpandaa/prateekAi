'use strict';

// Main process only. Never expose these credential records to a renderer.
// https://developers.openai.com/siwc/token-sharing-open-source/sign-in
const http = require('node:http');
const crypto = require('node:crypto');
const ISSUER = 'https://auth.openai.com';
const RESOURCE = 'https://api.openai.com/v1';
const DISCOVERY = `${ISSUER}/.well-known/openid-configuration`;
const PLAN_SCOPE = 'chatgpt.tokens.use.direct';
const SCOPES = `openid profile email offline_access resource.invoke ${PLAN_SCOPE}`;
// Observed on the provider's sign-in page; unknown policy codes stay generic.
const POLICY_DENIED = '3p_delegated_access_policy_denied';
const POLICY_MESSAGE = 'Your organization has not enabled access to this app. Ask your administrator about access. If permitted, use an eligible personal account or an OpenAI API key with separate billing.';
let discoveryCache;
let jwksCache;
let signInActive = false;
const refreshing = new Map();

class AuthError extends Error {
  constructor(message, code, extra = {}) {
    super(message);
    this.name = 'AuthError';
    this.code = code;
    Object.assign(this, extra);
  }
}
const fail = (message, code, extra) => { throw new AuthError(message, code, extra); };
const abortError = () => Object.assign(new Error('ChatGPT sign-in cancelled.'), { name: 'AbortError', code: 'ABORT_ERR' });
const checkAbort = (signal) => { if (signal?.aborted) throw abortError(); };
const validString = (value) => typeof value === 'string' && value.length > 0;
const validClient = (value) => validString(value) && /^[A-Za-z0-9_-]{3,200}$/.test(value) && value !== 'dynamic_agent_client';
const randomValue = () => crypto.randomBytes(32).toString('base64url');
function sameSecret(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const left = Buffer.from(a), right = Buffer.from(b);
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}
function trustedEndpoint(value) {
  let url;
  try { url = new URL(value); } catch { fail('OpenAI discovery returned an invalid endpoint.', 'INVALID_DISCOVERY'); }
  if (url.origin !== ISSUER || url.username || url.password || url.hash) fail('OpenAI discovery endpoint was not trusted.', 'INVALID_DISCOVERY');
  return url.toString();
}
function safeCode(value, fallback) {
  return typeof value === 'string' && /^[A-Za-z0-9_]{1,101}$/.test(value) ? value : fallback;
}
function failureCode(candidates, fallback) {
  if (candidates.includes(POLICY_DENIED)) return POLICY_DENIED;
  return candidates.map(value => safeCode(value, null)).find(Boolean) || fallback;
}
function authorizationFailure(code, fallbackMessage, extra) {
  fail(code === POLICY_DENIED ? POLICY_MESSAGE : fallbackMessage, code, extra);
}
async function request(url, init = {}, signal) {
  checkAbort(signal);
  const bounded = AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(20000)]);
  try {
    const response = await fetch(url, { ...init, redirect: 'error', signal: bounded });
    checkAbort(signal);
    if (!response.ok) {
      let body;
      try { body = await response.json(); } catch { /* No raw body is logged or displayed. */ }
      const code = failureCode([body?.error_code, body?.error?.error_code, body?.error?.code, body?.error], 'HTTP_ERROR');
      authorizationFailure(code, `ChatGPT authorization request failed (${response.status}). Please try signing in again.`, { status: response.status });
    }
    return response;
  } catch (error) {
    if (signal?.aborted) throw abortError();
    if (error instanceof AuthError) throw error;
    fail('Could not reach OpenAI authorization. Check the network and try again.', 'NETWORK_ERROR');
  }
}
async function jsonRequest(url, init, signal) {
  const response = await request(url, init, signal);
  try { return await response.json(); } catch { checkAbort(signal); fail('OpenAI returned an invalid authorization response.', 'INVALID_RESPONSE'); }
}
async function discovery(signal) {
  if (discoveryCache && discoveryCache.expires > Date.now()) return discoveryCache.value;
  const value = await jsonRequest(DISCOVERY, { headers: { Accept: 'application/json' } }, signal);
  if (value?.issuer !== ISSUER) fail('OpenAI identity issuer did not match.', 'INVALID_DISCOVERY');
  const result = { issuer: ISSUER };
  for (const field of ['authorization_endpoint', 'token_endpoint', 'jwks_uri', 'revocation_endpoint']) result[field] = trustedEndpoint(value[field]);
  if (!Array.isArray(value.id_token_signing_alg_values_supported) || !value.id_token_signing_alg_values_supported.includes('RS256')) fail('OpenAI identity signing algorithm is not supported.', 'INVALID_DISCOVERY');
  discoveryCache = { value: result, expires: Date.now() + 600000 };
  return result;
}
async function loadKeys(metadata, signal, force = false) {
  if (!force && jwksCache && jwksCache.expires > Date.now() && jwksCache.url === metadata.jwks_uri) return jwksCache.keys;
  const data = await jsonRequest(metadata.jwks_uri, { headers: { Accept: 'application/json' } }, signal);
  if (!Array.isArray(data?.keys) || data.keys.length === 0) fail('OpenAI signing keys were not available.', 'INVALID_ID_TOKEN');
  const { createLocalJWKSet } = await import('jose');
  const keys = createLocalJWKSet(data);
  jwksCache = { keys, url: metadata.jwks_uri, expires: Date.now() + 600000 };
  return keys;
}
async function verifyIdentity(token, clientId, metadata, { nonce, subject, signal } = {}) {
  if (!validString(token)) fail('OpenAI did not return an identity token.', 'INVALID_ID_TOKEN');
  const { jwtVerify } = await import('jose');
  let payload;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const keys = await loadKeys(metadata, signal, attempt === 1);
      ({ payload } = await jwtVerify(token, keys, { issuer: ISSUER, audience: clientId, algorithms: ['RS256'], requiredClaims: ['sub', 'exp', 'iat'], clockTolerance: 5 }));
      break;
    } catch (error) {
      if (signal?.aborted) throw abortError();
      if (attempt === 0 && error?.code === 'ERR_JWKS_NO_MATCHING_KEY') continue;
      fail('The ChatGPT identity token could not be verified. Sign in again.', 'INVALID_ID_TOKEN');
    }
  }
  if (!validString(payload.sub) || typeof payload.iat !== 'number' || payload.iat > Date.now() / 1000 + 5) fail('ChatGPT returned invalid identity claims.', 'INVALID_ID_TOKEN');
  if ((nonce !== undefined && !sameSecret(payload.nonce, nonce)) || (subject !== undefined && payload.sub !== subject)) fail('ChatGPT identity did not match this sign-in attempt.', 'IDENTITY_MISMATCH');
  if ((payload.azp !== undefined && payload.azp !== clientId) || (Array.isArray(payload.aud) && payload.aud.length > 1 && payload.azp !== clientId)) fail('ChatGPT identity audience did not match.', 'INVALID_ID_TOKEN');
  return payload;
}
function tokenProfile(tokens, identity, { clientId, hostId, previous } = {}) {
  const scopes = typeof tokens.scope === 'string' ? [...new Set(tokens.scope.split(/\s+/).filter(Boolean))] : previous?.scopes || [];
  const permission = scopes.includes(PLAN_SCOPE) && scopes.includes('resource.invoke');
  const hasAccess = validString(tokens?.access_token);
  if ((permission && !hasAccess) || (hasAccess && (tokens.token_type?.toLowerCase() !== 'bearer' || !Number.isFinite(tokens.expires_in) || tokens.expires_in <= 0))) fail('OpenAI returned incomplete authorization credentials.', 'INVALID_TOKEN_RESPONSE');
  if (scopes.includes('offline_access') && !validString(tokens.refresh_token)) fail('OpenAI did not return the replacement refresh token.', 'INVALID_TOKEN_RESPONSE');
  const email = typeof identity.email === 'string' ? identity.email : previous?.email || null;
  const name = typeof identity.name === 'string' ? identity.name : previous?.name || null;
  return {
    issuer: ISSUER, subject: identity.sub, client_id: clientId, ext_agent_host_id: hostId,
    email, name, accountLabel: `${email || name || 'ChatGPT account'} · ${clientId.slice(-8)}`,
    access_token: tokens.access_token || null, refresh_token: tokens.refresh_token || null,
    id_token: tokens.id_token || previous?.id_token || null, token_type: 'Bearer',
    scopes, can_call_api: permission && hasAccess,
    expires_at: hasAccess ? Date.now() + tokens.expires_in * 1000 : null,
    earliest_refresh_at: tokens.earliest_refresh_at ?? null,
    saved_at: new Date().toISOString(),
  };
}
function assertProfile(profile) {
  if (!profile || profile.issuer !== ISSUER || !validClient(profile.client_id) || !validString(profile.subject)) fail('Select a saved ChatGPT account or sign in again.', 'INVALID_PROFILE');
}
function formRequest(body) {
  return { method: 'POST', headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(body).toString() };
}

/**
 * Parent must generate/persist hostId once (urn:uuid:<UUIDv4>) BEFORE calling.
 * profile is optional and selects an existing registration for reauthorization.
 * persist(profile), when provided, must atomically protect the entire token set.
 * expires_at is epoch milliseconds. No token or authorization URL is logged.
 */
async function beginSignIn({ openBrowser, signal, hostId, profile, onStatus = () => {}, persist, timeoutMs = 120000 } = {}) {
  checkAbort(signal);
  if (typeof openBrowser !== 'function' || !/^urn:uuid:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(hostId || '')) fail('A persisted host UUID and system browser callback are required.', 'INVALID_INPUT');
  if (profile) assertProfile(profile);
  if (profile && profile.ext_agent_host_id !== hostId) fail('Saved account belongs to another host registration.', 'INVALID_PROFILE');
  if (signInActive) fail('A ChatGPT sign-in is already in progress.', 'SIGN_IN_ACTIVE');
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1 || timeoutMs > 120000) fail('Invalid sign-in timeout.', 'INVALID_INPUT');
  signInActive = true;
  const controller = new AbortController();
  const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
  let server;
  let stopWaiting;
  try {
    const metadata = await discovery(combined);
    const state = randomValue(), nonce = randomValue(), verifier = randomValue();
    const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
    let resolveCallback, rejectCallback, consumed = false, redirectUri;
    const callback = new Promise((resolve, reject) => { resolveCallback = resolve; rejectCallback = reject; });
    callback.catch(() => {});
    stopWaiting = () => rejectCallback(abortError());
    combined.addEventListener('abort', stopWaiting, { once: true });
    server = http.createServer((req, res) => {
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'");
      let url;
      try { url = new URL(req.url, redirectUri); } catch { res.writeHead(400).end('Invalid callback.'); return; }
      if (req.method !== 'GET' || url.origin !== new URL(redirectUri).origin || req.headers.host !== new URL(redirectUri).host || url.pathname !== '/auth/callback') { res.writeHead(404).end('Not found.'); return; }
      if (consumed) { res.writeHead(409).end('This sign-in response was already used.'); return; }
      consumed = true;
      try {
        if (url.searchParams.getAll('state').length !== 1 || !sameSecret(url.searchParams.get('state'), state)) fail('ChatGPT sign-in state did not match. Try again.', 'STATE_MISMATCH');
        for (const key of ['code', 'client_id', 'error', 'error_code']) if (url.searchParams.getAll(key).length > 1) fail('ChatGPT returned an ambiguous callback.', 'INVALID_CALLBACK');
        if (url.searchParams.has('error') || url.searchParams.has('error_code')) {
          const code = failureCode([url.searchParams.get('error_code'), url.searchParams.get('error')], 'AUTHORIZATION_DENIED');
          authorizationFailure(code, 'ChatGPT sign-in was not approved. You can try again.');
        }
        const code = url.searchParams.get('code');
        const suppliedClient = url.searchParams.get('client_id');
        const clientId = suppliedClient || profile?.client_id;
        if (!validString(code) || !validClient(clientId)) fail('ChatGPT registration did not return a code and issued client ID.', 'INVALID_CALLBACK');
        if (profile && clientId !== profile.client_id) fail('ChatGPT returned a different account registration.', 'CLIENT_MISMATCH');
        resolveCallback({ code, clientId });
        res.writeHead(200).end('Authentication response received. Return to prateekAi to see the connection result. You can close this tab.');
      } catch (error) {
        rejectCallback(error);
        res.writeHead(400).end(error?.code === POLICY_DENIED ? POLICY_MESSAGE : 'Sign-in could not be verified. Return to prateekAi and try again.');
      }
    });
    server.headersTimeout = 5000;
    server.requestTimeout = 5000;
    server.on('error', (error) => rejectCallback(new AuthError('Could not receive the ChatGPT callback.', 'CALLBACK_ERROR')));
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen({ host: '127.0.0.1', port: 0, exclusive: true }, () => { server.removeListener('error', reject); resolve(); });
    });
    checkAbort(combined);
    redirectUri = `http://127.0.0.1:${server.address().port}/auth/callback`;
    const authUrl = new URL(metadata.authorization_endpoint);
    authUrl.search = new URLSearchParams({
      client_id: profile?.client_id || 'dynamic_agent_client', ext_agent_host_id: hostId,
      response_type: 'code', redirect_uri: redirectUri, scope: SCOPES, resource: RESOURCE,
      state, nonce, code_challenge_method: 'S256', code_challenge: challenge,
    }).toString();
    if (!profile) authUrl.searchParams.set('agent_name_hint', 'prateekAi');
    else {
      if (profile.id_token) authUrl.searchParams.set('id_token_hint', profile.id_token);
      if (profile.email) authUrl.searchParams.set('login_hint', profile.email);
    }
    onStatus('Complete ChatGPT sign-in in your browser.');
    // Never log this URL: reauthorization can contain an id_token_hint.
    // A stalled browser launcher must not bypass cancellation or the deadline.
    await Promise.race([Promise.resolve(openBrowser(authUrl.toString())), callback.then(() => undefined)]);
    const { code, clientId } = await callback;
    checkAbort(combined);
    onStatus('Verifying ChatGPT authorization…');
    const tokens = await jsonRequest(metadata.token_endpoint, formRequest({ grant_type: 'authorization_code', client_id: clientId, code, code_verifier: verifier, redirect_uri: redirectUri, resource: RESOURCE }), combined);
    const identity = await verifyIdentity(tokens.id_token, clientId, metadata, { nonce, subject: profile?.subject, signal: combined });
    const result = tokenProfile(tokens, identity, { clientId, hostId, previous: profile });
    checkAbort(combined);
    if (persist) await persist(result);
    onStatus(result.can_call_api ? 'ChatGPT account connected.' : 'Signed in, but ChatGPT plan access was not granted.');
    return result;
  } catch (error) {
    if (timedOut) fail('ChatGPT sign-in timed out. Please try again.', 'SIGN_IN_TIMEOUT');
    if (combined.aborted) throw abortError();
    if (error instanceof AuthError) throw error;
    fail('ChatGPT sign-in could not finish. Please try again.', 'SIGN_IN_FAILED');
  } finally {
    clearTimeout(timer);
    if (stopWaiting) combined.removeEventListener('abort', stopWaiting);
    if (server) {
      server.close();
      server.closeAllConnections();
    }
    signInActive = false;
  }
}

function waitForRefresh(operation, signal) {
  checkAbort(signal);
  if (!signal) return operation;
  return new Promise((resolve, reject) => {
    const abort = () => reject(abortError());
    signal.addEventListener('abort', abort, { once: true });
    operation.then(
      (result) => { signal.removeEventListener('abort', abort); signal.aborted ? reject(abortError()) : resolve(result); },
      (error) => { signal.removeEventListener('abort', abort); reject(signal.aborted ? abortError() : error); },
    );
  });
}

async function refreshProfile(profile, { signal, persist } = {}) {
  checkAbort(signal);
  assertProfile(profile);
  if (!validString(profile.refresh_token)) fail('This ChatGPT account needs a new sign-in.', 'SIGN_IN_REQUIRED');
  const key = `${profile.issuer}|${profile.client_id}|${profile.subject}`;
  while (true) {
    checkAbort(signal);
    let operation = refreshing.get(key);
    if (!operation) {
      operation = (async () => {
        // Discovery is safe to cancel: it has not consumed a rotating token.
        let metadata;
        try {
          metadata = await discovery(signal);
          checkAbort(signal);
        } catch (error) {
          if (error?.name === 'AbortError') error.refreshNotSent = true;
          throw error;
        }
        // Once the POST starts, finish verification/storage independently of an
        // answer's cancellation. Otherwise a rotated token could be discarded.
        // request() still applies its own bounded network timeout.
        const tokens = await jsonRequest(metadata.token_endpoint, formRequest({ grant_type: 'refresh_token', client_id: profile.client_id, refresh_token: profile.refresh_token, resource: RESOURCE }));
        const identity = tokens.id_token ? await verifyIdentity(tokens.id_token, profile.client_id, metadata, { subject: profile.subject }) : { sub: profile.subject, email: profile.email, name: profile.name };
        const result = tokenProfile(tokens, identity, { clientId: profile.client_id, hostId: profile.ext_agent_host_id, previous: profile });
        if (persist) await persist(result);
        return result;
      })();
      refreshing.set(key, operation);
      const release = () => { if (refreshing.get(key) === operation) refreshing.delete(key); };
      // The operation owns the lock, rather than whichever caller cancels first.
      operation.then(release, release);
    }
    try {
      return await waitForRefresh(operation, signal);
    } catch (error) {
      checkAbort(signal);
      if (error?.name !== 'AbortError' || error.refreshNotSent !== true) throw error;
      // Another caller's pre-exchange cancellation is not this caller's failure.
      // The prior operation is settled; compare identity before releasing it so
      // a newer retry can never be removed by an older waiter.
      if (refreshing.get(key) === operation) refreshing.delete(key);
    }
  }
}

async function listModels(profile, { signal } = {}) {
  assertProfile(profile);
  if (!profile.can_call_api || !profile.scopes?.includes(PLAN_SCOPE) || !validString(profile.access_token)) fail('ChatGPT plan usage has not been granted for this account.', 'PLAN_ACCESS_REQUIRED');
  const result = await jsonRequest(`${RESOURCE}/models`, { headers: { Authorization: `Bearer ${profile.access_token}`, Accept: 'application/json' } }, signal);
  if (!Array.isArray(result?.models)) fail('ChatGPT did not return an account model catalog.', 'INVALID_MODELS_RESPONSE');
  return result.models.filter((model) => model.visibility === 'list' && validString(model.slug) && model.slug.length <= 200).map((model) => ({ slug: model.slug, display_name: validString(model.display_name) ? model.display_name.slice(0, 200) : model.slug }));
}

async function revokeProfile(profile, { signal } = {}) {
  assertProfile(profile);
  // If refresh was already sent, revoke the replacement token it returns.
  const pending = refreshing.get(`${profile.issuer}|${profile.client_id}|${profile.subject}`);
  if (pending) {
    try { profile = await waitForRefresh(pending, signal); }
    catch { checkAbort(signal); /* Attempt the saved session if refresh failed. */ }
  }
  if (!profile.refresh_token) return { revoked: false, reason: 'no_refresh_token' };
  const metadata = await discovery(signal);
  await request(metadata.revocation_endpoint, formRequest({ token: profile.refresh_token, token_type_hint: 'refresh_token', client_id: profile.client_id }), signal);
  return { revoked: true };
}

module.exports = { beginSignIn, refreshProfile, listModels, revokeProfile };
