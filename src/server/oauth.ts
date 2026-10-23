// Account linking for Alexa+ (OAuth 2.1). DocSaathi is its own authorization server.
//
// - Linking: Alexa+ uses the authorization code grant with PKCE (S256). A family member signs in on
//   DocSaathi's page with the family's mobile number and PIN, and Alexa gets an access token
//   (1 hour) and a refresh token (a new one on every refresh; reusing an old one cancels the link).
// - Before linking, Alexa+ may use a service token (client credentials, scope mcp:service): it can start
//   a session and list the tools, but a tool call needs a family's token (scope mcp:tools). Without
//   one the answer is a plain 401, which is Alexa's cue to ask the person to link.
//
// It follows Amazon's Alexa+ MCP toolkit checklist: protected resource metadata (RFC 9728) and
// authorization server metadata (RFC 8414) with S256, static client registration (no DCR), the
// `resource` parameter (RFC 8707; Alexa leaves it out when refreshing), no WWW-Authenticate header on
// the 401, and expires_in 3600. Only SHA-256 hashes of codes and tokens are stored.
import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import express, { type NextFunction, type Request, type Response, type Router } from 'express';
import { buildOAuthProtectedResourceMetadata, OAuthError, OAuthErrorCode, verifyBearerToken, type AuthInfo } from '@modelcontextprotocol/server';
import { config } from './config.js';
import { db, newId } from './db.js';
import { householdById, householdByToken, membersOf, type Household } from './family.js';

export const SCOPE = { tools: 'mcp:tools', resources: 'mcp:resources', service: 'mcp:service' } as const;
/** What a family grants when linking (and what the protected resource metadata lists for Alexa to ask for). */
const FAMILY_SCOPES: string[] = [SCOPE.tools, SCOPE.resources];

const ACCESS_TTL_S = 3600; // Amazon: expires_in <= 3600
const REFRESH_TTL_MS = 90 * 86_400_000;
const CODE_TTL_MS = 5 * 60_000;
const SIGN_IN_TTL_MS = 10 * 60_000;
const MAX_PIN_TRIES = 5;
const LOCK_MS = 15 * 60_000;

// ---------------------------------------------------------------------------
// Clients (registered in advance: Alexa+ does not do dynamic client registration)

export interface OAuthClient {
  id: string;
  name: string; // shown on the sign-in page: "<name> wants to use DocSaathi"
  secret?: string; // none = a public client (PKCE is its only proof)
  redirectUris: string[];
  grants: Array<'authorization_code' | 'client_credentials'>;
}

const clients = new Map<string, OAuthClient>();

export function registerClient(client: OAuthClient): void {
  clients.set(client.id, client);
}

/** The Alexa+ add-on's client. Its secret comes from ALEXA_CLIENT_SECRET, or is made once and kept in data/. */
export function alexaClient(): OAuthClient {
  return clients.get(config.alexa.clientId)!;
}

function alexaSecret(): string {
  if (config.alexa.clientSecret) return config.alexa.clientSecret;
  if (config.dbFile === ':memory:') return token('dscs_'); // tests: a fresh one each run
  const file = resolve(config.dataDir, 'alexa-client.json');
  if (existsSync(file)) {
    const saved = JSON.parse(readFileSync(file, 'utf8')) as { client_id?: string; client_secret?: string };
    if (saved.client_id === config.alexa.clientId && saved.client_secret) return saved.client_secret;
  }
  const secret = token('dscs_');
  mkdirSync(config.dataDir, { recursive: true });
  writeFileSync(file, JSON.stringify({ client_id: config.alexa.clientId, client_secret: secret }, null, 2), { mode: 0o600 });
  return secret;
}

export function setupClients(): void {
  registerClient({
    id: config.alexa.clientId,
    name: 'Alexa',
    secret: alexaSecret(),
    redirectUris: config.alexa.redirectUris,
    grants: ['authorization_code', 'client_credentials'],
  });
  // MCP Inspector (npx @modelcontextprotocol/inspector) on this computer, for trying the sign-in by hand.
  if (!config.requireAuth) {
    registerClient({
      id: 'mcp-inspector',
      name: 'MCP Inspector',
      redirectUris: ['http://localhost:6274/oauth/callback', 'http://localhost:6274/oauth/callback/debug'],
      grants: ['authorization_code'],
    });
  }
}

// ---------------------------------------------------------------------------
// Small helpers

