// Account linking, checked the way Alexa+ uses it (Amazon's Alexa+ MCP toolkit checklist): discovery,
// the service token (client credentials), linking with authorization code + PKCE, refresh rotation,
// unlinking, the 500 ms limit, and the simulator's own linking. Fresh in-memory database.
// Usage: npm run smoke:oauth
import { createHash, randomBytes } from 'node:crypto';

process.env.DOCSAATHI_DB = ':memory:';
process.env.BRAIN = 'demo';
process.env.PORT = process.env.SMOKE_PORT ?? '3989';
process.env.SANDBOX_PORT = process.env.SMOKE_SANDBOX_PORT ?? '3988';
// Alexa's redirect URI for the add-on (in real life: from the Alexa+ Developer Hub).
const ALEXA_REDIRECT = 'https://alexa.amazon.com/api/skill/link/TESTVENDOR';
process.env.ALEXA_REDIRECT_URIS = ALEXA_REDIRECT;

const { start } = await import('../src/server/index.js');
const { alexaClient } = await import('../src/server/oauth.js');
const { linkSimulator } = await import('./link.js');
const { Client, StreamableHTTPClientTransport } = await import('@modelcontextprotocol/client');

const base = `http://127.0.0.1:${process.env.PORT}`;
const resource = `${base}/mcp`;
const server = await start(Number(process.env.PORT));
const alexa = alexaClient();
const basic = `Basic ${Buffer.from(`${encodeURIComponent(alexa.id)}:${encodeURIComponent(alexa.secret!)}`).toString('base64')}`;

let failures = 0;
const check = (label: string, ok: boolean, detail = '') => {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  ->  ${detail}` : ''}`);
};

type Json = Record<string, any>;
const form = (params: Record<string, string>) => new URLSearchParams(params);

