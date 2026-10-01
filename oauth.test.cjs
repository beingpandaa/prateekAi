'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const crypto = require('node:crypto');
const { streamAnswer } = require('./providers.cjs');
const ISSUER = 'https://auth.openai.com';
const CLIENT = 'oaiapp_test_registration';
const HOST = 'urn:uuid:69fd3c17-8ef6-45c2-89bb-d4aa2f79dcf7';
const SCOPE = 'openid email profile offline_access resource.invoke chatgpt.tokens.use.direct';
const POLICY_DENIED = '3p_delegated_access_policy_denied';
const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'test-key', alg: 'RS256', use: 'sig' };
function signedJwt(claims, { key = privateKey, kid = 'test-key', alg = 'RS256' } = {}) {
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const input = `${encode({ alg, kid })}.${encode(claims)}`;
  return `${input}.${crypto.sign('RSA-SHA256', Buffer.from(input), key).toString('base64url')}`;
}
function localCallback(url) {
  assert.equal(new URL(url).hostname, '127.0.0.1');
  return new Promise((resolve, reject) => {
    http.get(url, (response) => {
      let text = '';
      response.setEncoding('utf8');
      response.on('data', (part) => { text += part; });
      response.on('end', () => resolve({ status: response.statusCode, text }));
    }).on('error', reject);
  });
}
function fixture(t, overrides = {}) {
  delete require.cache[require.resolve('./oauth.cjs')];
  const auth = require('./oauth.cjs');
  const calls = [];
  let authUrl;
  let callbackResult;
  let jwksCount = 0;
  const metadata = {
    issuer: ISSUER,
    authorization_endpoint: `${ISSUER}/api/accounts/authorize`,
    token_endpoint: `${ISSUER}/api/accounts/oauth/token`,
    revocation_endpoint: `${ISSUER}/api/accounts/oauth/revoke`,
    jwks_uri: `${ISSUER}/.well-known/jwks.json`,
    id_token_signing_alg_values_supported: ['RS256'],
    ...overrides.metadata,
  };
  t.mock.method(globalThis, 'fetch', async (url, init = {}) => {
    calls.push({ url, init });
    if (url.endsWith('/openid-configuration')) return Response.json(metadata);
    if (url.endsWith('/jwks.json')) {
      jwksCount++;
      return Response.json({ keys: [overrides.rotation && jwksCount === 1 ? { ...jwk, kid: 'old-key' } : jwk] });
    }
    if (url.endsWith('/oauth/token')) {
      if (overrides.tokenError) return Response.json(overrides.tokenError, { status: 403 });
      const form = new URLSearchParams(init.body);
      const refresh = form.get('grant_type') === 'refresh_token';
      if (!refresh) {
        assert.equal(form.get('client_id'), CLIENT);
        assert.equal(form.get('redirect_uri'), authUrl.searchParams.get('redirect_uri'));
        assert.equal(crypto.createHash('sha256').update(form.get('code_verifier')).digest('base64url'), authUrl.searchParams.get('code_challenge'));
      }
      assert.equal(form.get('resource'), 'https://api.openai.com/v1');
      assert.equal(form.has('client_secret'), false);
      const now = Math.floor(Date.now() / 1000);
      const claims = { iss: ISSUER, sub: 'subject-test', aud: CLIENT, iat: now, exp: now + 3600, nonce: authUrl?.searchParams.get('nonce') || 'refresh-nonce', email: 'test@example.test', ...overrides.claims, ...(refresh ? overrides.refreshClaims : {}) };
      const tokens = {
        access_token: refresh ? 'new-access-token' : 'access-token',
        refresh_token: refresh ? 'new-refresh-token' : 'refresh-token',
        id_token: signedJwt(claims, overrides.signing), token_type: 'Bearer', expires_in: 3600,
        scope: overrides.scope ?? SCOPE,
      };
      if (overrides.omitRefreshScope && refresh) delete tokens.scope;
      if (overrides.identityOnly) { delete tokens.access_token; delete tokens.refresh_token; delete tokens.expires_in; delete tokens.token_type; }
      return Response.json(tokens);
    }
    if (url.endsWith('/models')) return Response.json({ models: [
      { slug: 'model-a', display_name: 'Model A', visibility: 'list', private_data: 'should not return' },
      { slug: 'hidden', display_name: 'Hidden', visibility: 'hide' },
      { slug: 'model-b', visibility: 'list' },
    ] });
    if (url.endsWith('/oauth/revoke')) return new Response('', { status: 200 });
    throw new Error('Unexpected external URL in test');
  });
  const openBrowser = async (value) => {
    authUrl = new URL(value);
    assert.equal(authUrl.origin, ISSUER);
    const callback = new URL(authUrl.searchParams.get('redirect_uri'));
    assert.equal(callback.pathname, '/auth/callback');
    callback.search = new URLSearchParams({ code: 'test-code', state: authUrl.searchParams.get('state'), client_id: CLIENT, ...overrides.callback }).toString();
    if (overrides.omitCallbackClient) callback.searchParams.delete('client_id');
    callbackResult = await localCallback(callback.toString());
  };
  return { auth, calls, openBrowser, get authUrl() { return authUrl; }, get callbackResult() { return callbackResult; } };
}

