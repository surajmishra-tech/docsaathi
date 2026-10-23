import { config } from './config.js';
import { existsSync } from 'node:fs';
import type { Server } from 'node:http';
import { resolve } from 'node:path';
import express, { type Request } from 'express';
import { hostHeaderValidation, localhostHostValidation, originValidation } from '@modelcontextprotocol/express';
import { toNodeHandler } from '@modelcontextprotocol/node';
import { createMcpHandler } from '@modelcontextprotocol/server';
import { linkedHousehold, linkRouter, registerSimulatorClient } from './alexaLink.js';
import { rememberHospitals, takeNotices } from './booking.js';
import { announce, brainLabel, noteSpeakerChosen, resetConversation, respond } from './brain/index.js';
import { clinicDecision, deskBookings } from './uhi/testnet/hspa.js';
import { db } from './db.js';
import {
  DEMO_TOKEN,
  householdById,
  householdByToken,
  memberLabel,
  membersOf,
  resetDemoData,
  seedDemoFamily,
  setReplyLanguage,
  setSpeaker,
  speakerOf,
  type Household,
} from './family.js';
import { googleEnabled, haversineKm } from './google.js';
import { inIndia, setHome } from './location.js';
import { buildServer } from './mcp.js';
import { recordsRouter } from './records.js';
import { speech, voiceLabel, VoiceUnavailable } from './voice.js';
import { alexaClient, ensureLinkPin, mcpAuth, oauthRouter, setupClients } from './oauth.js';
import { clock, toIstIso } from './time.js';
import { euaCallbackRouter } from './uhi/eua.js';
import { ensureRegistry } from './uhi/registry.js';
import { testGatewayRouter, testRegistryRouter } from './uhi/testnet/gateway.js';
import { testHspaRouter } from './uhi/testnet/hspa.js';
import { cityOf, nameClinicAreas, seedTestNetwork } from './uhi/testnet/seed.js';
import type { RawBodyRequest } from './uhi/transport.js';

const WEB_DIR = resolve(process.cwd(), 'dist', 'web');

/**
 * The family the simulator page belongs to: the one this simulated Echo is linked to (or, before
 * linking, the demo family, so the page can still show who is talking). With REQUIRE_AUTH=true the
 * page needs the family token.
 */
function householdFor(req: Request): Household | undefined {
  const token = req.header('authorization')?.match(/^Bearer\s+(.+)$/i)?.[1]?.trim();
  if (token) return householdByToken(token);
  if (config.requireAuth) return undefined;
  const linked = linkedHousehold();
  return (linked ? householdById(linked) : undefined) ?? householdByToken(DEMO_TOKEN);
}