function token(prefix: string): string {
  return `${prefix}${randomBytes(32).toString('base64url')}`;
}

function hash(value: string): string {
  return createHash('sha256').update(value).digest('base64url');
}

/** Constant-time comparison of two strings of any length. */
function sameText(a: string, b: string): boolean {
  return timingSafeEqual(createHash('sha256').update(a).digest(), createHash('sha256').update(b).digest());
}

/** PKCE S256: BASE64URL(SHA256(code_verifier)) must equal the code_challenge sent at the start. */
export function pkceMatches(verifier: string, challenge: string): boolean {
  if (!/^[A-Za-z0-9._~-]{43,128}$/.test(verifier)) return false;
  return sameText(createHash('sha256').update(verifier).digest('base64url'), challenge);
}

export function hashPin(pin: string): string {
  const salt = randomBytes(16);
  return `scrypt$${salt.toString('base64url')}$${scryptSync(pin, salt, 32).toString('base64url')}`;
}

export function pinMatches(pin: string, stored: string | null | undefined): boolean {
  const [kind, salt, key] = (stored ?? '').split('$');
  if (kind !== 'scrypt' || !salt || !key) return false;
  return timingSafeEqual(scryptSync(pin, Buffer.from(salt, 'base64url'), 32), Buffer.from(key, 'base64url'));
}

function scopesOf(value: unknown): string[] {
  return typeof value === 'string' ? [...new Set(value.split(' ').filter(Boolean))] : [];
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value : undefined;
}

/** The last 10 digits of an Indian mobile number: "+91 00000 11111" and "0000011111" are the same. */
function mobileDigits(value: string): string {
  return value.replace(/\D/g, '').slice(-10);
}

/** The address this request reached DocSaathi at: the OAuth issuer, and "<it>/mcp" is the resource. */
export function publicBase(req: Request): string {
  if (config.publicUrl) return config.publicUrl;
  const host = req.get('host') ?? `127.0.0.1:${config.port}`;
  return config.publicHosts.includes(host.replace(/:\d+$/, '')) ? `https://${host}` : `http://${host}`;
}

/** Is this one of DocSaathi's own MCP addresses (RFC 8707 resource indicator)? */
export function isOurResource(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.pathname.replace(/\/+$/, '') !== '/mcp' || url.search || url.hash) return false;
  const origin = url.origin;
  const ours = [
    ...['localhost', '127.0.0.1', '[::1]'].map((h) => `http://${h}:${config.port}`),
    ...config.publicHosts.map((h) => `https://${h}`),
    ...(config.publicUrl ? [new URL(config.publicUrl).origin] : []),
  ];
  return ours.includes(origin);
}

/** A request from this computer (not through a tunnel or a public address). */
function isLocal(req: Request): boolean {
  return ['localhost', '127.0.0.1', '[::1]'].includes((req.get('host') ?? '').replace(/:\d+$/, ''));
}

// ---------------------------------------------------------------------------
// Families: who may link. A family signs in with a member's mobile number and the family PIN.

/** Give the family a linking PIN (kept as a scrypt hash). The demo family's comes from FAMILY_LINK_PIN. */
export function ensureLinkPin(household: Household, pin: string): void {
  const row = db().prepare('SELECT link_pin_hash FROM households WHERE id = ?').get(household.id) as { link_pin_hash: string | null } | undefined;
  if (row && pinMatches(pin, row.link_pin_hash)) return;
  db().prepare('UPDATE households SET link_pin_hash = ? WHERE id = ?').run(hashPin(pin), household.id);
}

function householdByMobile(mobile: string): Household | undefined {
  const digits = mobileDigits(mobile);
  if (digits.length !== 10) return undefined;
  const rows = db().prepare('SELECT household_id, phone FROM members WHERE phone IS NOT NULL').all() as Array<{ household_id: string; phone: string }>;
  const match = rows.find((r) => mobileDigits(r.phone) === digits);
  return match ? householdById(match.household_id) : undefined;
}

// Wrong PINs: after 5 tries the number is locked for 15 minutes (kept in memory).
const tries = new Map<string, { count: number; until: number }>();

function locked(key: string): boolean {
  const t = tries.get(key);
  return Boolean(t && t.until > Date.now());
}

function failed(key: string): void {
  const t = tries.get(key) ?? { count: 0, until: 0 };
  t.count += 1;
  if (t.count >= MAX_PIN_TRIES) {
    t.until = Date.now() + LOCK_MS;
    t.count = 0;
  }
  tries.set(key, t);
}