test('PKCE loopback registration verifies identity and grant before persisting', async (t) => {
  const f = fixture(t);
  const stored = [];
  const profile = await f.auth.beginSignIn({ openBrowser: f.openBrowser, hostId: HOST, persist: (value) => stored.push(value) });
  assert.equal(profile.client_id, CLIENT);
  assert.equal(profile.subject, 'subject-test');
  assert.equal(profile.can_call_api, true);
  assert.equal(profile.ext_agent_host_id, HOST);
  assert.ok(profile.expires_at > Date.now());
  assert.equal(stored[0], profile);
  assert.equal(f.authUrl.searchParams.get('client_id'), 'dynamic_agent_client');
  assert.equal(f.authUrl.searchParams.get('agent_name_hint'), 'prateekAi');
  assert.equal(f.authUrl.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(f.callbackResult.status, 200);
  for (const secret of ['access-token', 'refresh-token', profile.id_token]) assert.equal(f.callbackResult.text.includes(secret), false);
});

test('identity-only grant is connected but cannot call inference or list models', async (t) => {
  const f = fixture(t, { scope: 'openid email profile', identityOnly: true });
  const profile = await f.auth.beginSignIn({ openBrowser: f.openBrowser, hostId: HOST });
  assert.equal(profile.can_call_api, false);
  await assert.rejects(f.auth.listModels(profile), (error) => error.code === 'PLAN_ACCESS_REQUIRED');
  assert.equal(f.calls.some(({ url }) => url.endsWith('/models')), false);
});

for (const [name, callback, expected] of [
  ['wrong state', { state: 'wrong' }, 'STATE_MISMATCH'],
  ['denied consent', { error: 'access_denied' }, 'access_denied'],
  ['dynamic client returned', { client_id: 'dynamic_agent_client' }, 'INVALID_CALLBACK'],
]) {
  test(`${name} never exchanges a code`, async (t) => {
    const f = fixture(t, { callback });
    await assert.rejects(f.auth.beginSignIn({ openBrowser: f.openBrowser, hostId: HOST }), (error) => error.code === expected);
    assert.equal(f.calls.some(({ url }) => url.endsWith('/oauth/token')), false);
  });
}

for (const callback of [
  { error: POLICY_DENIED },
  { error: 'access_denied', error_code: POLICY_DENIED },
]) {
  test(`organization policy callback ${Object.keys(callback).join('/')} provides recovery without token exchange`, async t => {
    const privateText = 'private browser description <script>secret</script>';
    const f = fixture(t, { callback: { ...callback, error_description: privateText } });
    let saved = false;
    await assert.rejects(f.auth.beginSignIn({ openBrowser: f.openBrowser, hostId: HOST, persist() { saved = true; } }), error => {
      assert.equal(error.code, POLICY_DENIED);
      assert.match(error.message, /administrator/);
      assert.match(error.message, /If permitted/);
      assert.match(error.message, /personal account/);
      assert.match(error.message, /separate billing/);
      assert.doesNotMatch(error.message, /try again|signing in again/i);
      assert.equal(error.message.includes(privateText), false);
      return true;
    });
    assert.equal(saved, false);
    assert.equal(f.calls.some(({ url }) => url.endsWith('/oauth/token')), false);
  });
}

test('organization policy callback still requires the matching sign-in state', async t => {
  const f = fixture(t, { callback: { state: 'wrong-state', error: 'access_denied', error_code: POLICY_DENIED } });
  await assert.rejects(f.auth.beginSignIn({ openBrowser: f.openBrowser, hostId: HOST }), error => {
    assert.equal(error.code, 'STATE_MISMATCH');
    assert.doesNotMatch(error.message, /administrator/);
    return true;
  });
  assert.equal(f.calls.some(({ url }) => url.endsWith('/oauth/token')), false);
});

for (const callback of [
  { error: '3p_unknown_policy', error_description: 'secret arbitrary description' },
  { error: 'untrusted <script>secret</script>', error_code: 'x'.repeat(102), error_description: 'secret arbitrary description' },
]) {
  test(`unknown callback error ${callback.error.startsWith('3p') ? 'machine code' : 'arbitrary text'} stays generic`, async t => {
    const f = fixture(t, { callback });
    await assert.rejects(f.auth.beginSignIn({ openBrowser: f.openBrowser, hostId: HOST }), error => {
      assert.equal(error.code, callback.error.startsWith('3p') ? '3p_unknown_policy' : 'AUTHORIZATION_DENIED');
      assert.equal(error.message, 'ChatGPT sign-in was not approved. You can try again.');
      assert.doesNotMatch(error.message, /secret|script|administrator/);
      return true;
    });
    assert.equal(f.calls.some(({ url }) => url.endsWith('/oauth/token')), false);
  });
}

for (const [name, tokenError] of [
  ['direct error', { error: POLICY_DENIED }],
  ['error code with denial', { error: 'access_denied', error_code: POLICY_DENIED }],
  ['nested error code', { error: { code: POLICY_DENIED, message: 'secret provider text' } }],
]) {
  test(`organization policy token JSON ${name} is actionable without retries or raw text`, async t => {
    const f = fixture(t, { tokenError: { ...tokenError, error_description: 'secret provider description' } });
    let saved = false;
    await assert.rejects(f.auth.beginSignIn({ openBrowser: f.openBrowser, hostId: HOST, persist() { saved = true; } }), error => {
      assert.equal(error.code, POLICY_DENIED);
      assert.equal(error.status, 403);
      assert.match(error.message, /administrator/);
      assert.doesNotMatch(error.message, /secret|try again|signing in again/i);
      return true;
    });
    assert.equal(saved, false);
    assert.equal(f.calls.filter(({ url }) => url.endsWith('/oauth/token')).length, 1);
  });
}

test('unknown token JSON error does not reflect arbitrary provider text', async t => {
  const f = fixture(t, { tokenError: { error: 'arbitrary text <script>secret</script>', error_code: 'x'.repeat(102), error_description: 'secret provider description' } });
  await assert.rejects(f.auth.beginSignIn({ openBrowser: f.openBrowser, hostId: HOST }), error => {
    assert.equal(error.code, 'HTTP_ERROR');
    assert.equal(error.message, 'ChatGPT authorization request failed (403). Please try signing in again.');
    assert.doesNotMatch(error.message, /secret|script|administrator/);
    return true;
  });
});

for (const [name, overrides] of [
  ['issuer', { claims: { iss: 'https://evil.example' } }],
  ['audience', { claims: { aud: 'other-client' } }],
  ['expiry', { claims: { exp: 1 } }],
  ['nonce', { claims: { nonce: 'wrong-nonce' } }],
  ['authorized party', { claims: { aud: [CLIENT, 'other'], azp: 'other' } }],
  ['signature', { signing: { key: crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey } }],
]) {
  test(`untrusted ID token ${name} cannot be saved`, async (t) => {
    const f = fixture(t, overrides);
    let saved = false;
    await assert.rejects(f.auth.beginSignIn({ openBrowser: f.openBrowser, hostId: HOST, persist() { saved = true; } }), (error) => ['INVALID_ID_TOKEN', 'IDENTITY_MISMATCH'].includes(error.code));
    assert.equal(saved, false);
  });
}

test('new signing key triggers a JWKS refresh', async (t) => {
  const f = fixture(t, { rotation: true });
  await f.auth.beginSignIn({ openBrowser: f.openBrowser, hostId: HOST });
  assert.equal(f.calls.filter(({ url }) => url.endsWith('/jwks.json')).length, 2);
});

test('returning account reuses client and host with a fresh nonce', async (t) => {
  const f = fixture(t, { omitCallbackClient: true });
  const profile = { issuer: ISSUER, client_id: CLIENT, subject: 'subject-test', ext_agent_host_id: HOST, id_token: 'retained-token-hint', email: 'test@example.test' };
  const result = await f.auth.beginSignIn({ openBrowser: f.openBrowser, hostId: HOST, profile });
  assert.equal(result.client_id, CLIENT);
  assert.equal(f.authUrl.searchParams.get('client_id'), CLIENT);
  assert.equal(f.authUrl.searchParams.has('agent_name_hint'), false);
  assert.equal(f.authUrl.searchParams.get('id_token_hint'), profile.id_token);
});

test('reauthorization cannot change the selected subject or client', async (t) => {
  const f = fixture(t);
  const profile = { issuer: ISSUER, client_id: CLIENT, subject: 'different-subject', ext_agent_host_id: HOST };
  await assert.rejects(f.auth.beginSignIn({ openBrowser: f.openBrowser, hostId: HOST, profile }), (error) => error.code === 'IDENTITY_MISMATCH');
});

test('refresh is serialized, retains omitted scopes, rotates credentials atomically', async (t) => {
  const f = fixture(t, { omitRefreshScope: true });
  const profile = await f.auth.beginSignIn({ openBrowser: f.openBrowser, hostId: HOST });
  const persisted = [];
  const [a, b] = await Promise.all([
    f.auth.refreshProfile(profile, { persist: (value) => persisted.push(value) }),
    f.auth.refreshProfile(profile, { persist: (value) => persisted.push(value) }),
  ]);
  assert.equal(a, b);
  assert.equal(a.access_token, 'new-access-token');
  assert.equal(a.refresh_token, 'new-refresh-token');
  assert.equal(a.can_call_api, true);
  assert.equal(persisted.length, 1);
  assert.equal(f.calls.filter(({ url }) => url.endsWith('/oauth/token')).length, 2);
  const refresh = f.calls.filter(({ url }) => url.endsWith('/oauth/token'))[1];
  assert.equal(new URLSearchParams(refresh.init.body).has('scope'), false);
});

test('healthy Ask retries a shared refresh cancelled before token exchange', async (t) => {
  const f = fixture(t);
  const baseFetch = globalThis.fetch;
  const oldController = new AbortController();
  let beganDiscovery;
  const discoveryStarted = new Promise((resolve) => { beganDiscovery = resolve; });
  let discoveryCount = 0;
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    if (url.endsWith('/openid-configuration') && ++discoveryCount === 1) {
      beganDiscovery();
      return new Promise((resolve, reject) => {
        init.signal.addEventListener('abort', () => {
          // Leave the rejected operation pending briefly so the new Ask joins it.
          setTimeout(() => reject(Object.assign(new Error('cancelled'), { name: 'AbortError' })), 5);
        }, { once: true });
      });
    }
    return baseFetch(url, init);
  });
  const profile = { issuer: ISSUER, client_id: CLIENT, subject: 'subject-test', ext_agent_host_id: HOST, refresh_token: 'refresh-token', scopes: SCOPE.split(' ') };
  const old = f.auth.refreshProfile(profile, { signal: oldController.signal });
  const oldRejected = assert.rejects(old, { name: 'AbortError' });
  await discoveryStarted;
  oldController.abort();
  const saved = [];
  const current = await f.auth.refreshProfile(profile, { persist: (value) => saved.push(value) });
  await oldRejected;
  assert.equal(current.refresh_token, 'new-refresh-token');
  assert.equal(saved.length, 1);
  assert.equal(f.calls.filter(({ url }) => url.endsWith('/oauth/token')).length, 1);
});