export function createApp() {
  const app = express();
  app.disable('x-powered-by');
  // DNS-rebinding protection (same guards the MCP Express adapter applies): only localhost, plus any
  // hostnames listed in PUBLIC_HOSTS (for example an ngrok address used to test on a phone).
  const allowedHosts = ['localhost', '127.0.0.1', '[::1]', ...config.publicHosts];
  app.use(hostHeaderValidation(allowedHosts));
  app.use(originValidation(allowedHosts));
  // Keep the raw bytes: UHI signatures are checked against the exact body.
  app.use(
    express.json({
      limit: '1mb',
      verify: (req, _res, buf) => {
        (req as RawBodyRequest).rawBody = Buffer.from(buf);
      },
    }),
  );

  // --- Account linking (OAuth 2.1): DocSaathi's sign-in and tokens, and the simulator's Alexa side
  setupClients();
  registerSimulatorClient();
  app.use(oauthRouter());
  app.use(linkRouter());

  // --- UHI: DocSaathi's callback endpoints + the local test network (registry, gateway, clinics)
  app.use('/uhi/eua', euaCallbackRouter());
  app.use('/uhi/registry', testRegistryRouter());
  app.use('/uhi/gateway', testGatewayRouter());
  app.use('/uhi/hspa', testHspaRouter());

  // --- MCP (Streamable HTTP). Serves spec 2026-07-28 and, for Alexa+ today, 2025-11-25 clients (stateless).
  // Every request needs a token (oauth.ts): a linked family's, or a service token that can only list tools.
  const mcp = createMcpHandler((ctx) => buildServer(String(ctx.authInfo?.extra?.householdId ?? '')), {
    legacy: 'stateless',
    onerror: (err) => console.error('[mcp]', err.message),
  });
  const mcpNode = toNodeHandler(mcp);
  app.all('/mcp', mcpAuth(DEMO_TOKEN), (req, res) => mcpNode(req, res, req.body));

  // --- The "Alexa" conversation used by the Echo Show simulator page
  app.post('/api/assistant', async (req, res) => {
    const household = householdFor(req);
    const text = String((req.body as { text?: unknown })?.text ?? '').trim().slice(0, 500);
    if (!household) {
      res.status(401).json({ error: 'Unknown family' });
      return;
    }
    if (!text) {
      res.status(400).json({ error: 'Say something first' });
      return;
    }
    try {
      res.json(await respond(household, text));
    } catch (err) {
      console.error('[assistant]', err);
      res.status(500).json({ error: 'The assistant had a problem. Please try again.' });
    }
  });

  // Alexa's voice (VOICE=polly): an answer as an MP3 from Amazon Polly. 503 = the page uses the browser voice.
  app.post('/api/voice/speak', async (req, res) => {
    if (!householdFor(req)) {
      res.status(401).json({ error: 'Unknown family' });
      return;
    }
    const body = req.body as { text?: unknown; lang?: unknown };
    try {
      const audio = await speech(String(body?.text ?? ''), body?.lang === 'hi' ? 'hi' : 'en');
      res.setHeader('Cache-Control', 'no-store');
      res.type('audio/mpeg').send(audio);
    } catch (err) {
      res.status(503).json({ error: err instanceof VoiceUnavailable ? err.message : 'The voice service had a problem.' });
    }
  });

  // The family's health record: doctors they saw and the medicines doctors wrote (the menu pages).
  app.use(recordsRouter(householdFor));

  // Messages the family received (the "phone" preview in the simulator).
  app.get('/api/family/messages', (req, res) => {
    const household = householdFor(req);
    if (!household) {
      res.status(401).json([]);
      return;
    }
    const rows = db()
      .prepare('SELECT to_label, body, created_at FROM family_messages WHERE household_id = ? ORDER BY created_at DESC LIMIT 10')
      .all(household.id) as Array<{ to_label: string; body: string; created_at: string }>;
    res.json(rows.map((r) => ({ to: r.to_label, body: r.body, at: r.created_at })));
  });

  app.get('/api/family', (req, res) => {
    const household = householdFor(req);
    if (!household) {
      res.status(401).json({});
      return;
    }
    res.json({
      name: household.name,
      home: household.home_address,
      homeSource: household.home_source, // 'default' = still the demo address: the page asks the browser for the real one
      replyLang: household.reply_lang, // 'en' or 'hi': the language Alexa answers in
      speaker: speakerOf(household.id)?.id ?? null, // who is talking right now (null = not known: Alexa asks)
      members: membersOf(household.id).map((m) => ({ id: m.id, name: m.name, label: memberLabel(m), age: m.age })),
    });
  });

  // Who is talking (the simulator's "Speaking:" menu). A real Echo knows this from the voice.
  app.post('/api/family/speaker', (req, res) => {
    const household = householdFor(req);
    if (!household) {
      res.status(401).json({ error: 'Unknown family' });
      return;
    }
    const member = (req.body as { member?: unknown } | undefined)?.member;
    const id = typeof member === 'string' && member ? member : null;
    if (id && !membersOf(household.id).some((m) => m.id === id)) {
      res.status(400).json({ error: 'Not a member of this family' });
      return;
    }
    setSpeaker(household.id, id);
    if (id) noteSpeakerChosen(household.id);
    res.json({ ok: true, speaker: id });
  });

  // News Alexa says by herself (a clinic accepted a booking or cannot take it). The page asks every
  // few seconds; each piece of news is given out once.
  app.get('/api/family/notices', (req, res) => {
    const household = householdFor(req);
    if (!household) {
      res.status(401).json([]);
      return;
    }
    res.json(takeNotices(household.id).map((n) => announce(household, n)));
  });

  // --- The clinic desk: what a test clinic's receptionist sees, with Accept / Can't take it.
  app.get('/clinic/api/bookings', (_req, res) => {
    res.json(deskBookings());
  });
  app.post('/clinic/api/bookings/:id/:decision', async (req, res) => {
    const decision = String(req.params.decision);
    if (decision !== 'accept' && decision !== 'reject') {
      res.status(400).json({ error: 'decision must be accept or reject' });
      return;
    }
    const note = String((req.body as { reason?: unknown } | undefined)?.reason ?? '');
    try {
      const booking = await clinicDecision(String(req.params.id), decision === 'accept', note);
      if (!booking) {
        res.status(404).json({ error: 'No such booking, or it is already cancelled.' });
        return;
      }
      res.json(booking);
    } catch (err) {
      console.error('[clinic desk]', err);
      res.status(500).json({ error: 'Could not save that. Please try again.' });
    }
  });
  app.get('/clinic', (_req, res) => {
    const file = resolve(WEB_DIR, 'clinic.html');
    if (!existsSync(file)) {
      res.status(503).type('text').send('The page is not built yet. Run: npm run build');
      return;
    }
    res.sendFile(file);
  });

  // The language Alexa answers in (the simulator's button; saying "Hindi mein bolo" does the same).
  app.post('/api/family/language', (req, res) => {
    const household = householdFor(req);
    const lang = (req.body as { lang?: unknown } | undefined)?.lang;
    if (!household) {
      res.status(401).json({ error: 'Unknown family' });
      return;
    }
    if (lang !== 'en' && lang !== 'hi') {
      res.status(400).json({ error: 'lang must be "en" or "hi"' });
      return;
    }
    setReplyLanguage(household.id, lang);
    res.json({ ok: true, replyLang: lang });
  });

  // The device's location (the simulator's location button), so "near me" means near the family.
  app.post('/api/family/location', async (req, res) => {
    const household = householdFor(req);
    if (!household) {
      res.status(401).json({ error: 'Unknown family' });
      return;
    }
    const body = (req.body ?? {}) as { lat?: unknown; lng?: unknown };
    const at = { lat: Number(body.lat), lng: Number(body.lng) };
    if (typeof body.lat !== 'number' || typeof body.lng !== 'number' || !Number.isFinite(at.lat) || !Number.isFinite(at.lng)) {
      res.status(400).json({ error: 'lat and lng must be numbers' });
      return;
    }
    if (!inIndia(at)) {
      res.status(422).json({ error: `DocSaathi finds doctors in India, so I'll keep looking near ${household.home_address}.` });
      return;
    }
    try {
      const moved = haversineKm(at, { lat: household.home_lat, lng: household.home_lng }) > 0.5;
      const first = household.home_source === 'default';
      const label = moved || first ? (await setHome(household.id, at, undefined, 'device')).label : household.home_address;
      if (moved) resetConversation(household.id);
      res.json({ ok: true, label, changed: moved });
    } catch (err) {
      console.error('[location]', err);
      res.status(500).json({ error: 'Could not save the location. Please try again.' });
    }
  });

  app.get('/api/health', (_req, res) => {
    res.json({
      ok: true,
      time: toIstIso(clock.now()),
      clockOffsetDays: Math.round(clock.offsetMs / 86_400_000),
      google: googleEnabled(),
      brain: brainLabel(),
      voice: voiceLabel(),
      linked: Boolean(linkedHousehold()),
      uhi: config.uhi.gatewayUrl ? 'UHI gateway' : 'test network',
      sandboxPort: config.sandboxPort,
    });
  });

  // Demo helpers for the video: move the clock forward to show follow-up reminders.
  app.post('/api/demo/time-jump', (req, res) => {
    const days = Number((req.body as { days?: number })?.days ?? 0);
    if (!Number.isFinite(days) || days < 0 || days > 400) {
      res.status(400).json({ error: 'days must be between 0 and 400' });
      return;
    }
    clock.jump(days * 86_400_000);
    res.json({ ok: true, now: toIstIso(clock.now()) });
  });
  app.post('/api/demo/time-reset', (req, res) => {
    clock.reset();
    const household = householdFor(req);
    if (household) resetConversation(household.id);
    res.json({ ok: true, now: toIstIso(clock.now()) });
  });
  // Full reset for recording the demo again: clock, conversation and test bookings.
  app.post('/api/demo/reset', (req, res) => {
    clock.reset();
    const household = householdFor(req);
    if (household) {
      resetConversation(household.id);
      resetDemoData(household.id);
      setReplyLanguage(household.id, 'en');
      setSpeaker(household.id, null); // nobody is assumed to be talking
    }
    res.json({ ok: true, now: toIstIso(clock.now()) });
  });

  // Tab icon (a teal "+" tile), so the browser does not ask for a missing favicon.
  app.get('/favicon.ico', (_req, res) => {
    res
      .type('image/svg+xml')
      .send('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="8" fill="#3fc6bd"/><path d="M16 8v16M8 16h16" stroke="#052320" stroke-width="4" stroke-linecap="round"/></svg>');
  });

  // --- Pages
  app.get('/', (_req, res) => res.redirect('/alexa'));
  app.get('/alexa', (_req, res) => {
    const file = resolve(WEB_DIR, 'alexa.html');
    if (!existsSync(file)) {
      res.status(503).type('text').send('The page is not built yet. Run: npm run build');
      return;
    }
    res.sendFile(file);
  });

  return app;
}