// ---------------------------------------------------------------------------
// Codes and tokens

interface TokenRow {
  token_hash: string;
  kind: 'access' | 'refresh';
  grant_id: string;
  client_id: string;
  household_id: string | null;
  scope: string;
  resource: string | null;
  expires_at: number;
  revoked: number;
  used: number;
}

interface TokenResponse {
  access_token: string;
  token_type: 'Bearer';
  expires_in: number;
  scope: string;
  refresh_token?: string;
}

function issue(grant: { grantId: string; clientId: string; householdId: string | null; scope: string; resource: string | null }, withRefresh: boolean): TokenResponse {
  const now = Date.now();
  const insert = db().prepare(
    'INSERT INTO oauth_tokens (token_hash, kind, grant_id, client_id, household_id, scope, resource, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
  );
  const access = token('dsat_');
  insert.run(hash(access), 'access', grant.grantId, grant.clientId, grant.householdId, grant.scope, grant.resource, now + ACCESS_TTL_S * 1000, now);
  const out: TokenResponse = { access_token: access, token_type: 'Bearer', expires_in: ACCESS_TTL_S, scope: grant.scope };
  if (withRefresh) {
    const refresh = token('dsrt_');
    insert.run(hash(refresh), 'refresh', grant.grantId, grant.clientId, grant.householdId, grant.scope, grant.resource, now + REFRESH_TTL_MS, now);
    out.refresh_token = refresh;
  }
  return out;
}

/** Cancel a link: every token of that grant stops working. */
function revokeGrant(grantId: string): void {
  db().prepare('UPDATE oauth_tokens SET revoked = 1 WHERE grant_id = ?').run(grantId);
}

function tokenRow(value: string, kind: 'access' | 'refresh'): TokenRow | undefined {
  return db().prepare('SELECT * FROM oauth_tokens WHERE token_hash = ? AND kind = ?').get(hash(value), kind) as unknown as TokenRow | undefined;
}

/** The family an access token belongs to (the simulator's Alexa side uses this to show who is linked). */
export function householdOfAccessToken(value: string): string | undefined {
  const row = tokenRow(value, 'access');
  return row && !row.revoked && row.expires_at > Date.now() ? (row.household_id ?? undefined) : undefined;
}

export const tokenVerifier = {
  async verifyAccessToken(value: string): Promise<AuthInfo> {
    const row = tokenRow(value, 'access');
    if (!row || row.revoked || row.expires_at <= Date.now()) {
      throw new OAuthError(OAuthErrorCode.InvalidToken, 'The access token is expired, revoked or unknown.');
    }
    return {
      token: value,
      clientId: row.client_id,
      scopes: row.scope.split(' '),
      expiresAt: Math.floor(row.expires_at / 1000),
      resource: row.resource ? new URL(row.resource) : undefined,
      extra: { householdId: row.household_id ?? undefined, grantId: row.grant_id },
    };
  },
};

// ---------------------------------------------------------------------------
// Guarding /mcp

function messagesOf(body: unknown): Array<{ method?: unknown }> {
  return (Array.isArray(body) ? body : [body]).filter((m): m is { method?: unknown } => typeof m === 'object' && m !== null);
}

/**
 * Who is calling /mcp. A family's access token can do everything its scopes allow; a service token can
 * start a session and list tools and the screen, but a tool call gets 401 (Alexa then asks to link).
 * On this computer only, the demo family's fixed token still works (tests, MCP Inspector), unless
 * REQUIRE_AUTH=true.
 */