test('Ask cancellation during POST preserves rotation and healthy waiters share its result', async (t) => {
  const f = fixture(t);
  const profile = await f.auth.beginSignIn({ openBrowser: f.openBrowser, hostId: HOST });
  const baseFetch = globalThis.fetch;
  let releasePost, beganPost;
  const postStarted = new Promise((resolve) => { beganPost = resolve; });
  const postGate = new Promise((resolve) => { releasePost = resolve; });
  let refreshRequests = 0;
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    if (url.endsWith('/oauth/token') && new URLSearchParams(init.body).get('grant_type') === 'refresh_token') {
      refreshRequests++;
      beganPost();
      await postGate;
      assert.equal(init.signal.aborted, false);
    }
    return baseFetch(url, init);
  });
  const oldController = new AbortController();
  const saved = [];
  const old = f.auth.refreshProfile(profile, { signal: oldController.signal, persist: (value) => saved.push(value) });
  const oldRejected = assert.rejects(old, { name: 'AbortError' });
  await postStarted;
  oldController.abort();
  const current = f.auth.refreshProfile(profile, { persist: (value) => saved.push(value) });
  const revoke = f.auth.revokeProfile(profile);
  releasePost();
  const [result] = await Promise.all([current, revoke, oldRejected]);
  assert.equal(result.refresh_token, 'new-refresh-token');
  assert.equal(refreshRequests, 1);
  assert.equal(saved.length, 1);
  const revocation = f.calls.find(({ url }) => url.endsWith('/oauth/revoke'));
  assert.equal(new URLSearchParams(revocation.init.body).get('token'), 'new-refresh-token');
});