/**
 * The MCP Apps sandbox proxy runs on its own port = its own origin, so an app screen can never
 * reach the host page (double-iframe architecture). CSP is sent as a header the app cannot change.
 */
export function createSandboxApp() {
  const app = express();
  app.disable('x-powered-by');
  app.use(localhostHostValidation());
  app.get(['/', '/sandbox.html'], (_req, res) => {
    res.setHeader(
      'Content-Security-Policy',
      [
        "default-src 'self' 'unsafe-inline'",
        "script-src 'self' 'unsafe-inline'",
        "style-src 'self' 'unsafe-inline'",
        "img-src 'self' data: blob:",
        "font-src 'self' data:",
        "connect-src 'self'",
        "frame-src 'none'",
        "object-src 'none'",
        "base-uri 'none'",
      ].join('; '),
    );
    res.setHeader('Cache-Control', 'no-store');
    res.sendFile(resolve(WEB_DIR, 'sandbox.html'));
  });
  app.use((_req, res) => {
    res.status(404).type('text').send('Only the sandbox page is served here.');
  });
  return app;
}

function listen(app: ReturnType<typeof express>, port: number): Promise<Server> {
  return new Promise((ok, fail) => {
    const server = app.listen(port, '127.0.0.1', () => ok(server));
    server.on('error', fail);
  });
}

