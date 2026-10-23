// The simulator's Alexa side of account linking: what the Alexa app and Alexa's cloud do for a real
// Echo. It links this simulated Echo Show to a DocSaathi family with OAuth (authorization code + PKCE),
// keeps the tokens, refreshes them before they run out, and sends them with every MCP call (the
// brain's, and the screen's through /alexa/mcp). It talks to DocSaathi's OAuth endpoints over HTTP,
// like any outside client would.
import { createHash, randomBytes } from 'node:crypto';
import { Readable } from 'node:stream';
import express, { type Response, type Router } from 'express';
import { config } from './config.js';
import { db } from './db.js';
import { householdById } from './family.js';
import { householdOfAccessToken, publicBase, registerClient, SCOPE } from './oauth.js';
import type { RawBodyRequest } from './uhi/transport.js';

const DEVICE_ID = 'echo-show-simulator';
const CLIENT_ID = 'docsaathi-simulator';
const CLIENT_SECRET = randomBytes(24).toString('base64url'); // only this process knows it
const CALLBACK = '/alexa/link/callback';

/** DocSaathi is not linked to this Echo (or the link was cancelled): Alexa asks the family to link it. */
export class LinkRequiredError extends Error {
  constructor() {
    super('DocSaathi is not linked to this Alexa.');
    this.name = 'LinkRequiredError';
  }
}

/** Is this error (or what caused it) "please link first"? */
export function linkRequired(err: unknown): boolean {
  for (let e = err as { name?: string; cause?: unknown } | undefined, depth = 0; e && depth < 5; e = e.cause as typeof e, depth++) {
    if (e instanceof LinkRequiredError || e.name === 'LinkRequiredError' || e.name === 'UnauthorizedError') return true;
  }
  return false;
}

interface Link {
  household_id: string;
  access_token: string;
  refresh_token: string;
  scope: string;
  expires_at: number;
  linked_at: number;
}

function link(): Link | undefined {
  return db().prepare('SELECT * FROM alexa_links WHERE device_id = ?').get(DEVICE_ID) as unknown as Link | undefined;
}

function save(householdId: string, t: TokenAnswer, linkedAt = Date.now()): void {
  db()
    .prepare(
      `INSERT INTO alexa_links (device_id, household_id, access_token, refresh_token, scope, expires_at, linked_at) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(device_id) DO UPDATE SET household_id = excluded.household_id, access_token = excluded.access_token,
         refresh_token = excluded.refresh_token, scope = excluded.scope, expires_at = excluded.expires_at, linked_at = excluded.linked_at`,
    )
    .run(DEVICE_ID, householdId, t.access_token, t.refresh_token!, t.scope, Date.now() + t.expires_in * 1000, linkedAt);
}

function unlinkHere(): void {
  db().prepare('DELETE FROM alexa_links WHERE device_id = ?').run(DEVICE_ID);
}

/** The family this simulated Echo is linked to, if any. */
export function linkedHousehold(): string | undefined {
  return link()?.household_id;
}

/** The addresses the sign-in page may send the family back to (this computer, and any public host). */
function callbackUris(): string[] {
  return [
    ...['localhost', '127.0.0.1'].map((h) => `http://${h}:${config.port}${CALLBACK}`),
    ...config.publicHosts.map((h) => `https://${h}${CALLBACK}`),
    ...(config.publicUrl ? [`${config.publicUrl}${CALLBACK}`] : []),
  ];
}

export function registerSimulatorClient(): void {
  registerClient({ id: CLIENT_ID, name: 'Alexa', secret: CLIENT_SECRET, redirectUris: callbackUris(), grants: ['authorization_code'] });
}

// ---------------------------------------------------------------------------
// Talking to DocSaathi's token endpoint

interface TokenAnswer {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
  scope: string;
}

class TokenRefused extends Error {}

async function tokenRequest(params: Record<string, string>): Promise<TokenAnswer> {
  const res = await fetch(`${config.baseUrl}/oauth/token`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Authorization: `Basic ${Buffer.from(`${encodeURIComponent(CLIENT_ID)}:${encodeURIComponent(CLIENT_SECRET)}`).toString('base64')}`,
    },
    body: new URLSearchParams(params),
  });
  const body = (await res.json().catch(() => ({}))) as Partial<TokenAnswer> & { error?: string; error_description?: string };
  if (!res.ok || !body.access_token) throw new TokenRefused(`${body.error ?? res.status}: ${body.error_description ?? 'no token'}`);
  return body as TokenAnswer;
}