test('a caller cancelled before refresh never joins or initiates a token exchange', async (t) => {
  const f = fixture(t);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(f.auth.refreshProfile({}, { signal: controller.signal }), { name: 'AbortError' });
  assert.equal(f.calls.length, 0);
});

test('an abort-shaped storage failure after rotation never retries a consumed token', async (t) => {
  const f = fixture(t);
  const profile = await f.auth.beginSignIn({ openBrowser: f.openBrowser, hostId: HOST });
  let saveAttempts = 0;
  const persist = () => {
    saveAttempts++;
    // A closed account/session can reject storage after the server has rotated.
    // It must not be mistaken for cancellation before the refresh POST.
    throw Object.assign(new Error('Session closed'), { name: 'AbortError' });
  };
  await assert.rejects(f.auth.refreshProfile(profile, { persist }), { name: 'AbortError' });
  assert.equal(saveAttempts, 1);
  const refreshCalls = f.calls.filter(({ url, init }) => url.endsWith('/oauth/token') && new URLSearchParams(init.body).get('grant_type') === 'refresh_token');
  assert.equal(refreshCalls.length, 1);
});

test('model catalog returns only visible sanitized models in server order; revoke uses refresh token', async (t) => {
  const f = fixture(t);
  const profile = await f.auth.beginSignIn({ openBrowser: f.openBrowser, hostId: HOST });
  assert.deepEqual(await f.auth.listModels(profile), [{ slug: 'model-a', display_name: 'Model A' }, { slug: 'model-b', display_name: 'model-b' }]);
  assert.deepEqual(await f.auth.revokeProfile(profile), { revoked: true });
  const revoke = f.calls.find(({ url }) => url.endsWith('/oauth/revoke'));
  assert.equal(new URLSearchParams(revoke.init.body).get('token'), 'refresh-token');
  assert.equal(new URLSearchParams(revoke.init.body).get('client_id'), CLIENT);
});

