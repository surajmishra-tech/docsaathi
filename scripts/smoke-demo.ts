// Checks the Echo Show simulator end to end over HTTP: pages, sandbox, MCP App screen, and the
// full demo conversation through /api/assistant (the "Alexa" brain calling DocSaathi over MCP).
// Usage: npm run smoke:demo
process.env.DOCSAATHI_DB = ':memory:';
process.env.BRAIN = 'demo'; // the built-in rules: same answers every run, no AI key needed
process.env.PORT = process.env.SMOKE_PORT ?? '3997';
process.env.SANDBOX_PORT = process.env.SMOKE_SANDBOX_PORT ?? '3996';

const { start } = await import('../src/server/index.js');
const { Client, StreamableHTTPClientTransport } = await import('@modelcontextprotocol/client');
const { linkSimulator } = await import('./link.js');

const base = `http://127.0.0.1:${process.env.PORT}`;
const server = await start(Number(process.env.PORT));
await linkSimulator(base); // like a family enabling DocSaathi in the Alexa app (OAuth account linking)
let failures = 0;
const check = (label: string, ok: boolean, detail = '') => {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  ->  ${detail}` : ''}`);
};

async function say(text: string) {
  const res = await fetch(`${base}/api/assistant`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text }) });
  const body = (await res.json()) as { speech: string; kind: string; tool: { name: string; result: { structuredContent?: Record<string, any> } } | null };
  console.log(`\nYou:   ${text}\nAlexa: ${body.speech}\n       [${body.kind}${body.tool ? ` via ${body.tool.name}` : ''}]`);
  return body;
}