export function mcpAuth(demoToken: string) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const header = req.get('authorization');
    const bearer = header?.match(/^Bearer\s+(.+)$/i)?.[1]?.trim();
    if (bearer && bearer === demoToken && !config.requireAuth && isLocal(req)) {
      const household = householdByToken(demoToken)!;
      req.auth = { token: bearer, clientId: 'demo-token', scopes: [...FAMILY_SCOPES], extra: { householdId: household.id } };
      next();
      return;
    }
    if (!bearer) {
      // Amazon's checklist: a plain 401 (no WWW-Authenticate header). MCP clients find the metadata at
      // /.well-known/oauth-protected-resource by themselves.
      res.status(401).json({ error: 'unauthorized', message: 'Access token required to use this tool.' });
      return;
    }
    let info: AuthInfo;
    try {
      info = await verifyBearerToken(header, { verifier: tokenVerifier });
    } catch (err) {
      const description = err instanceof Error ? err.message : 'The access token is not valid.';
      res.status(401).json({ error: 'invalid_token', error_description: description, message: 'Access token required to use this tool.' });
      return;
    }
    const methods = messagesOf(req.body).map((m) => m.method);
    const family = typeof info.extra?.householdId === 'string';
    if (methods.includes('tools/call') && !(family && info.scopes.includes(SCOPE.tools))) {
      res.status(401).json({ error: 'unauthorized', message: 'Access token required to use this tool. Link DocSaathi to Alexa first.' });
      return;
    }
    if (methods.includes('resources/read') && !info.scopes.some((s) => s === SCOPE.resources || s === SCOPE.service)) {
      res.status(403).json({ error: 'insufficient_scope', message: 'This token cannot read DocSaathi screens.' });
      return;
    }
    req.auth = info;
    next();
  };
}

// ---------------------------------------------------------------------------
// The endpoints

function oauthError(res: Response, status: number, error: string, description: string): void {
  res.status(status).set('Cache-Control', 'no-store').json({ error, error_description: description });
}

/** Back to the app (Alexa) with the answer, as query parameters on its redirect URI. */
function sendBack(res: Response, redirectUri: string, params: Record<string, string | undefined>): void {
  const url = new URL(redirectUri);
  for (const [k, v] of Object.entries(params)) if (v !== undefined) url.searchParams.set(k, v);
  res.redirect(302, url.toString());
}

/** Client authentication at the token and revocation endpoints: HTTP Basic or the form body. */
function authenticateClient(req: Request, body: Record<string, unknown>): OAuthClient | { error: string; basic: boolean } {
  let id = text(body.client_id);
  let secret = text(body.client_secret);
  const basic = req.get('authorization')?.match(/^Basic\s+(.+)$/i)?.[1];
  if (basic) {
    const decoded = Buffer.from(basic, 'base64').toString('utf8');
    const colon = decoded.indexOf(':');
    try {
      if (colon < 0) throw new Error('no colon');
      id = decodeURIComponent(decoded.slice(0, colon));
      secret = decodeURIComponent(decoded.slice(colon + 1));
    } catch {
      return { error: 'The client credentials are not readable.', basic: true };
    }
  }
  const client = id ? clients.get(id) : undefined;
  if (!client) return { error: 'Unknown client.', basic: Boolean(basic) };
  if (client.secret && !(secret && sameText(secret, client.secret))) return { error: 'Wrong client secret.', basic: Boolean(basic) };
  return client;
}

interface SignIn {
  client: OAuthClient;
  redirectUri: string;
  state?: string;
  challenge: string;
  scope: string;
  resource: string | null;
  issuer: string;
  at: number;
}

// A sign-in page that is open: the page's form carries only this id, so the request cannot be changed.
const signIns = new Map<string, SignIn>();

function forgetOld(): void {
  for (const [id, s] of signIns) if (Date.now() - s.at > SIGN_IN_TTL_MS) signIns.delete(id);
}