export async function start(port = config.port): Promise<Server> {
  db();
  // The test clinics sit around the family's home (their own location, once they have shared it).
  const family = householdByToken(DEMO_TOKEN);
  seedTestNetwork(db(), family ? { lat: family.home_lat, lng: family.home_lng } : undefined, family ? cityOf(family.home_address) : undefined);
  ensureRegistry();
  const household = await seedDemoFamily();
  ensureLinkPin(household, config.familyLinkPin); // for linking DocSaathi to Alexa (with Papa's test mobile number)
  setSpeaker(household.id, null); // a new start: nobody is assumed to be talking
  // From Google Maps, in the background (skipped for throwaway test databases): real area names for
  // the test clinics' addresses, and the nearest real hospitals, kept ready for an emergency.
  if (config.dbFile !== ':memory:') {
    void nameClinicAreas(db()).catch((err) => console.warn('[clinics]', err instanceof Error ? err.message : err));
    void rememberHospitals(household).catch(() => undefined);
  }
  const server = await listen(createApp(), port);
  const sandbox = await listen(createSandboxApp(), config.sandboxPort).catch((err: NodeJS.ErrnoException) => {
    console.warn(`Sandbox port ${config.sandboxPort} not available (${err.code}); screens will not render in the simulator.`);
    return undefined;
  });
  server.on('close', () => sandbox?.close());
  console.log(`DocSaathi is running.`);
  console.log(`  Echo Show simulator:  http://localhost:${port}/alexa`);
  console.log(`  MCP endpoint:         http://localhost:${port}/mcp   (Streamable HTTP, OAuth 2.1; on this computer the demo token ${DEMO_TOKEN} also works)`);
  console.log(`  Account linking:      http://localhost:${port}/.well-known/oauth-authorization-server   (Alexa+ client id: ${alexaClient().id}${config.alexa.clientSecret ? '' : config.dbFile === ':memory:' ? ', test secret for this run' : ', secret in data/alexa-client.json'})`);
  console.log(`  This Echo:            ${linkedHousehold() ? 'linked to DocSaathi' : 'not linked yet (tap "Link account" on the page; test family: 00000 11111, PIN ' + config.familyLinkPin + ')'}`);
  console.log(`  UHI:                  ${config.uhi.gatewayUrl ? `gateway ${config.uhi.gatewayUrl}` : 'local test network (2 providers, test clinics)'}`);
  console.log(`  Google Maps:          ${googleEnabled() ? 'on (real nearby clinics + travel times)' : 'off (offline estimates)'}`);
  console.log(`  Brain:                ${brainLabel()}${config.brain !== 'demo' && brainLabel() === 'demo rules' ? ` (BRAIN=${config.brain} but its key is empty)` : ''}`);
  console.log(`  Voice:                ${voiceLabel()}`);
  for (const host of config.publicHosts) console.log(`  Phone / public:       https://${host}/alexa   (through your tunnel to port ${port})`);
  return server;
}

// Run when started directly (npm start), not when imported by tests.
if (process.argv[1] && /index\.(ts|js)$/.test(process.argv[1])) {
  start().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