try {
  // Pages and sandbox
  const page = await fetch(`${base}/alexa`);
  check('/alexa page is served', page.ok && (await page.text()).includes('DocSaathi'));
  const sandbox = await fetch(`http://127.0.0.1:${process.env.SANDBOX_PORT}/sandbox.html`);
  check('sandbox served on its own port with a CSP header', sandbox.ok && Boolean(sandbox.headers.get('content-security-policy')));

  // MCP App wiring, as any MCP Apps host (Alexa+, Claude...) would see it (through the Echo's Alexa side,
  // which adds the family's OAuth token)
  const client = new Client({ name: 'demo-check', version: '1.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/alexa/mcp`)));
  const { tools } = await client.listTools();
  const withUi = tools.filter((t) => (t._meta as { ui?: { resourceUri?: string } } | undefined)?.ui?.resourceUri === 'ui://docsaathi/screen.html');
  check('every tool links to the DocSaathi screen', withUi.length === tools.length, `${withUi.length}/${tools.length}`);
  const mapTool = tools.find((t) => t.name === 'get_map');
  check('get_map is a screen-only tool (MCP Apps visibility "app")', JSON.stringify((mapTool?._meta as { ui?: { visibility?: string[] } } | undefined)?.ui?.visibility) === '["app"]');
  const map = (await client.callTool({ name: 'get_map', arguments: { places: [{ lat: 18.54, lng: 73.84, label: '1' }], route: true } })) as { content: Array<{ type: string; data?: string }>; isError?: boolean };
  check('get_map returns a map picture (or says why not, without a Google key)', map.content[0]?.type === 'image' ? (map.content[0].data ?? '').length > 5000 : Boolean(map.isError));
  const resource = await client.readResource({ uri: 'ui://docsaathi/screen.html' });
  const content = resource.contents[0] as { mimeType?: string; text?: string };
  check('screen resource is an MCP App (text/html;profile=mcp-app)', content.mimeType === 'text/html;profile=mcp-app' && (content.text ?? '').length > 10_000);
  await client.close();

  // The demo story, exactly as the simulator's buttons send it
  const r1 = await say('Aarav ko bukhaar hai, aaj shaam paas mein bachchon ka doctor chahiye');
  check('1 find child doctors', r1.kind === 'doctors' && r1.tool?.name === 'find_doctors');
  const shown = (r1.tool?.result.structuredContent?.doctors ?? []) as Array<{ address?: string; directions?: string }>;
  check('  several doctors, each with the clinic address and a directions link', shown.length >= 4 && shown.every((d) => Boolean(d.address) && /^https:\/\/www\.google\.com\/maps\/dir\//.test(d.directions ?? '')), `${shown.length} doctors`);
  check('  Alexa says where each clinic is', /Dr\. [A-Z][a-z]+ [A-Z][a-z]+ in [A-Z]/.test(r1.speech));
  const r2 = await say('Pehla wala');
  check('2 "the first one" -> asks which time (times screen)', r2.kind === 'times' && /Which time/.test(r2.speech));
  const r2b = await say('Sabse pehla time');
  check('3 "the earliest time" -> confirm card', r2b.kind === 'confirm' && /Aarav/.test(r2b.speech));
  const r3 = await say('Haan, book kar do');
  check('4 "yes, book it" -> booked', r3.kind === 'booked');
  const links = (r3.tool?.result.structuredContent?.links ?? {}) as Record<string, string>;
  check(
    '  booked screen links to the real world: directions, Google Calendar, WhatsApp',
    /^https:\/\/www\.google\.com\/maps\/dir\//.test(links.directions ?? '') && /^https:\/\/calendar\.google\.com\/calendar\/render\?action=TEMPLATE/.test(links.calendar ?? '') && /^https:\/\/wa\.me\/\?text=/.test(links.whatsapp ?? ''),
  );
  const r4 = await say('Aur Dadi ke liye kal subah sugar wale doctor ka appointment');
  check('5 Dadi -> usual sugar doctor from memory', r4.kind === 'usual' && /Sharma/.test(r4.speech));
  const r5 = await say('Haan');
  check('6 "yes" -> confirm card with fasting note', r5.kind === 'confirm' && /fasting/i.test(r5.speech));
  const r6 = await say('Haan, book kar do');
  check('7 "yes, book it" -> booked', r6.kind === 'booked');
  const r7 = await say('Doctor ne kaha 3 mahine baad Dadi ko wapas aana hai');
  check('8 follow-up remembered', r7.kind === 'follow-up');
  await fetch(`${base}/api/demo/time-jump`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ days: 90 }) });
  const r9 = await say('Koi checkup due hai?');
  check('10 three months later -> check-up due', r9.kind === 'reminders' && /due/.test(r9.speech));
  const r10 = await say('Papa ke seene mein dard hai');
  check('11 emergency words -> call 112, no booking', r10.kind === 'emergency' && /112/.test(r10.speech));

  // Taps on the screen arrive as text, like speech
  await fetch(`${base}/api/demo/time-reset`, { method: 'POST' });
  const t1 = await say('Aarav ke liye bachchon ka doctor kal shaam');
  const t2 = await say('Show more times for Dr. Farhan Qureshi');
  check('tap "More times" -> times for that doctor', t2.kind === 'times' && /Qureshi/.test(t2.speech), t1.kind);
  const t3 = await say('Haan');
  check('"yes" after times -> confirm card', t3.kind === 'confirm');
  const t4 = await say('Nahi');
  check('"no" -> nothing booked', t4.kind === 'question' && t4.tool === null);

  // Hindi script from Chrome's hi-IN recognition
  const h1 = await say('आरव के लिए कल शाम बच्चों का डॉक्टर');
  check('Devanagari: child doctor for आरव tomorrow evening', h1.kind === 'doctors' || h1.kind === 'usual', h1.kind);

  const messages = (await (await fetch(`${base}/api/family/messages`)).json()) as unknown[];
  check('Papa received booking messages', messages.length >= 2, `${messages.length} messages`);

  // Regression checks for bugs found while writing the test guide (1 Oct 2026)
  await fetch(`${base}/api/demo/reset`, { method: 'POST' });
  await say('Aarav ko bukhaar hai, aaj shaam paas mein bachchon ka doctor chahiye');
  const b1 = await say('Marathi bolne wale bachchon ka doctor');
  check('bug 1: "...wale" + a new need is a new search (Marathi-speaking doctors only, still for Aarav)', b1.kind === 'doctors' && /Anjali Mehta/.test(b1.speech) && !/Qureshi|Nair/.test(b1.speech) && /for Aarav/.test(b1.speech));
  await say('Pehla wala');
  const b3 = await say('6:30 wala');
  check('choosing a time -> confirm card for Aarav', (b3.kind === 'confirm' && /Aarav/.test(b3.speech)) || (b3.kind === 'question' && /isn't free/.test(b3.speech)), b3.kind);
  if (b3.kind !== 'confirm') await say('Sabse pehla time');
  await say('Haan');
  const b4 = await say('Haan');
  check('bug 4: an extra "yes" after booking books nothing', b4.tool === null && /nothing waiting/i.test(b4.speech));
  const b5 = await say('I need a skin doctor for me tomorrow evening');
  check('"for me" while nobody knows who is talking -> asks who (never assumes Mummy)', b5.kind === 'question' && /Who am I speaking with/.test(b5.speech), b5.speech.slice(0, 80));
  const b5b = await say('Mummy');
  check('answer "Mummy" -> skin doctors for Mummy', b5b.kind === 'doctors' && /Thank you, Mummy/.test(b5b.speech) && /for Mummy/.test(b5b.speech), b5b.speech.slice(0, 80));
  const b6 = await say('Chacha ke liye daant ka doctor');
  check('bug 3: unknown relation -> asks their name', b6.kind === 'question' && /chacha/i.test(b6.speech) && /name/i.test(b6.speech));
  const b7 = await say('Chacha ka naam Ramesh hai, 50 saal');
  check('adding Chacha from one sentence, then carrying on with the dentist', b7.kind === 'doctors' && /Ramesh/.test(b7.speech) && /for Chacha/.test(b7.speech));
  const b8 = await say('Chacha ke liye daant ka doctor');
  check('Chacha can now be booked for', b8.kind === 'doctors' && /for Chacha/.test(b8.speech));

  // Talking like a person (30 Sep 2026): greetings, asking the problem, asking who, new people, location
  await fetch(`${base}/api/demo/reset`, { method: 'POST' });
  const c1 = await say('Hello Alexa');
  check('"hello" gets a greeting, not a doctor list', c1.kind === 'chat' && c1.tool === null && /Namaste/.test(c1.speech));
  const c2 = await say('kaise ho');
  check('"kaise ho" -> small talk', c2.kind === 'chat' && /How are you/i.test(c2.speech));
  const c3 = await say('main theek hoon');
  check('"main theek hoon" -> small talk, nothing booked', c3.kind === 'chat' && c3.tool === null);
  const c4 = await say('Mujhe doctor ko dikhana hai');
  check('"I need to see a doctor" -> asks the problem', c4.kind === 'question' && /problem/i.test(c4.speech));
  const c5a = await say('Pet mein dard hai');
  check('"stomach pain" (about themselves) -> asks who is speaking', c5a.kind === 'question' && /sorry to hear/.test(c5a.speech) && /Who am I speaking with/.test(c5a.speech), c5a.speech.slice(0, 90));
  const c5 = await say('Main Mummy hoon');
  check('"main Mummy hoon" -> family doctors for Mummy', c5.kind === 'doctors' && /family doctors for Mummy/.test(c5.speech), c5.speech.slice(0, 90));
  const c6 = await say('doosra wala');
  check('choosing a doctor -> asks which time', c6.kind === 'times' && /Which time/.test(c6.speech));
  const c7 = await say('kal subah 10 baje');
  // (If tomorrow is a Sunday the clinic may be closed; then Alexa offers other times instead.)
  check('"kal subah 10 baje" -> confirm card for tomorrow 10 AM', (c7.kind === 'confirm' && /tomorrow at 10:00 AM/.test(c7.speech)) || /isn't free/.test(c7.speech), c7.speech.slice(0, 80));
  const c8 = await say('nahi');
  // With a time held, "nahi" lets it go and asks what next; with nothing held (the doctor wasn't free) it simply books nothing.
  check('"no" -> not booked', c8.tool === null && (c7.kind === 'confirm' ? c8.kind === 'question' : c8.kind !== 'booked'));
  const c9 = await say('thank you');
  check('"thank you" -> small talk', c9.kind === 'chat');

  // Who is talking (3 Oct 2026). Nobody is assumed: "me" makes Alexa ask, the answer is kept for the
  // conversation, and "bye" forgets it (the next person may be someone else).
  await fetch(`${base}/api/demo/reset`, { method: 'POST' });
  const familyNow = async () => (await (await fetch(`${base}/api/family`)).json()) as { speaker: string | null; members: Array<{ id: string; name: string }> };
  const idOf = async (name: string) => (await familyNow()).members.find((m) => m.name === name)?.id;
  check('after a reset nobody is assumed to be talking', (await familyNow()).speaker === null);
  const s1 = await say('Mujhe bukhaar hai');
  check('"mujhe bukhaar hai" -> "Who am I speaking with?"', s1.kind === 'question' && /Who am I speaking with/.test(s1.speech), s1.speech.slice(0, 90));
  const s2 = await say('Papa');
  check('answer "Papa" -> family doctors for Papa', s2.kind === 'doctors' && /Thank you, Papa/.test(s2.speech) && /for Papa/.test(s2.speech), s2.speech.slice(0, 90));
  check('Papa is now the one talking', (await familyNow()).speaker === (await idOf('Rajesh')));
  const s3 = await say('Aur meri aankh bhi check karwani hai');
  check('"meri aankh" now means Papa, without asking again', s3.kind === 'doctors' && /eye doctors? for Papa/.test(s3.speech), s3.speech.slice(0, 90));
  const s4 = await say('bye');
  check('"bye" -> forgets who was talking', s4.kind === 'chat' && (await familyNow()).speaker === null);
  const s5 = await say('Main Dadi hoon, mere ghutne mein dard hai');
  check('"main Dadi hoon, mere ghutne mein dard hai" -> bone doctors for Dadi', s5.kind === 'doctors' && /^Okay, Dadi\./.test(s5.speech) && /bone and joint doctors? for Dadi/.test(s5.speech), s5.speech.slice(0, 110));
  await say("I am Aarav's mother");
  check(`"I am Aarav's mother" does not make Aarav the speaker`, (await familyNow()).speaker === (await idOf('Kamla')));
  const s6 = await say('Mera naam Kabir hai');
  check('"mera naam Kabir hai" (someone new) -> asks their age', s6.kind === 'question' && /Nice to meet you, Kabir/.test(s6.speech) && /How old are you/.test(s6.speech), s6.speech.slice(0, 90));
  const s7 = await say('25');
  check('age given -> Kabir added and now he is the one talking', s7.kind === 'family-added' && /How can I help you, Kabir/.test(s7.speech) && (await familyNow()).speaker === (await idOf('Kabir')), s7.speech);
  await fetch(`${base}/api/family/speaker`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ member: await idOf('Neha') }) });
  const s8 = await say('Mujhe aankh ka doctor chahiye');
  check('picked "Mummy" in the Speaking menu -> "mujhe" means Mummy, no question', s8.kind === 'doctors' && /for Mummy/.test(s8.speech), s8.speech.slice(0, 90));
  const bad = await fetch(`${base}/api/family/speaker`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ member: 'mem_not_ours' }) });
  check('the Speaking menu only accepts this family', bad.status === 400);
  await fetch(`${base}/api/family/speaker`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ member: null }) });
  await say('Hindi mein bolo');
  const s9 = await say('मुझे बुखार है');
  check('in Hindi too: "मुझे बुखार है" -> asks who is speaking, in Hindi', s9.kind === 'question' && /किससे बात कर रही हूँ/.test(s9.speech), s9.speech);
  const s10 = await say('मैं पापा हूँ');
  check('"मैं पापा हूँ" -> doctors for Papa, in Hindi', s10.kind === 'doctors' && /पापा/.test(s10.speech) && /मिले हैं/.test(s10.speech), s10.speech.slice(0, 90));
  await say('speak in English');

  await fetch(`${base}/api/demo/reset`, { method: 'POST' });
  const d1 = await say('daant mein dard hai');
  check('a problem with no person -> asks who it is for', d1.kind === 'question' && /Who is it for/.test(d1.speech));
  const d2 = await say('Rohit');
  check('a new name -> asks their age', d2.kind === 'question' && /How old is Rohit/.test(d2.speech));
  const d3 = await say('25 saal');
  check('age given -> Rohit added and the dentist search carries on', d3.kind === 'doctors' && /Added Rohit/.test(d3.speech) && /teeth doctor/.test(d3.speech));
  const d4 = await say('bukhaar mein kaun si dawai lu');
  check('asking for medicine -> no medical advice', d4.kind === 'chat' && /can't suggest medicines/.test(d4.speech));
  const d5 = await say('asdf qwerty');
  check('nonsense -> a helpful "did not get that", no doctor list', d5.kind === 'chat' && d5.tool === null);
  const d6 = await say('I live in Delhi');
  check('"I live in Delhi" -> location changes', d6.kind === 'location' && /Delhi/.test(d6.speech));
  const d7 = await say('Aarav ko bukhaar hai, bachchon ka doctor chahiye');
  check('after moving: child doctors are still near (test clinics moved too)', d7.kind === 'doctors' && /\b\d{1,2} minutes away/.test(d7.speech), d7.speech.slice(0, 120));
  const loc = await fetch(`${base}/api/family/location`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ lat: 47.6, lng: -122.3 }) });
  check('a location outside India is refused politely', loc.status === 422);
  // Real places from Google Maps (needs GOOGLE_MAPS_API_KEY; without it Alexa says she cannot look them up)
  const n1 = await say('real clinics near me');
  check('"real clinics near me" -> the real-places screen', n1.kind === 'nearby' && n1.tool?.name === 'find_nearby_clinics');
  const n2 = await say('sabse paas ka hospital kahan hai');
  check('"nearest hospital" -> real hospitals, not a booking', n2.kind === 'nearby', n2.speech.slice(0, 90));
  // The clinic's side: the desk accepts or can't take a booking, and Alexa tells the family by herself
  await fetch(`${base}/api/demo/reset`, { method: 'POST' });
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const notices = async () => (await (await fetch(`${base}/api/family/notices`)).json()) as Array<{ speech: string; kind: string }>;
  const desk = async () => (await (await fetch(`${base}/clinic/api/bookings`)).json()) as Array<{ id: string; patient: string; decision: string; status: string }>;
  await say('Aarav ko bukhaar hai, bachchon ka doctor chahiye');
  // What "roko, book this" becomes when Alexa was reading out doctor 2
  const k1 = await say('book doctor number 2, earliest time');
  check('"roko, book this" (while doctor 2 was read out) -> doctor 2, earliest time, confirm card', k1.kind === 'confirm', k1.speech.slice(0, 90));
  const k2 = await say('haan');
  check('booked, and Alexa says she will tell when the clinic accepts', k2.kind === 'booked' && /when the clinic accepts/.test(k2.speech));
  const deskPage = await fetch(`${base}/clinic`);
  check('clinic desk page is served', deskPage.ok && (await deskPage.text()).includes('Clinic desk'));
  const deskOne = (await desk()).find((b) => b.decision === 'new' && b.status === 'confirmed');
  check('the booking appears on the clinic desk as new', Boolean(deskOne), deskOne?.patient);
  const acc = await fetch(`${base}/clinic/api/bookings/${deskOne?.id}/accept`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  await sleep(400);
  const newsOne = await notices();
  check('desk accepts -> Alexa says the clinic accepted (over a signed UHI on_status)', acc.ok && newsOne.some((n) => n.kind === 'clinic-accepted' && /accepted/.test(n.speech)), newsOne[0]?.speech);
  check('each piece of news is said only once', (await notices()).length === 0);
  const a1 = await say('mere appointments dikhao');
  check('appointments show "accepted by the clinic"', a1.kind === 'appointments' && /accepted by the clinic/.test(a1.speech), a1.speech.slice(0, 120));
  await say('Dadi ke liye aankh ka doctor chahiye kal');
  await say('pehla wala');
  await say('sabse pehla time');
  await say('haan');
  const deskTwo = (await desk()).find((b) => b.decision === 'new' && b.status === 'confirmed');
  await fetch(`${base}/clinic/api/bookings/${deskTwo?.id}/reject`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ reason: 'Doctor not available at that time' }) });
  await sleep(400);
  const newsTwo = await notices();
  check('desk can\'t take it -> Alexa says so, with the reason, and offers another time', newsTwo.some((n) => n.kind === 'clinic-rejected' && /cannot take/.test(n.speech) && /not available/.test(n.speech)), newsTwo[0]?.speech);
  const againDadi = await say('haan');
  check('"haan" -> finds eye doctors for Dadi again', againDadi.kind === 'doctors' && /eye doctor/.test(againDadi.speech) && /Dadi/.test(againDadi.speech), againDadi.speech.slice(0, 90));
  const family = (await (await fetch(`${base}/api/family/messages`)).json()) as Array<{ body: string }>;
  check('Papa gets a message that the clinic cannot take it', family.some((m) => /cannot take/.test(m.body)));

  // "Hindi mein bolo" / "speak in English": the language Alexa answers in
  const hindi = /[ऀ-ॿ]/;
  await fetch(`${base}/api/demo/reset`, { method: 'POST' });
  const l0 = await say('Hindi bolne wala doctor chahiye');
  check('"a doctor who speaks Hindi" is about the doctor: Alexa keeps speaking English', l0.kind !== 'language' && !hindi.test(l0.speech));
  const l1 = (await say('Hindi mein bolo')) as { kind: string; speech: string; lang?: string };
  check('"Hindi mein bolo" -> Alexa answers in Hindi from now on', l1.kind === 'language' && hindi.test(l1.speech) && l1.lang === 'hi');
  const l2 = await say('Aarav ko bukhaar hai, bachchon ka doctor chahiye');
  check('doctor list in Hindi, with the same numbers', l2.kind === 'doctors' && /मिले हैं/.test(l2.speech) && /फ़ीस \d+ रुपये/.test(l2.speech) && /किसे बुक करूँ\?/.test(l2.speech), l2.speech.slice(0, 110));
  const l3 = await say('pehla wala');
  check('times in Hindi', l3.kind === 'times' && /कौन सा समय बुक करूँ\?/.test(l3.speech), l3.speech.slice(0, 110));
  const l4 = await say('sabse pehla time');
  check('confirm question in Hindi', l4.kind === 'confirm' && /क्या मैं बुक कर दूँ\?/.test(l4.speech), l4.speech.slice(0, 140));
  const l5 = await say('haan');
  check('booked in Hindi', l5.kind === 'booked' && /बुक हो गया है/.test(l5.speech), l5.speech.slice(0, 140));
  const l6 = await say('papa ke seene mein dard hai');
  check('emergency in Hindi still says 112 and 108', l6.kind === 'emergency' && /112/.test(l6.speech) && /108/.test(l6.speech) && hindi.test(l6.speech));
  const l7 = await say('kaun si dawai lu');
  check('no medical advice, in Hindi', l7.kind === 'chat' && /दवा नहीं बता सकती/.test(l7.speech));
  const l8 = (await say('speak in English')) as { kind: string; speech: string; lang?: string };
  check('"speak in English" -> back to English', l8.kind === 'language' && !hindi.test(l8.speech) && l8.lang === 'en');
  const l9 = await say('hello');
  check('then answers are English again', !hindi.test(l9.speech));

  const bye = (await say('bye')) as { kind: string; end?: boolean };
  check('"bye" ends the conversation', bye.kind === 'chat' && bye.end === true);
} catch (err) {
  failures++;
  console.error('Demo check crashed:', err);
} finally {
  server.close();
  console.log(`\n${failures === 0 ? 'ALL PASSED' : `${failures} FAILED`}`);
  process.exit(failures === 0 ? 0 : 1);
}