let refreshing: Promise<string> | undefined; // one refresh at a time: a refresh token works only once

/**
 * The access token for MCP calls made for this family. Refreshed a minute before it runs out (or now,
 * with `force`, after a 401). Throws LinkRequiredError when the family has not linked or the link ended.
 */
export async function accessTokenFor(householdId: string, force = false): Promise<string> {
  const current = link();
  if (!current || current.household_id !== householdId) throw new LinkRequiredError();
  if (!force && current.expires_at - Date.now() > 60_000) return current.access_token;
  refreshing ??= (async () => {
    try {
      // Like Alexa: no `resource` on a refresh.
      const fresh = await tokenRequest({ grant_type: 'refresh_token', refresh_token: current.refresh_token });
      save(current.household_id, fresh, current.linked_at);
      return fresh.access_token;
    } catch (err) {
      if (err instanceof TokenRefused) {
        console.warn(`[alexa] the DocSaathi link ended (${err.message}); the family needs to link again`);
        unlinkHere();
        throw new LinkRequiredError();
      }
      throw err;
    } finally {
      refreshing = undefined;
    }
  })();
  return refreshing;
}

// ---------------------------------------------------------------------------
// The routes: start linking, come back from the sign-in page, status, unlink, and the screen's MCP

interface Pending {
  verifier: string;
  redirectUri: string;
  resource: string;
  at: number;
}

const pending = new Map<string, Pending>();