async function token(params: Record<string, string>, auth: 'basic' | 'post' = 'basic') {
  const body = auth === 'post' ? form({ ...params, client_id: alexa.id, client_secret: alexa.secret! }) : form(params);
  const res = await fetch(`${base}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...(auth === 'basic' ? { Authorization: basic } : {}) },
    body,
  });
  return { status: res.status, body: (await res.json()) as Json, headers: res.headers };
}

/** A raw JSON-RPC call to /mcp, the way Alexa+ sends it. */
async function rpc(method: string, params: Json, bearer?: string) {
  const res = await fetch(`${base}/mcp`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      'MCP-Protocol-Version': '2025-11-25',
      ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}),
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  const text = await res.text();
  return { status: res.status, text, headers: res.headers };
}

function pkce() {
  const verifier = randomBytes(48).toString('base64url');
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') };
}

function authorizeUrl(p: { challenge?: string; state: string; scope?: string; resource?: string; redirect?: string }) {
  const url = new URL(`${base}/oauth/authorize`);
  url.search = form({
    response_type: 'code',
    client_id: alexa.id,
    redirect_uri: p.redirect ?? ALEXA_REDIRECT,
    scope: p.scope ?? 'mcp:tools mcp:resources',
    state: p.state,
    ...(p.challenge ? { code_challenge: p.challenge, code_challenge_method: 'S256' } : {}),
    resource: p.resource ?? resource,
  }).toString();
  return url;
}

/** Open the sign-in page, then press Allow (or Cancel) with a mobile number and PIN. */
async function signIn(challenge: string, state: string, opts: { pin?: string; action?: 'allow' | 'deny' } = {}) {
  const page = await fetch(authorizeUrl({ challenge, state }), { redirect: 'manual' });
  const html = await page.text();
  const request = html.match(/name="request" value="([^"]+)"/)?.[1] ?? '';
  const res = await fetch(`${base}/oauth/authorize`, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form({ request, mobile: '+91 00000 11111', pin: opts.pin ?? '1234', action: opts.action ?? 'allow' }),
  });
  const location = res.headers.get('location');
  return { page, html, status: res.status, location: location ? new URL(location) : undefined, text: location ? '' : await res.text() };
}

async function link() {
  const { verifier, challenge } = pkce();
  const state = randomBytes(8).toString('hex');
  const s = await signIn(challenge, state);
  const code = s.location?.searchParams.get('code') ?? '';
  const t = await token({ grant_type: 'authorization_code', code, redirect_uri: ALEXA_REDIRECT, code_verifier: verifier, resource });
  return t.body;
}

async function mcpClient(bearer: string, url = resource, version?: '2026-07-28') {
  const client = new Client({ name: 'alexa-plus-check', version: '1.0.0' }, version ? { versionNegotiation: { mode: { pin: version } } } : {});
  await client.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { Authorization: `Bearer ${bearer}` } } }));
  return client;
}

try {
  console.log('\n--- Discovery (what Alexa+ reads when the add-on is deployed)');
  const prm = (await (await fetch(`${base}/.well-known/oauth-protected-resource`)).json()) as Json;
  check('protected resource metadata at the root (RFC 9728)', prm.resource === resource && prm.authorization_servers?.[0] === base, JSON.stringify(prm));
  check('  it lists the scopes Alexa asks for when linking', JSON.stringify(prm.scopes_supported) === '["mcp:tools","mcp:resources"]');
  const prmPath = (await (await fetch(`${base}/.well-known/oauth-protected-resource/mcp`)).json()) as Json;
  check('  also served at /.well-known/oauth-protected-resource/mcp', prmPath.resource === resource);
  const asm = (await (await fetch(`${base}/.well-known/oauth-authorization-server`)).json()) as Json;
  check('authorization server metadata (RFC 8414) with S256', asm.issuer === base && asm.code_challenge_methods_supported?.includes('S256'));
  check('  grants: authorization_code, refresh_token, client_credentials', ['authorization_code', 'refresh_token', 'client_credentials'].every((g) => asm.grant_types_supported?.includes(g)));
  check('  no dynamic client registration endpoint', !('registration_endpoint' in asm));

  console.log('\n--- No token');
  const none = await rpc('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'x', version: '1' } });
  check('/mcp without a token -> 401', none.status === 401, none.text);
  check('  plain 401: no WWW-Authenticate header (Amazon checklist)', none.headers.get('www-authenticate') === null);
  const junk = await rpc('tools/list', {}, 'dsat_not-a-real-token');
  check('a made-up token -> 401 invalid_token', junk.status === 401 && /invalid_token/.test(junk.text));

  console.log('\n--- Service token (client credentials, before any family links)');
  const wrong = await fetch(`${base}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Authorization: `Basic ${Buffer.from(`${alexa.id}:wrong`).toString('base64')}` },
    body: form({ grant_type: 'client_credentials', scope: 'mcp:service', resource }),
  });
  check('wrong client secret -> 401 invalid_client', wrong.status === 401 && ((await wrong.json()) as Json).error === 'invalid_client');
  const badScope = await token({ grant_type: 'client_credentials', scope: 'mcp:tools', resource });
  check('service token cannot ask for mcp:tools -> 400 invalid_scope', badScope.status === 400 && badScope.body.error === 'invalid_scope');
  const service = await token({ grant_type: 'client_credentials', scope: 'mcp:service', resource });
  check('client_credentials -> service token', service.status === 200 && service.body.scope === 'mcp:service', `expires_in ${service.body.expires_in}`);
  check('  expires_in <= 3600, no refresh token, not cached', service.body.expires_in <= 3600 && !service.body.refresh_token && service.headers.get('cache-control') === 'no-store');
  const svc = await mcpClient(service.body.access_token);
  const listed = await svc.listTools();
  check('service token: initialize + tools/list work', listed.tools.length >= 14, `${listed.tools.length} tools`);
  await svc.close();
  const svcCall = await rpc('tools/call', { name: 'family_members', arguments: {} }, service.body.access_token);
  check('service token: tools/call -> 401 (Alexa then asks the family to link)', svcCall.status === 401 && /Access token required/.test(svcCall.text));

  console.log('\n--- Linking: authorization code + PKCE');
  const strange = await fetch(authorizeUrl({ challenge: pkce().challenge, state: 's', redirect: 'https://evil.example/cb' }), { redirect: 'manual' });
  check('unknown redirect_uri -> error page, never a redirect', strange.status === 400 && !strange.headers.get('location'));
  const noPkce = await fetch(authorizeUrl({ state: 's1' }), { redirect: 'manual' });
  const noPkceTo = new URL(noPkce.headers.get('location') ?? 'http://x');
  check('no PKCE -> back to Alexa with invalid_request', noPkce.status === 302 && noPkceTo.searchParams.get('error') === 'invalid_request' && noPkceTo.searchParams.get('state') === 's1');
  const otherServer = await fetch(authorizeUrl({ challenge: pkce().challenge, state: 's2', resource: 'https://evil.example/mcp' }), { redirect: 'manual' });
  check('resource that is not DocSaathi -> invalid_target', new URL(otherServer.headers.get('location') ?? 'http://x').searchParams.get('error') === 'invalid_target');
  const tooMuch = await fetch(authorizeUrl({ challenge: pkce().challenge, state: 's3', scope: 'mcp:tools admin' }), { redirect: 'manual' });
  check('unknown scope -> invalid_scope', new URL(tooMuch.headers.get('location') ?? 'http://x').searchParams.get('error') === 'invalid_scope');

  const p1 = pkce();
  const badPin = await signIn(p1.challenge, 'st-a', { pin: '9999' });
  check('sign-in page shows what Alexa may do', badPin.page.status === 200 && /Link DocSaathi to Alexa/.test(badPin.html) && /Nothing is booked until someone says yes/.test(badPin.html));
  check('  cannot be framed (X-Frame-Options DENY, frame-ancestors none)', badPin.page.headers.get('x-frame-options') === 'DENY' && /frame-ancestors 'none'/.test(badPin.page.headers.get('content-security-policy') ?? ''));
  check('wrong PIN -> stays on the page with an error, no code', badPin.status === 401 && !badPin.location && /do not match/.test(badPin.text));
  const cancel = await signIn(pkce().challenge, 'st-b', { action: 'deny' });
  check('Cancel -> back to Alexa with access_denied and the same state', cancel.location?.searchParams.get('error') === 'access_denied' && cancel.location?.searchParams.get('state') === 'st-b');

  const p2 = pkce();
  const allowed = await signIn(p2.challenge, 'st-c');
  const code = allowed.location?.searchParams.get('code') ?? '';
  check('Allow -> back to Alexa with a code, the state and the issuer', allowed.location?.href.startsWith(ALEXA_REDIRECT) === true && Boolean(code) && allowed.location?.searchParams.get('state') === 'st-c' && allowed.location?.searchParams.get('iss') === base);

  const p3 = pkce();
  const code3 = (await signIn(p3.challenge, 'st-d')).location?.searchParams.get('code') ?? '';
  const wrongVerifier = await token({ grant_type: 'authorization_code', code: code3, redirect_uri: ALEXA_REDIRECT, code_verifier: pkce().verifier, resource });
  check('wrong PKCE verifier -> invalid_grant', wrongVerifier.status === 400 && wrongVerifier.body.error === 'invalid_grant');

  const linked = await token({ grant_type: 'authorization_code', code, redirect_uri: ALEXA_REDIRECT, code_verifier: p2.verifier, resource });
  check('code + verifier + resource -> access and refresh tokens', linked.status === 200 && Boolean(linked.body.access_token) && Boolean(linked.body.refresh_token));
  check('  Bearer, expires_in 3600, scope mcp:tools mcp:resources', linked.body.token_type === 'Bearer' && linked.body.expires_in === 3600 && linked.body.scope === 'mcp:tools mcp:resources');
  const reused = await token({ grant_type: 'authorization_code', code, redirect_uri: ALEXA_REDIRECT, code_verifier: p2.verifier, resource });
  check('the same code twice -> invalid_grant', reused.status === 400 && reused.body.error === 'invalid_grant');
  const afterReuse = await rpc('tools/list', {}, linked.body.access_token);
  check('  ...and the tokens it gave are cancelled', afterReuse.status === 401);

  console.log('\n--- A linked family');
  const fam = await link();
  const family = await mcpClient(fam.access_token);
  const tools = await family.listTools();
  check('family token: 2025-11-25 client lists tools', tools.tools.length >= 14);
  const t0 = performance.now();
  const members = (await family.callTool({ name: 'family_members', arguments: {} })) as { content: Array<{ text?: string }> };
  const ms1 = performance.now() - t0;
  check('family token: tools/call works (family_members)', /Dadi/.test(members.content[0]?.text ?? ''));
  const t1 = performance.now();
  await family.callTool({ name: 'my_appointments', arguments: {} });
  const ms2 = performance.now() - t1;
  check('  round trip under 500 ms (Amazon limit)', ms1 < 500 && ms2 < 500, `${Math.round(ms1)} ms, ${Math.round(ms2)} ms`);
  await family.close();
  const modern = await mcpClient(fam.access_token, resource, '2026-07-28');
  check('family token: 2026-07-28 client works too', (await modern.listTools()).tools.length >= 14);
  await modern.close();

  console.log('\n--- Refresh (rotation) and unlinking');
  const refreshed = await token({ grant_type: 'refresh_token', refresh_token: fam.refresh_token }, 'post');
  check('refresh without resource (like Alexa), client_secret_post -> new pair', refreshed.status === 200 && refreshed.body.refresh_token !== fam.refresh_token);
  check('  the old access token stops working', (await rpc('tools/list', {}, fam.access_token)).status === 401);
  check('  the new access token works', (await rpc('tools/list', {}, refreshed.body.access_token)).status === 200);
  const replay = await token({ grant_type: 'refresh_token', refresh_token: fam.refresh_token });
  check('an old refresh token again -> invalid_grant', replay.status === 400 && replay.body.error === 'invalid_grant');
  check('  ...and the whole link is cancelled (it may have been copied)', (await rpc('tools/list', {}, refreshed.body.access_token)).status === 401);
  const again = await link();
  const revoke = await fetch(`${base}/oauth/revoke`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Authorization: basic },
    body: form({ token: again.refresh_token, token_type_hint: 'refresh_token' }),
  });
  check('unlink: revoking the refresh token (RFC 7009) -> 200', revoke.status === 200);
  check('  the access token stops working too', (await rpc('tools/list', {}, again.access_token)).status === 401);

  console.log('\n--- The simulator links like the Alexa app');
  const before = await (await fetch(`${base}/api/assistant`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: 'bachchon ka doctor chahiye Aarav ke liye' }) })).json() as Json;
  check('not linked: Alexa asks to link DocSaathi first', before.kind === 'link-required' && /Link account/.test(before.speech));
  await linkSimulator(base);
  const status = (await (await fetch(`${base}/alexa/link/status`)).json()) as Json;
  check('Link account -> linked to the Verma family', status.linked === true && /Verma/.test(status.family));
  const after = await (await fetch(`${base}/api/assistant`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: 'bachchon ka doctor chahiye Aarav ke liye' }) })).json() as Json;
  check('linked: the brain finds doctors with the family token', after.kind === 'doctors');
  const screen = new Client({ name: 'echo-screen', version: '1.0.0' });
  await screen.connect(new StreamableHTTPClientTransport(new URL(`${base}/alexa/mcp`)));
  check("the Echo screen reaches MCP through Alexa (no token in the browser)", (await screen.readResource({ uri: 'ui://docsaathi/screen.html' })).contents.length === 1);
  await screen.close();
  const screen2026 = new Client({ name: 'echo-screen', version: '1.0.0' }, { versionNegotiation: { mode: { pin: '2026-07-28' } } });
  await screen2026.connect(new StreamableHTTPClientTransport(new URL(`${base}/alexa/mcp`)));
  check('  ...also with the 2026-07-28 revision (its mcp-* headers pass through)', (await screen2026.listTools()).tools.length >= 14);
  await screen2026.close();
  await fetch(`${base}/alexa/link/unlink`, { method: 'POST' });
  const unlinked = await (await fetch(`${base}/api/assistant`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: 'Dadi ke liye sugar wale doctor' }) })).json() as Json;
  check('unlinked: Alexa asks to link again', unlinked.kind === 'link-required');

  console.log('\n--- Too many wrong PINs');
  let last = 0;
  for (let i = 0; i < 6; i++) last = (await signIn(pkce().challenge, `lock-${i}`, { pin: '0000' })).status;
  check('after 5 wrong PINs the number is locked for 15 minutes (429)', last === 429);
} catch (err) {
  failures++;
  console.error('OAuth smoke test crashed:', err);
} finally {
  server.close();
  console.log(`\n${failures === 0 ? 'ALL PASSED' : `${failures} FAILED`}`);
  process.exit(failures === 0 ? 0 : 1);
}
