// Opens the Echo Show simulator in the locally installed Chrome (headless), plays the demo buttons,
// checks that each MCP App screen renders inside the sandbox, reports browser errors, and saves
// screenshots. Usage: npm run check:ui   (screenshots go to ./screenshots or UI_SHOTS_DIR)
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

// UI_REMOTE=1 checks "phone mode": a phone-sized screen opening the app through a non-localhost
// address (like an ngrok tunnel), where the screen runs in the single locked-down iframe.
const REMOTE = process.env.UI_REMOTE === '1';
const REMOTE_HOST = 'docsaathi.test';

process.env.DOCSAATHI_DB = ':memory:';
process.env.BRAIN = 'demo'; // the built-in rules: same answers every run, no AI key needed
process.env.PORT = process.env.UI_PORT ?? '3995';
process.env.SANDBOX_PORT = process.env.UI_SANDBOX_PORT ?? '3994';
if (REMOTE) process.env.PUBLIC_HOSTS = REMOTE_HOST;

const { start } = await import('../src/server/index.js');
const { chromium } = await import('playwright-core');
const { linkSimulator } = await import('./link.js');

const shots = resolve(process.env.UI_SHOTS_DIR ?? 'screenshots', `${REMOTE ? 'phone' : 'desktop'}-${process.env.UI_VIEWPORT ?? 'default'}`);
mkdirSync(shots, { recursive: true });
const server = await start(Number(process.env.PORT));
// Phone mode links over HTTP; on desktop the check below links in the browser, like a person would.
if (REMOTE) await linkSimulator(`http://127.0.0.1:${process.env.PORT}`);
const browser = await chromium.launch({
  channel: 'chrome',
  headless: true,
  args: REMOTE ? [`--host-resolver-rules=MAP ${REMOTE_HOST} 127.0.0.1`] : [],
});
// UI_VIEWPORT="360x740" picks a phone size (default 412x915 in phone mode, 1440x900 on desktop).
const [vw, vh] = (process.env.UI_VIEWPORT ?? (REMOTE ? '412x915' : '1440x900')).split('x').map(Number);
const page = REMOTE
  ? await browser.newPage({ viewport: { width: vw, height: vh }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 })
  : await browser.newPage({ viewport: { width: vw, height: vh } });
const origin = `http://${REMOTE ? REMOTE_HOST : 'localhost'}:${process.env.PORT}`;

const errors: string[] = [];
page.on('pageerror', (e) => errors.push(`page: ${e.message}`));
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(`console: ${m.text()}`);
});

let failures = 0;
let mapsShown = 0;
const check = (label: string, ok: boolean, detail = '') => {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  ->  ${detail}` : ''}`);
};

const screen = () =>
  REMOTE
    ? page.frameLocator('#screen iframe[style*="opacity: 1"]')
    : page.frameLocator('#screen iframe[style*="opacity: 1"]').frameLocator('iframe');

/** Tap a demo line and wait for Alexa's answer. `onPage` = the answer has no app screen (small talk). */
async function tap(label: string, expectSelector: string, shot?: string, onPage = false) {
  const before = await page.locator('.bubble:not(.you)').count();
  await page.locator('#demo-lines button', { hasText: label }).first().click();
  await page.waitForFunction((n) => document.querySelectorAll('.bubble:not(.you)').length > n, before, { timeout: 20_000 });
  let rendered = true;
  try {
    await (onPage ? page : screen()).locator(expectSelector).first().waitFor({ timeout: 15_000 });
  } catch {
    rendered = false;
  }
  const alexa = (await page.locator('.bubble:not(.you)').last().innerText()).replace(/^Alexa\s*/i, '');
  check(`"${label}" shows ${expectSelector}`, rendered, alexa.slice(0, 110));
  // The map picture arrives a moment later (the screen asks the server for it): wait for it before the screenshot.
  if (!onPage && shot && (await screen().locator('.map').count()) > 0) {
    await screen()
      .locator('.map.ready img')
      .first()
      .waitFor({ timeout: 12_000 })
      .then(() => {
        mapsShown++;
      })
      .catch(() => undefined);
  }
  if (shot) await (REMOTE ? page : page.locator('.device-wrap')).screenshot({ path: resolve(shots, `${shot}.png`) });
}