export function oauthRouter(): Router {
  const router = express.Router();
  const form = express.urlencoded({ extended: false, limit: '16kb' });

  // Browser-based MCP clients (MCP Inspector) read the metadata and use the token endpoint from another origin.
  router.use(['/.well-known', '/oauth/token', '/oauth/revoke'], (req, res, next) => {
    res.set('Access-Control-Allow-Origin', '*');
    res.set('Access-Control-Allow-Headers', 'Authorization, Content-Type, MCP-Protocol-Version');
    res.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    if (req.method === 'OPTIONS') {
      res.status(204).end();
      return;
    }
    next();
  });

  // RFC 8414: how to sign in, get tokens and revoke them.
  router.get('/.well-known/oauth-authorization-server', (req, res) => {
    res.json(serverMetadata(publicBase(req)));
  });

  // RFC 9728: who protects /mcp and which scopes to ask for. Served at the root (Alexa+) and with the path.
  router.get(['/.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource/mcp'], (req, res) => {
    const base = publicBase(req);
    res.json(
      buildOAuthProtectedResourceMetadata({
        oauthMetadata: serverMetadata(base) as Parameters<typeof buildOAuthProtectedResourceMetadata>[0]['oauthMetadata'],
        resourceServerUrl: new URL(`${base}/mcp`),
        scopesSupported: FAMILY_SCOPES,
        resourceName: 'DocSaathi',
        serviceDocumentationUrl: new URL(`${base}/alexa`),
        dangerouslyAllowInsecureIssuerUrl: base.startsWith('http://'),
      }),
    );
  });

  // The start of linking: check the request, then show the family the sign-in page.
  router.get('/oauth/authorize', (req, res) => {
    const q = req.query as Record<string, unknown>;
    const client = clients.get(text(q.client_id) ?? '');
    if (!client || !client.grants.includes('authorization_code')) {
      page(res, 400, errorPage('This app is not registered with DocSaathi, so it cannot be linked.'));
      return;
    }
    const redirectUri = text(q.redirect_uri) ?? (client.redirectUris.length === 1 ? client.redirectUris[0] : '');
    if (!client.redirectUris.includes(redirectUri)) {
      // Never send anyone to an address we do not know.
      page(res, 400, errorPage("This app's return address is not registered with DocSaathi, so it cannot be linked."));
      return;
    }
    const issuer = publicBase(req);
    const state = text(q.state);
    const fail = (error: string, description: string) => sendBack(res, redirectUri, { error, error_description: description, state, iss: issuer });
    if (q.response_type !== 'code') return fail('unsupported_response_type', 'Only response_type=code is supported.');
    const challenge = text(q.code_challenge);
    if (!challenge || q.code_challenge_method !== 'S256' || !/^[A-Za-z0-9_-]{43}$/.test(challenge)) {
      return fail('invalid_request', 'PKCE is required: send code_challenge with code_challenge_method=S256.');
    }
    const asked = scopesOf(q.scope);
    if (asked.some((s) => !FAMILY_SCOPES.includes(s))) return fail('invalid_scope', `Scopes a family can grant: ${FAMILY_SCOPES.join(' ')}.`);
    const resource = text(q.resource);
    if (resource && !isOurResource(resource)) return fail('invalid_target', 'The resource is not this DocSaathi MCP server.');
    forgetOld();
    const id = randomBytes(18).toString('base64url');
    signIns.set(id, {
      client,
      redirectUri,
      state,
      challenge,
      scope: (asked.length ? asked : FAMILY_SCOPES).join(' '),
      resource: resource ?? null,
      issuer,
      at: Date.now(),
    });
    page(res, 200, signInPage(signIns.get(id)!, id));
  });

  // The family pressed Allow (with the mobile number and PIN) or Cancel.
  router.post('/oauth/authorize', form, (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const id = text(body.request) ?? '';
    const s = signIns.get(id);
    if (!s || Date.now() - s.at > SIGN_IN_TTL_MS) {
      page(res, 400, errorPage('This sign-in page has expired. Please start linking again from Alexa.'));
      return;
    }
    if (body.action !== 'allow') {
      signIns.delete(id);
      sendBack(res, s.redirectUri, { error: 'access_denied', error_description: 'The family did not allow linking.', state: s.state, iss: s.issuer });
      return;
    }
    const mobile = text(body.mobile) ?? '';
    const pin = text(body.pin) ?? '';
    const household = householdByMobile(mobile);
    const key = household ? `hh:${household.id}` : `m:${mobileDigits(mobile)}`;
    if (locked(key)) {
      page(res, 429, signInPage(s, id, 'Too many wrong tries. Please wait 15 minutes and try again.', mobile));
      return;
    }
    const row = household ? (db().prepare('SELECT link_pin_hash FROM households WHERE id = ?').get(household.id) as { link_pin_hash: string | null }) : undefined;
    if (!household || !/^\d{4,6}$/.test(pin) || !pinMatches(pin, row?.link_pin_hash)) {
      failed(key);
      // The same message either way, so the page does not tell anyone which numbers are registered.
      page(res, 401, signInPage(s, id, 'That mobile number and PIN do not match a DocSaathi family. Please check and try again.', mobile));
      return;
    }
    tries.delete(key);
    signIns.delete(id);
    const code = token('dsac_');
    db()
      .prepare(
        'INSERT INTO oauth_codes (code_hash, grant_id, client_id, household_id, redirect_uri, code_challenge, scope, resource, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .run(hash(code), newId('grant'), s.client.id, household.id, s.redirectUri, s.challenge, s.scope, s.resource, Date.now() + CODE_TTL_MS);
    sendBack(res, s.redirectUri, { code, state: s.state, iss: s.issuer });
  });

  router.post('/oauth/token', form, (req, res) => {
    res.set('Cache-Control', 'no-store').set('Pragma', 'no-cache');
    const body = (req.body ?? {}) as Record<string, unknown>;
    const client = authenticateClient(req, body);
    if ('error' in client) {
      if (client.basic) res.set('WWW-Authenticate', 'Basic realm="docsaathi"');
      oauthError(res, 401, 'invalid_client', client.error);
      return;
    }
    const resource = text(body.resource);
    if (resource && !isOurResource(resource)) return oauthError(res, 400, 'invalid_target', 'The resource is not this DocSaathi MCP server.');

    switch (body.grant_type) {
      case 'authorization_code': {
        const code = text(body.code);
        const verifier = text(body.code_verifier);
        if (!code || !verifier) return oauthError(res, 400, 'invalid_request', 'code and code_verifier are required.');
        const row = db().prepare('SELECT * FROM oauth_codes WHERE code_hash = ?').get(hash(code)) as
          | { grant_id: string; client_id: string; household_id: string; redirect_uri: string; code_challenge: string; scope: string; resource: string | null; expires_at: number; used: number }
          | undefined;
        if (!row || row.client_id !== client.id) return oauthError(res, 400, 'invalid_grant', 'Unknown code.');
        const claimed = db().prepare('UPDATE oauth_codes SET used = 1 WHERE code_hash = ? AND used = 0').run(hash(code)).changes === 1;
        if (!claimed) {
          revokeGrant(row.grant_id); // a code used twice may have been stolen: cancel what it gave
          return oauthError(res, 400, 'invalid_grant', 'This code was already used.');
        }
        if (row.expires_at <= Date.now()) return oauthError(res, 400, 'invalid_grant', 'This code has expired.');
        const redirectUri = text(body.redirect_uri);
        if (redirectUri && redirectUri !== row.redirect_uri) return oauthError(res, 400, 'invalid_grant', 'redirect_uri does not match.');
        if (!pkceMatches(verifier, row.code_challenge)) return oauthError(res, 400, 'invalid_grant', 'The PKCE code_verifier does not match.');
        if (resource && row.resource && resource.replace(/\/+$/, '') !== row.resource.replace(/\/+$/, '')) {
          return oauthError(res, 400, 'invalid_target', 'The resource is not the one the family linked.');
        }
        res.json(issue({ grantId: row.grant_id, clientId: client.id, householdId: row.household_id, scope: row.scope, resource: row.resource ?? resource ?? null }, true));
        return;
      }
      case 'refresh_token': {
        const value = text(body.refresh_token);
        if (!value) return oauthError(res, 400, 'invalid_request', 'refresh_token is required.');
        const row = tokenRow(value, 'refresh');
        if (!row || row.client_id !== client.id || row.revoked || row.expires_at <= Date.now()) {
          return oauthError(res, 400, 'invalid_grant', 'The refresh token is expired, revoked or unknown.');
        }
        const claimed = db().prepare('UPDATE oauth_tokens SET used = 1 WHERE token_hash = ? AND used = 0').run(row.token_hash).changes === 1;
        if (!claimed) {
          revokeGrant(row.grant_id); // an old refresh token came back: someone may have copied it
          return oauthError(res, 400, 'invalid_grant', 'This refresh token was already used, so the link was cancelled for safety.');
        }
        db().prepare("UPDATE oauth_tokens SET revoked = 1 WHERE grant_id = ? AND kind = 'access'").run(row.grant_id);
        const asked = scopesOf(body.scope);
        const had = row.scope.split(' ');
        if (asked.some((s) => !had.includes(s))) return oauthError(res, 400, 'invalid_scope', 'A refresh cannot add scopes.');
        res.json(issue({ grantId: row.grant_id, clientId: client.id, householdId: row.household_id, scope: (asked.length ? asked : had).join(' '), resource: row.resource }, true));
        return;
      }
      case 'client_credentials': {
        if (!client.secret || !client.grants.includes('client_credentials')) {
          return oauthError(res, 400, 'unauthorized_client', 'This client may not use client credentials.');
        }
        const asked = scopesOf(body.scope);
        if (asked.some((s) => s !== SCOPE.service)) return oauthError(res, 400, 'invalid_scope', `A service token can only have ${SCOPE.service}.`);
        // No refresh token and no family: it can list the tools, not use them.
        res.json(issue({ grantId: newId('grant'), clientId: client.id, householdId: null, scope: SCOPE.service, resource: resource ?? null }, false));
        return;
      }
      default:
        return oauthError(res, 400, 'unsupported_grant_type', 'Supported: authorization_code, refresh_token, client_credentials.');
    }
  });

  // RFC 7009: unlinking. Revoking a refresh token cancels the whole link.
  router.post('/oauth/revoke', form, (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const client = authenticateClient(req, body);
    if ('error' in client) return oauthError(res, 401, 'invalid_client', client.error);
    const value = text(body.token);
    const row = value ? (tokenRow(value, 'refresh') ?? tokenRow(value, 'access')) : undefined;
    if (row && row.client_id === client.id) {
      if (row.kind === 'refresh') revokeGrant(row.grant_id);
      else db().prepare('UPDATE oauth_tokens SET revoked = 1 WHERE token_hash = ?').run(row.token_hash);
    }
    res.status(200).json({}); // the same answer for unknown tokens (RFC 7009)
  });

  return router;
}

function serverMetadata(base: string) {
  const methods = ['client_secret_basic', 'client_secret_post', 'none'];
  return {
    issuer: base,
    authorization_endpoint: `${base}/oauth/authorize`,
    token_endpoint: `${base}/oauth/token`,
    revocation_endpoint: `${base}/oauth/revoke`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token', 'client_credentials'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: methods,
    revocation_endpoint_auth_methods_supported: methods,
    scopes_supported: [SCOPE.tools, SCOPE.resources, SCOPE.service],
    authorization_response_iss_parameter_supported: true,
    service_documentation: `${base}/alexa`,
  };
}

// ---------------------------------------------------------------------------
// The sign-in page (what opens in the Alexa app when the family links DocSaathi)

const WHAT_ALEXA_CAN: Record<string, [string, string]> = {
  [SCOPE.tools]: [
    'Find doctors near your home, and book, move or cancel appointments for your family. Nothing is booked until someone says yes.',
    'घर के पास डॉक्टर ढूँढना और परिवार के लिए अपॉइंटमेंट बुक करना, बदलना या रद्द करना। आपके "हाँ" कहे बिना कुछ बुक नहीं होगा।',
  ],
  [SCOPE.resources]: ['Show doctor cards and your bookings on the Echo Show screen.', 'Echo Show की स्क्रीन पर डॉक्टर और आपकी बुकिंग दिखाना।'],
};

function esc(value: string): string {
  return value.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

function page(res: Response, status: number, html: string): void {
  res
    .status(status)
    .set({
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Frame-Options': 'DENY', // no clickjacking: the page cannot be shown inside another site
      'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data:; frame-ancestors 'none'; base-uri 'none'",
      'Referrer-Policy': 'same-origin', // (no-referrer would make the form's Origin "null", which the Origin check refuses)
    })
    .send(html);
}

function shell(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<style>
  :root { --bg: #f3f7f8; --card: #ffffff; --fg: #10232a; --muted: #55707a; --line: #d5e3e7; --accent: #0f9d94; --accent-ink: #ffffff; --field: #ffffff; --bad: #b42318; --bad-bg: #fdecea; --hint: #eef8f7; color-scheme: light; }
  @media (prefers-color-scheme: dark) {
    :root { --bg: #081014; --card: #10212a; --fg: #eaf4f6; --muted: #93aeb7; --line: #22404b; --accent: #3fc6bd; --accent-ink: #052320; --field: #0b1a20; --bad: #ffb4ab; --bad-bg: #3a1513; --hint: #0f2a2c; color-scheme: dark; }
  }
  * { box-sizing: border-box; }
  body { margin: 0; min-height: 100vh; background: var(--bg); color: var(--fg); font: 16px/1.5 "Segoe UI", system-ui, -apple-system, "Noto Sans", "Noto Sans Devanagari", sans-serif; display: grid; place-items: start center; padding: 24px 16px; }
  main { width: 100%; max-width: 440px; background: var(--card); border: 1px solid var(--line); border-radius: 20px; padding: 24px; }
  .brand { display: flex; align-items: center; gap: 12px; margin-bottom: 16px; }
  .logo { width: 44px; height: 44px; border-radius: 12px; background: var(--accent); color: var(--accent-ink); display: grid; place-items: center; font-weight: 900; font-size: 28px; }
  .brand b { display: block; font-size: 18px; }
  .brand span { color: var(--muted); font-size: 13px; }
  h1 { font-size: 22px; line-height: 1.25; margin: 4px 0 2px; }
  .hi { color: var(--muted); margin: 0 0 16px; }
  ul { padding-left: 20px; margin: 8px 0 16px; }
  li { margin-bottom: 8px; }
  li small { display: block; color: var(--muted); }
  .not { font-size: 14px; color: var(--muted); border-top: 1px solid var(--line); padding-top: 12px; }
  label { display: block; font-weight: 600; margin: 14px 0 6px; }
  input { width: 100%; font: inherit; font-size: 18px; padding: 12px 14px; border-radius: 12px; border: 1px solid var(--line); background: var(--field); color: var(--fg); }
  input:focus-visible, button:focus-visible { outline: 3px solid var(--accent); outline-offset: 2px; }
  .row { display: flex; gap: 12px; margin-top: 20px; }
  button { font: inherit; font-weight: 700; border-radius: 999px; padding: 12px 20px; cursor: pointer; border: 1px solid var(--line); background: transparent; color: var(--fg); flex: 1; }
  button.go { background: var(--accent); color: var(--accent-ink); border-color: var(--accent); flex: 2; }
  .error { background: var(--bad-bg); color: var(--bad); border-radius: 12px; padding: 10px 12px; margin: 12px 0 0; }
  .hint { background: var(--hint); border-radius: 12px; padding: 10px 12px; margin-top: 16px; font-size: 14px; display: flex; gap: 8px; align-items: center; justify-content: space-between; flex-wrap: wrap; }
  .hint button { flex: 0 0 auto; padding: 6px 12px; font-size: 14px; }
  footer { color: var(--muted); font-size: 13px; margin-top: 16px; }
</style>
</head>
<body><main>
<div class="brand"><div class="logo" aria-hidden="true">+</div><div><b>DocSaathi</b><span>Doctors for the whole family</span></div></div>
${body}
</main></body>
</html>`;
}

function signInPage(s: SignIn, id: string, error?: string, mobile = ''): string {
  const can = s.scope
    .split(' ')
    .filter((sc) => WHAT_ALEXA_CAN[sc])
    .map((sc) => `<li>${esc(WHAT_ALEXA_CAN[sc][0])}<small lang="hi">${esc(WHAT_ALEXA_CAN[sc][1])}</small></li>`)
    .join('');
  const hint = config.requireAuth
    ? ''
    : `<div class="hint"><span>Test family (Verma): mobile <b>00000 11111</b>, PIN <b>${esc(config.familyLinkPin)}</b></span>
       <button type="button" id="fill">Use test family</button></div>
       <script>document.getElementById('fill').onclick=function(){document.getElementById('mobile').value='00000 11111';document.getElementById('pin').value=${JSON.stringify(config.familyLinkPin)};document.getElementById('allow').focus();};</script>`;
  return shell(
    'Link DocSaathi',
    `<h1>Link DocSaathi to ${esc(s.client.name)}</h1>
<p class="hi" lang="hi">डॉकसाथी को ${s.client.name === 'Alexa' ? 'एलेक्सा' : esc(s.client.name)} से जोड़ें</p>
<p>${esc(s.client.name)} will be able to:</p>
<ul>${can}</ul>
<p class="not">${esc(s.client.name)} will not get your PIN. DocSaathi keeps names, ages and appointments only: no medical records.</p>
<form method="post" action="/oauth/authorize" autocomplete="off">
  <input type="hidden" name="request" value="${esc(id)}">
  <label for="mobile">Family mobile number <span lang="hi">(मोबाइल नंबर)</span></label>
  <input id="mobile" name="mobile" type="tel" inputmode="tel" autocomplete="tel-national" placeholder="98765 43210" value="${esc(mobile)}" required>
  <label for="pin">Family PIN <span lang="hi">(पिन)</span></label>
  <input id="pin" name="pin" type="password" inputmode="numeric" pattern="[0-9]{4,6}" maxlength="6" placeholder="4 to 6 digits" required>
  ${error ? `<p class="error" role="alert">${esc(error)}</p>` : ''}
  <div class="row">
    <button type="submit" name="action" value="deny" formnovalidate>Cancel</button>
    <button type="submit" name="action" value="allow" class="go" id="allow">Allow</button>
  </div>
</form>
${hint}
<footer>You can unlink DocSaathi at any time in the Alexa app.</footer>`,
  );
}

function errorPage(message: string): string {
  return shell('DocSaathi', `<h1>Linking could not start</h1><p>${esc(message)}</p>`);
}