test('discovery cannot redirect credentials to another origin', async (t) => {
  const f = fixture(t, { metadata: { token_endpoint: 'https://evil.example/token' } });
  await assert.rejects(f.auth.beginSignIn({ openBrowser: f.openBrowser, hostId: HOST }), (error) => error.code === 'INVALID_DISCOVERY');
  assert.equal(f.calls.length, 1);
});

test('browser wait has bounded timeout, including a stalled launcher', async (t) => {
  const f = fixture(t);
  await assert.rejects(f.auth.beginSignIn({ openBrowser: () => new Promise(() => {}), hostId: HOST, timeoutMs: 30 }), (error) => error.code === 'SIGN_IN_TIMEOUT');
});

test('caller cancellation closes pending sign-in', async (t) => {
  const f = fixture(t);
  const controller = new AbortController();
  await assert.rejects(f.auth.beginSignIn({ openBrowser: () => controller.abort(), hostId: HOST, signal: controller.signal }), { name: 'AbortError' });
});

test('ChatGPT request uses OAuth bearer and omits preview-unsupported output cap', async (t) => {
  let sent;
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    sent = { url, init, body: JSON.parse(init.body) };
    return new Response('data: {"type":"response.completed","response":{"status":"completed"}}\n\n', { headers: { 'content-type': 'text/event-stream' } });
  });
  await streamAnswer({ apiKey: 'oauth-test-token', authType: 'chatgpt', model: 'account-model', question: 'Explain a mutex.' });
  assert.equal(sent.url, 'https://api.openai.com/v1/responses');
  assert.equal(sent.init.headers.Authorization, 'Bearer oauth-test-token');
  assert.equal(Object.hasOwn(sent.body, 'max_output_tokens'), false);
  assert.equal(sent.body.store, false);
  assert.equal(sent.body.stream, true);
  assert.ok(Array.isArray(sent.body.input));
});