try {
  await page.goto(`${origin}/alexa`, { waitUntil: 'networkidle' });
  check('page loads with status pills', (await page.locator('.pill').count()) >= 3);
  if (!REMOTE) {
    // Account linking (OAuth), like in the Alexa app: Link account -> DocSaathi's sign-in page -> Allow.
    check('not linked yet: the screen offers "Link account"', await page.locator('#link-card').isVisible());
    await page.locator('.device-wrap').screenshot({ path: resolve(shots, '00a-not-linked.png') });
    const [popup] = await Promise.all([page.waitForEvent('popup'), page.locator('#link-btn').click()]);
    await popup.waitForSelector('#allow');
    await popup.setViewportSize({ width: 440, height: 900 });
    check("the sign-in window is DocSaathi's page (mobile number + family PIN)", /Link DocSaathi to Alexa/.test(await popup.locator('h1').innerText()));
    await popup.screenshot({ path: resolve(shots, '00b-sign-in.png'), fullPage: true });
    await popup.locator('#fill').click();
    await Promise.all([popup.waitForEvent('close', { timeout: 15_000 }), popup.locator('#allow').click()]);
    await page.locator('#account', { hasText: 'Linked' }).waitFor({ timeout: 10_000 });
    check('after Allow the window closes and the Echo shows "DocSaathi: Linked"', await page.locator('#link-card').isHidden());
  }
  await page.screenshot({ path: resolve(shots, '00-page.png') });

  check('hands-free switch, location button and language button are shown', (await page.locator('#handsfree').isVisible()) && (await page.locator('#where').isVisible()) && (await page.locator('#speaks').isVisible()));
  await tap('Hello', '.idle-time, .screen-idle', undefined, true);
  await tap('Find a child doctor', '.card', '01-doctors');
  await tap('The first one', '.time', '02-times');
  await tap('The earliest time', '.facts', '02-confirm');
  await tap('Yes, book it', '.ok', '03-booked');
  await tap('Dadi', '.big-time', '04-usual');
  await tap('Yes, that one', '.facts', '05-confirm-dadi');
  await tap('Yes, book it', '.ok', '06-booked-dadi');
  check('phone preview shows the messages sent to Papa', await page.locator('#phone').isVisible());
  await tap('Follow-up', '.message', '07-follow-up');
  await page.locator('#demo-lines button', { hasText: 'Jump 3 months' }).click();
  await page.waitForTimeout(500);
  await tap('check-ups due', '.list', '08-reminders');
  await tap('Emergency', '.emergency', '09-emergency');
  // Real places come from Google Maps: with a key there are place cards, without one a message.
  await tap('Nearest hospital', '.place, .message', '09b-real-hospitals');
  // Nobody is assumed to be talking: "stomach pain" about yourself -> "Who am I speaking with?" with a button per person.
  await tap('I need a doctor', '#transcript .bubble', undefined, true);
  await tap('Stomach pain', '.question .btn', '09c-who-is-talking');
  await tap("It's Papa", '.card', '09d-doctors-for-papa');
  check('the "Speaking:" menu now shows Papa', /Papa/.test(await page.locator('#speaking select option:checked').innerText()));

  // Reset, then check that a tap inside the screen joins the conversation, like speech.
  await page.locator('button.reset').click();
  await page.waitForFunction(() => document.querySelectorAll('#screen iframe').length === 0);
  await tap('Find a child doctor', '.card');
  const before = await page.locator('.bubble.you').count();
  await screen().locator('.card .btn.primary').first().click();
  await page.waitForFunction((n) => document.querySelectorAll('.bubble.you').length > n, before, { timeout: 15_000 });
  const tapped = await page.locator('.bubble.you').last().innerText();
  check('tapping "Book" on a doctor card sends a message into the conversation', /Book/i.test(tapped), tapped.replace(/^You\s*/i, ''));
  await screen().locator('.facts').first().waitFor({ timeout: 15_000 });
  await page.screenshot({ path: resolve(shots, '10-full-page.png') });

  // Map pictures need a Google Maps key; without one the map boxes simply close up.
  const health = (await (await fetch(`http://127.0.0.1:${process.env.PORT}/api/health`)).json()) as { google?: boolean };
  check('map pictures load inside the sandboxed screen (through the app-only get_map tool)', health.google ? mapsShown >= 3 : true, `${mapsShown} maps shown${health.google ? '' : ' (no Google key)'}`);
  check('no browser errors', errors.length === 0, errors.slice(0, 3).join(' | '));
} catch (err) {
  failures++;
  console.error('UI check crashed:', err);
  console.error('Browser errors:', errors);
} finally {
  await browser.close();
  server.close();
  console.log(`\nScreenshots: ${shots}\n${failures === 0 ? 'ALL PASSED' : `${failures} FAILED`}`);
  process.exit(failures === 0 ? 0 : 1);
}
