// The menu's health record pages in headless Chrome: add a medicine and a visit, filter, share on
// WhatsApp, remove. Usage: npm run check:records   (screenshots go to ./screenshots/records)
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

process.env.DOCSAATHI_DB = ':memory:';
process.env.BRAIN = 'demo';
process.env.PORT = process.env.REC_PORT ?? '3961';
process.env.SANDBOX_PORT = process.env.REC_SANDBOX_PORT ?? '3960';
const out = resolve('screenshots', 'records');
mkdirSync(out, { recursive: true });
const { start } = await import('../src/server/index.js');
const { linkSimulator } = await import('./link.js');
const { chromium } = await import('playwright-core');
const base = `http://127.0.0.1:${process.env.PORT}`;
const server = await start(Number(process.env.PORT));
await linkSimulator(base);
let fails = 0;
const check = (label: string, ok: boolean, detail = '') => {
  if (!ok) fails++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  ->  ' + detail : ''}`);
};

// API: bad input is refused, other families' ids can't be used
const bad = await fetch(`${base}/api/records/medicines`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ memberId: 'nobody', name: 'X' }) });
check('a medicine for someone outside the family is refused', bad.status === 400);
const future = await fetch(`${base}/api/records/visits`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ memberId: 'x', doctor: 'Dr. A', date: '2099-01-01' }) });
check('bad visit is refused', future.status === 400);

const browser = await chromium.launch({ channel: 'chrome', headless: true });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await ctx.newPage();
const errors: string[] = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('dialog', (d) => d.accept());
await page.goto(`http://localhost:${process.env.PORT}/alexa`, { waitUntil: 'networkidle' });
// Mummy is talking (so "added by Mummy" is recorded)
const fam = (await (await fetch(`${base}/api/family`)).json()) as { members: Array<{ id: string; label: string }> };
await page.selectOption('#speaking select', fam.members.find((m) => m.label.startsWith('Mummy'))!.id);
await page.waitForTimeout(400);

await page.locator('#menu-btn').click();
await page.locator('.drawer .item', { hasText: 'Medicine records' }).click();
await page.locator('#page-medicines .rec-add summary').waitFor();
check('Medicine records page opens with a back button', (await page.locator('#drawer-title').innerText()) === 'Medicine records' && (await page.locator('#drawer-back').isVisible()));
await page.locator('#page-medicines .rec-add summary').click();
const dadi = fam.members.find((m) => m.label.startsWith('Dadi'))!.id;
await page.selectOption('#page-medicines select[name=memberId]', dadi);
await page.fill('#page-medicines input[name=name]', 'Metformin 500 mg');
await page.fill('#page-medicines input[name=howToTake]', '1 tablet after breakfast and dinner');
await page.fill('#page-medicines input[name=days]', '30');
await page.fill('#page-medicines input[name=doctor]', 'Dr. Rakesh Sharma');
await page.locator('#page-medicines .rec-save').click();
await page.locator('#page-medicines .rec-card').first().waitFor();
const card = await page.locator('#page-medicines .rec-card').first().innerText();
check('saved medicine shows with days left, doctor, person and who added it', /Metformin 500 mg/.test(card) && /30 days left/.test(card) && /Dr\. Rakesh Sharma/.test(card) && /for Dadi/.test(card) && /Added by Mummy/.test(card), card.replace(/\s+/g, ' '));
await page.screenshot({ path: `${out}/medicines.png` });

// Share opens WhatsApp with the list
const [popup] = await Promise.all([ctx.waitForEvent('page'), page.locator('#page-medicines .rec-share').click()]);
const shared = decodeURIComponent(popup.url().replace(/\+/g, ' '));
check('Share opens WhatsApp with the medicine list', /wa\.me|whatsapp\.com/.test(shared) && /Metformin 500 mg/.test(shared) && /Dadi/.test(shared), shared.slice(0, 120));
await popup.close();

// Back, then Doctors we visited: the seeded past visit is there; add a visit
await page.locator('#drawer-back').click();
await page.locator('.drawer .item', { hasText: 'Doctors we visited' }).click();
await page.locator('#page-visits .rec-add summary').waitFor();
const visited = await page.locator('#page-visits').innerText();
check("Dadi's past DocSaathi visit is listed by itself", /Dr\. Rakesh Sharma/.test(visited) && /Booked on DocSaathi/.test(visited));
await page.locator('#page-visits .rec-add summary').click();
await page.selectOption('#page-visits select[name=memberId]', fam.members.find((m) => m.label.startsWith('Papa'))!.id);
await page.fill('#page-visits input[name=doctor]', 'Dr. Mehta');
await page.selectOption('#page-visits select[name=specialty]', 'Dermatologist');
await page.locator('#page-visits .rec-save').click();
await page.waitForFunction(() => document.querySelector('#page-visits')?.textContent?.includes('Dr. Mehta'));
check('a visit added by hand appears in the list', (await page.locator('#page-visits').innerText()).includes('Dr. Mehta'));
// Filter to Papa
await page.locator('#page-visits .rec-filter .chip', { hasText: 'Papa' }).click();
const papaOnly = await page.locator('#page-visits').innerText();
check('the Papa filter hides Dadi', /Dr\. Mehta/.test(papaOnly) && !/Rakesh Sharma/.test(papaOnly));
await page.screenshot({ path: `${out}/visits.png` });

// Remove the medicine
await page.locator('#drawer-back').click();
await page.locator('.drawer .item', { hasText: 'Medicine records' }).click();
await page.locator('#page-medicines .rec-filter .chip', { hasText: 'Everyone' }).click();
await page.locator('#page-medicines .rec-card').first().waitFor();
await page.locator('#page-medicines .rec-remove').first().click();
await page.waitForFunction(() => !document.querySelector('#page-medicines .rec-card'));
check('Remove deletes the medicine', (await page.locator('#page-medicines .rec-card').count()) === 0);

// Closing the menu goes back to the list next time
await page.keyboard.press('Escape');
await page.waitForTimeout(400);
await page.locator('#menu-btn').click();
check('the menu opens on its list again', await page.locator('.drawer-body').isVisible());
check('no browser errors', errors.length === 0, errors.join(' | '));
await browser.close();
server.close();
console.log(fails ? `${fails} FAILED` : 'ALL PASSED');
process.exit(fails ? 1 : 0);