export function linkRouter(): Router {
  const router = express.Router();

  // "Link account": what the Alexa app does. PKCE verifier + state stay here; the browser only carries the challenge.
  router.get('/alexa/link/start', (req, res) => {
    for (const [k, p] of pending) if (Date.now() - p.at > 10 * 60_000) pending.delete(k);
    const base = publicBase(req);
    const state = randomBytes(16).toString('base64url');
    const verifier = randomBytes(48).toString('base64url');
    const p: Pending = { verifier, redirectUri: `${base}${CALLBACK}`, resource: `${base}/mcp`, at: Date.now() };
    pending.set(state, p);
    const url = new URL('/oauth/authorize', base);
    url.search = new URLSearchParams({
      response_type: 'code',
      client_id: CLIENT_ID,
      redirect_uri: p.redirectUri,
      scope: `${SCOPE.tools} ${SCOPE.resources}`,
      state,
      code_challenge: createHash('sha256').update(verifier).digest('base64url'),
      code_challenge_method: 'S256',
      resource: p.resource,
    }).toString();
    res.redirect(302, url.pathname + url.search);
  });

  router.get(CALLBACK, async (req, res) => {
    const q = req.query as Record<string, unknown>;
    const p = pending.get(String(q.state ?? ''));
    pending.delete(String(q.state ?? ''));
    if (!p) return done(res, false, 'This linking page has expired. Please tap Link account again.');
    if (q.error) return done(res, false, q.error === 'access_denied' ? 'Linking was cancelled. DocSaathi is not linked.' : `Linking failed: ${String(q.error_description ?? q.error)}`);
    try {
      const t = await tokenRequest({ grant_type: 'authorization_code', code: String(q.code ?? ''), redirect_uri: p.redirectUri, code_verifier: p.verifier, resource: p.resource });
      // A real Alexa never needs to know which family it is; the simulator shows it on the page.
      const householdId = householdOfAccessToken(t.access_token);
      if (!householdId || !t.refresh_token) return done(res, false, 'DocSaathi did not give Alexa a family token.');
      save(householdId, t);
      done(res, true, `DocSaathi is linked to Alexa for the ${householdById(householdId)?.name ?? 'family'}.`);
    } catch (err) {
      console.error('[alexa] linking failed', err);
      done(res, false, 'Linking failed. Please try again.');
    }
  });

  router.get('/alexa/link/status', (_req, res) => {
    const current = link();
    const household = current ? householdById(current.household_id) : undefined;
    res.json(current && household ? { linked: true, family: household.name, since: new Date(current.linked_at).toISOString(), scopes: current.scope.split(' ') } : { linked: false });
  });

  // "Disable skill" in the Alexa app: revoke at DocSaathi (RFC 7009), then forget the tokens.
  router.post('/alexa/link/unlink', async (_req, res) => {
    const current = link();
    if (current) {
      await fetch(`${config.baseUrl}/oauth/revoke`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Authorization: `Basic ${Buffer.from(`${encodeURIComponent(CLIENT_ID)}:${encodeURIComponent(CLIENT_SECRET)}`).toString('base64')}`,
        },
        body: new URLSearchParams({ token: current.refresh_token, token_type_hint: 'refresh_token' }),
      }).catch((err) => console.warn('[alexa] revoke failed', err));
      unlinkHere();
    }
    res.json({ ok: true, linked: false });
  });

  // The Echo screen's MCP connection (it reads the screen and asks for map pictures) goes through
  // "Alexa", which adds the family's token. The browser never sees a token.
  router.all('/alexa/mcp', async (req, res) => {
    const householdId = linkedHousehold();
    let accessToken: string;
    try {
      if (!householdId) throw new LinkRequiredError();
      accessToken = await accessTokenFor(householdId);
    } catch (err) {
      if (!linkRequired(err)) console.error('[alexa] token', err);
      res.status(401).json({ error: 'not_linked', message: 'Link DocSaathi to Alexa first.' });
      return;
    }
    const headers: Record<string, string> = { Authorization: `Bearer ${accessToken}` };
    // Every MCP header passes through (mcp-session-id, mcp-protocol-version, and the 2026 revision's
    // mcp-method / mcp-name / mcp-param-*), plus the content headers.
    for (const [name, value] of Object.entries(req.headers)) {
      if (typeof value === 'string' && (name.startsWith('mcp-') || ['content-type', 'accept', 'last-event-id'].includes(name))) headers[name] = value;
    }
    const hasBody = !['GET', 'HEAD', 'DELETE'].includes(req.method);
    try {
      const upstream = await fetch(`${config.baseUrl}/mcp`, {
        method: req.method,
        headers,
        body: hasBody ? ((req as RawBodyRequest).rawBody?.toString('utf8') ?? JSON.stringify(req.body ?? {})) : undefined,
      });
      res.status(upstream.status);
      upstream.headers.forEach((value, name) => {
        if (name.startsWith('mcp-') || name === 'content-type' || name === 'cache-control') res.set(name, value);
      });
      if (!upstream.body) {
        res.end();
        return;
      }
      Readable.fromWeb(upstream.body as Parameters<typeof Readable.fromWeb>[0]).pipe(res);
    } catch (err) {
      console.error('[alexa] mcp', err);
      if (!res.headersSent) res.status(502).json({ error: 'DocSaathi did not answer.' });
    }
  });

  return router;
}

/** The small page the sign-in window ends on: it tells the Echo page and closes itself. */
function done(res: Response, ok: boolean, message: string): void {
  const esc = message.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
  res
    .status(ok ? 200 : 400)
    .set({ 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Frame-Options': 'DENY' })
    .send(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>DocSaathi</title>
<style>:root{color-scheme:light dark}body{margin:0;min-height:100vh;display:grid;place-items:center;font:18px/1.5 "Segoe UI",system-ui,sans-serif;background:Canvas;color:CanvasText;padding:16px;text-align:center}
.mark{width:64px;height:64px;border-radius:50%;display:grid;place-items:center;margin:0 auto 12px;font-size:36px;font-weight:900;color:#fff;background:${ok ? '#0f9d94' : '#b42318'}}</style></head>
<body><main><div class="mark" aria-hidden="true">${ok ? '✓' : '!'}</div><p data-linked="${ok}">${esc}</p><p><a href="/alexa">Back to the Echo</a></p></main>
<script>try{if(window.opener){window.opener.postMessage({type:'docsaathi-link',ok:${ok}},location.origin);setTimeout(function(){window.close()},${ok ? 1500 : 4000});}}catch(e){}</script>
</body></html>`);
}
