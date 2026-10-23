// DocSaathi's MCP App view. The host (Alexa+ or our Echo Show page) sends each tool result here;
// we draw the matching screen. Buttons talk back to the conversation with app.sendMessage, so
// tapping "Book it" works exactly like saying "yes, book it".
import { App, applyDocumentTheme, type McpUiHostContext } from '@modelcontextprotocol/ext-apps';

type Any = Record<string, any>;

const root = document.getElementById('root')!;
const app = new App({ name: 'DocSaathi screen', version: '0.1.0' });

const esc = (v: unknown): string =>
  String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

const clean = (name: string) => name.replace(/\s*\(TEST\)\s*$/, '');

function say(text: string): void {
  app.sendMessage({ role: 'user', content: [{ type: 'text', text }] }).catch((err) => console.error('sendMessage failed', err));
}

function openMaps(url: string): void {
  app.openLink({ url }).catch(() => undefined);
}

function travel(t?: Any): string {
  if (!t) return '';
  return `${esc(t.minutes)} min away${t.km ? ` · ${esc(t.km)} km` : ''}`;
}

function testChip(isTest: boolean): string {
  return isTest ? `<span class="chip test" title="Doctor from DocSaathi's test UHI network">Test data</span>` : '';
}

function header(title: string, sub = '', chips = ''): string {
  return `<header class="head"><div><h1 class="title">${title}</h1>${sub ? `<p class="sub">${sub}</p>` : ''}</div><div class="chips">${chips}</div></header>`;
}

// ---------------------------------------------------------------------------

/** "Tmrw", "Today", "Fri" for a day label like "tomorrow" or "Fri 2 Oct". */
function shortDay(day: string): string {
  if (day === 'today') return 'Today';
  if (day === 'tomorrow') return 'Tmrw';
  return day.split(' ')[0];
}

/** A time chip: just "9:20 AM" on the same day as `refDay`, else "Fri 9:20 AM". */
function chipLabel(slot: Any, refDay: string): string {
  return slot.day === refDay ? slot.label : `${shortDay(slot.day)} ${slot.label}`;
}

function doctorCard(d: Any, patient: string | null, pick: boolean): string {
  const slots = (d.slots ?? []) as Any[];
  const first = slots[0];
  const forWhom = patient ? ` for ${patient}` : '';
  return `
    <article class="card${pick ? ' pick' : ''}">
      <div class="card-top"><span class="num">${esc(d.n)}</span><span class="name">${esc(d.name)}</span></div>
      <div class="meta">${esc(clean(d.clinic))}</div>
      ${d.address ? `<div class="meta addr">${esc(d.address)}</div>` : ''}
      <div class="meta">${travel(d.travel)} · ${d.experienceYears ? `${esc(d.experienceYears)} yrs` : esc(d.specialty)}</div>
      <div class="meta">${esc((d.languages ?? []).join(', '))}</div>
      <div class="row"><span class="fee">₹${esc(d.fee)}</span><span class="when">${esc(first ? `${first.day === 'today' ? '' : `${shortDay(first.day)} `}${first.label}` : '')}</span></div>
      ${first ? `<div class="actions"><button class="btn primary" data-say="${esc(`Book ${first.label} ${first.day} with ${d.name}${forWhom}`)}">Book ${esc(first.label)}</button></div>` : ''}
      <div class="links">
        <button class="link-btn" data-say="${esc(`Show more times for ${d.name}`)}">More times</button>
        ${d.directions ? `<button class="link-btn" data-open="${esc(d.directions)}">Directions</button>` : ''}
      </div>
    </article>`;
}

// ---------------------------------------------------------------------------
// Maps. The screen runs in a sandbox with no network access, so it cannot load map tiles itself.
// It asks DocSaathi's server for a map picture through the host (the app-only "get_map" tool).

interface Pin {
  lat: number;
  lng: number;
  label?: string;
}

/** A map box: H = home, numbered pins = the places. `route` draws the way to a single place. Tapping opens `link`. */
function mapBox(places: Array<{ lat?: unknown; lng?: unknown; label?: string }>, route: boolean, link?: string | null): string {
  const pins = places.filter((p): p is Pin => typeof p.lat === 'number' && typeof p.lng === 'number').slice(0, 6);
  if (pins.length === 0) return '';
  const ask = { places: pins.map((p) => ({ lat: p.lat, lng: p.lng, ...(p.label ? { label: p.label } : {}) })), route };
  return `<button class="map" data-map="${esc(JSON.stringify(ask))}"${link ? ` data-open="${esc(link)}"` : ''} aria-label="Map${link ? ': tap to open Google Maps' : ''}"><span class="map-wait"><span class="spinner"></span> Map</span></button>`;
}

/** A screen with a map beside its content (above it on narrow screens). Without a map it is just the content. */
function withMap(map: string, content: string): string {
  return map ? `<div class="split">${map}${content}</div>` : content;
}

async function loadMaps(): Promise<void> {
  for (const box of Array.from(root.querySelectorAll<HTMLElement>('.map[data-map]'))) {
    const ask = JSON.parse(box.dataset.map!) as Record<string, unknown>;
    delete box.dataset.map;
    try {
      const result = (await app.callServerTool({ name: 'get_map', arguments: ask })) as Any;
      const image = ((result.content ?? []) as Any[]).find((c) => c.type === 'image');
      if (result.isError || !image) throw new Error('no map');
      box.innerHTML = `<img alt="Map: H is your home, the pins are the clinics" src="data:${esc(image.mimeType)};base64,${esc(image.data)}"><span class="map-tag">Google Maps${box.dataset.open ? ' · tap to open' : ''}</span>`;
      box.classList.add('ready');
    } catch {
      // No map service (no Google key, or the host does not pass tool calls on): close the gap.
      box.parentElement?.classList.add('no-map');
      box.remove();
    }
  }
}

/** A phone number as a link the device can dial: "+91 20 2553 1234" -> "tel:+912025531234". */
function dial(phone: string): string {
  return `tel:${phone.replace(/[^\d+]/g, '')}`;
}

// Real clinics from Google Maps. They are not on the UHI network yet, so Alexa cannot book them:
// the family calls them, or taps for the way there.
function placeCards(list: Any[], numbered = false): string {
  return list
    .map(
      (p, i) => `
      <div class="place">
        <b title="${esc(p.name)}">${numbered ? `<span class="num">${i + 1}</span> ` : ''}${esc(p.name)}</b>
        <span class="meta">${p.rating ? `★ ${esc(p.rating)} (${esc(p.ratingCount ?? 0)}) · ` : ''}${p.openNow === true ? '<span class="open">Open now</span> · ' : p.openNow === false ? 'Closed now · ' : ''}${travel(p.travel)}</span>
        ${p.address ? `<span class="meta addr">${esc(p.address)}</span>` : ''}
        <span class="place-actions">
          ${p.phone ? `<button class="btn call" data-open="${esc(dial(p.phone))}">Call ${esc(p.phone)}</button>` : '<span class="meta">No phone listed</span>'}
          ${p.directions || p.mapsUrl ? `<button class="link" data-open="${esc(p.directions ?? p.mapsUrl)}">Directions</button>` : ''}
          ${p.share ? `<button class="link" data-open="${esc(p.share)}">Share on WhatsApp</button>` : ''}
        </span>
      </div>`,
    )
    .join('');
}

const GOOGLE_CREDIT = '<p class="attribution">Listings and travel times from Google Maps</p>';

function nearby(list: Any[]): string {
  if (!list?.length) return '';
  return `<section class="nearby"><p class="nearby-title"><span class="chip real">Real clinics</span> near you · call to book (not on UHI yet)</p><div class="nearby-list">${placeCards(list)}</div>${GOOGLE_CREDIT}</section>`;
}

/** Only real places (the family asked for a real clinic, the nearest hospital, a chemist or a lab). */
function renderNearby(d: Any, speech: string): string {
  const list = (d.places ?? []) as Any[];
  const head = header(esc(d.title ?? 'Real clinics near you'), 'Call to book · not on the UHI network yet', '<span class="chip real">Real · Google Maps</span>');
  if (!list.length) return `${head}<p class="message">${esc(speech)}</p>`;
  const map = mapBox(
    list.map((p, i) => ({ lat: p.lat, lng: p.lng, label: String(i + 1) })),
    false,
  );
  return `${head}${withMap(map, `<div class="nearby-list wide">${placeCards(list, true)}</div>`)}${GOOGLE_CREDIT}`;
}

function renderDoctors(d: Any): string {
  const doctors = (d.doctors ?? []) as Any[];
  const anyTest = doctors.some((x) => x.testData);
  const title = `${esc(d.understood?.plain ?? 'doctors').replace(/^./, (c: string) => c.toUpperCase())}s${d.patient ? ` for ${esc(d.patient)}` : ''}`;
  const sub = `${esc(d.understood?.specialty ?? '')} · ${esc(d.window?.label ?? '')}${d.understood?.words ? ` · understood “${esc(d.understood.words)}”` : ''}`;
  // The map shows where each numbered doctor's clinic is, and H for home.
  const map = mapBox(
    doctors.map((x) => ({ lat: x.lat, lng: x.lng, label: String(x.n) })),
    false,
  );
  const cards = doctors.length
    ? withMap(map, `<div class="cards">${doctors.map((x, i) => doctorCard(x, d.patient ?? null, i === 0)).join('')}</div>`)
    : '<p class="message">No free times on the UHI network for this. Try another day.</p>';
  return header(title, sub, `<span class="chip uhi">UHI network</span>${testChip(anyTest)}`) + cards + nearby(d.nearbyOnGoogle);
}

function renderTimes(d: Any): string {
  const doc = d.doctor as Any | undefined;
  const times = (d.times ?? []) as Any[];
  const byDay = new Map<string, Any[]>();
  for (const t of times) byDay.set(t.day, [...(byDay.get(t.day) ?? []), t]);
  const groups = [...byDay.entries()]
    .slice(0, 3)
    .map(
      ([day, list]) =>
        `<div><p class="sub">${esc(day)}</p><div class="times">${list
          .slice(0, 12)
          .map((t) => `<button class="time" data-say="${esc(`Book ${t.label} ${day} with ${doc?.name ?? ''}`)}">${esc(t.label)}</button>`)
          .join('')}</div></div>`,
    )
    .join('');
  const map = doc ? mapBox([{ lat: doc.lat, lng: doc.lng }], true, doc.directions) : '';
  return (
    header(`${esc(doc?.name ?? 'Free times')}`, `${esc(doc?.specialty ?? '')}${doc?.clinic ? ` · ${esc(clean(doc.clinic))}` : ''}${doc?.address ? `, ${esc(doc.address)}` : ''}`, testChip(Boolean(doc?.testData))) +
    (times.length ? withMap(map, `<section class="focus">${groups}</section>`) : '<p class="message">No free times in that window.</p>')
  );
}

function renderConfirm(d: Any): string {
  const s = d.summary as Any;
  return (
    header('Check and confirm', 'Nothing is booked until you say yes', testChip(Boolean(s.testData))) +
    withMap(
      mapBox([{ lat: s.lat, lng: s.lng }], true, s.directions),
      `<section class="focus">
      <dl class="facts">
        <dt>Patient</dt><dd>${esc(s.patient)}</dd>
        <dt>Doctor</dt><dd>${esc(s.doctor)} · ${esc(s.specialty)}</dd>
        <dt>When</dt><dd>${esc(s.when)}</dd>
        <dt>Where</dt><dd>${esc(clean(s.clinic))}, ${esc(s.address)}</dd>
        <dt>Fee</dt><dd>₹${esc(s.fee)}, pay at the clinic</dd>
        ${s.travel ? `<dt>Travel</dt><dd>${travel(s.travel)}</dd>` : ''}
      </dl>
      ${s.instructions ? `<div class="note"><b>The clinic says:</b> ${esc(s.instructions)}</div>` : ''}
      <div class="actions">
        <button class="btn primary big" data-say="Yes, book it">Book it</button>
        <button class="btn big" data-say="${esc(`Show more times for ${s.doctor}`)}">Change time</button>
        ${s.directions ? `<button class="btn big" data-open="${esc(s.directions)}">Directions</button>` : ''}
      </div>
    </section>`,
    )
  );
}

function renderBooked(d: Any): string {
  const s = d.summary as Any;
  const leave = d.leaveBy ? new Date(d.leaveBy) : null;
  const leaveText = leave
    ? leave.toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit', timeZone: 'Asia/Kolkata' }).toUpperCase()
    : '';
  const sms = ((d.messages ?? []) as Any[])
    .map((m) => `<div class="sms"><b>Sent to ${esc(m.to)}'s phone</b>${esc(m.body)}</div>`)
    .join('');
  return (
    `<div class="ok"><span class="ok-dot">✓</span> Booked</div>` +
    withMap(
      mapBox([{ lat: s.lat, lng: s.lng }], true, d.links?.directions ?? s.directions),
      `<section class="focus">
      <dl class="facts">
        <dt>Patient</dt><dd>${esc(s.patient)}</dd>
        <dt>Doctor</dt><dd>${esc(s.doctor)}</dd>
        <dt>When</dt><dd>${esc(s.when)}</dd>
        <dt>Where</dt><dd>${esc(clean(s.clinic))}${s.address ? `, ${esc(s.address)}` : ''}</dd>
        <dt>Clinic</dt><dd><span class="status new">Waiting for the clinic to accept</span></dd>
      </dl>
      ${leaveText ? `<div><p class="sub">Leave by</p><p class="big-time">${esc(leaveText)}</p><p class="sub">${travel(d.travel)}</p></div>` : ''}
      ${s.instructions ? `<div class="note"><b>Remember:</b> ${esc(s.instructions)}</div>` : ''}
      ${
        d.links
          ? `<div class="actions">
        ${d.links.directions ? `<button class="btn" data-open="${esc(d.links.directions)}">Directions</button>` : ''}
        ${d.links.calendar ? `<button class="btn" data-open="${esc(d.links.calendar)}">Add to Google Calendar</button>` : ''}
        ${d.links.whatsapp ? `<button class="btn" data-open="${esc(d.links.whatsapp)}">Share on WhatsApp</button>` : ''}
      </div>`
          : ''
      }
      ${sms}
      <p class="attribution">UHI order ${esc(d.uhiOrderId)} · ${esc(d.state)}</p>
    </section>`,
    )
  );
}

function renderUsual(d: Any): string {
  const doc = d.doctor as Any;
  const slots = (doc.slots ?? []) as Any[];
  const first = slots[0];
  const who = d.patientSpoken ?? d.patient;
  const firstLabel = first ? `${first.day === 'today' ? 'Today' : first.day === 'tomorrow' ? 'Tomorrow' : first.day}, ${first.label}` : '';
  return (
    header(`${esc(who)}'s usual doctor`, `${esc(d.patient)} · ${esc(d.lastVisit ?? '')}`, testChip(Boolean(doc.testData))) +
    `<section class="focus">
      <div class="card-top"><span class="name">${esc(doc.name)}</span></div>
      <div class="meta">${esc(doc.specialty)} · ${esc(clean(doc.clinic))} · ${travel(doc.travel)}</div>
      ${first ? `<div><p class="sub">Next free</p><p class="big-time">${esc(firstLabel)}</p></div>` : ''}
      <div class="times">${slots
        .slice(1, 6)
        .map((s) => `<button class="time" data-say="${esc(`Book ${s.label} ${s.day} with ${doc.name} for ${who}`)}">${esc(chipLabel(s, first?.day ?? ''))}</button>`)
        .join('')}</div>
      ${first ? `<div class="actions"><button class="btn primary big" data-say="${esc(`Book ${first.label} ${first.day} with ${doc.name} for ${who}`)}">Book ${esc(first.label)}</button></div>` : ''}
    </section>`
  );
}

const CLINIC_STATE: Record<string, [string, string]> = {
  new: ['new', 'Waiting for the clinic'],
  accepted: ['accepted', 'Accepted by the clinic'],
  rejected: ['rejected', "Clinic can't take it"],
};

function appointmentItem(a: Any): string {
  const [cls, label] = CLINIC_STATE[a.clinicState] ?? CLINIC_STATE.new;
  return `<li><div><b>${esc(a.patient)}</b> · ${esc(a.doctor)}<div class="meta">${esc(clean(a.clinic))}</div>
    <span class="status ${cls}">${esc(label)}${a.clinicNote ? `: ${esc(a.clinicNote)}` : ''}</span></div><span class="when">${esc(a.when)}</span></li>`;
}

function renderAppointments(d: Any): string {
  const list = (d.appointments ?? []) as Any[];
  const rejected = (d.rejected ?? []) as Any[];
  if (!list.length && !rejected.length) return header('Appointments') + '<p class="message">No upcoming appointments.</p>';
  return header('Family appointments', `${list.length} upcoming`) + `<ul class="list">${[...list, ...rejected].map(appointmentItem).join('')}</ul>`;
}

function renderReminders(d: Any): string {
  const list = (d.reminders ?? []) as Any[];
  if (!list.length) return header('Check-ups') + '<p class="message">No check-ups are due this week.</p>';
  return (
    header('Check-ups due', "From your family's follow-up memory") +
    `<ul class="list">${list
      .map(
        (r) =>
          `<li><div><b>${esc(r.patient)}</b>${r.doctor ? ` · ${esc(r.doctor)}` : ''}<div class="meta">Due ${esc(r.dueOn)}${r.note ? ` · ${esc(r.note)}` : ''}</div></div>
           <button class="btn primary" data-say="${esc(`Book ${r.patientSpoken}'s usual check-up`)}">Find a time</button></li>`,
      )
      .join('')}</ul>`
  );
}

function renderEmergency(d: Any, speech: string): string {
  const mental = d.emergencyKind === 'mental-health';
  const hospitals = (d.hospitals ?? []) as Any[];
  return `<section class="emergency${hospitals.length ? ' with-list' : ''}" role="alert">
    <p class="call">${mental ? 'Call 14416' : 'Call 112'}</p>
    <p><b>${mental ? 'Tele-MANAS: free, open day and night' : 'Ambulance: 108'}</b></p>
    <p>${esc(speech)}</p>
  </section>
  ${hospitals.length ? `<section class="nearby"><p class="nearby-title"><span class="chip real">Real hospitals</span> near you</p><div class="nearby-list">${placeCards(hospitals)}</div>${GOOGLE_CREDIT}</section>` : ''}`;
}

/** A question to the family. "Who am I speaking with?" or "Who is it for?" get a button per family member. */
function renderQuestion(d: Any, speech: string): string {
  const family = (d.family ?? []) as string[];
  if (!family.length) return renderSimple('DocSaathi', speech);
  // "Papa (Rajesh)" -> say "Main Papa hoon" when we asked who is talking, else just "Papa (Rajesh)".
  const buttons = family
    .map((label) => `<button class="btn big" data-say="${esc(d.askSpeaker ? `Main ${label.split(' (')[0]} hoon` : label)}">${esc(label)}</button>`)
    .join('');
  return `${header(d.askSpeaker ? 'Who is talking?' : 'Who is it for?')}<section class="question"><p class="message">${esc(speech)}</p><div class="actions choices">${buttons}</div></section>`;
}

function renderSimple(title: string, speech: string, extra = ''): string {
  return `${header(title)}<p class="message">${esc(speech)}</p>${extra}`;
}

function render(result: Any): void {
  const d = (result.structuredContent ?? {}) as Any;
  const speech = ((result.content ?? []) as Any[]).find((c) => c.type === 'text')?.text ?? '';
  let html: string;
  switch (d.kind) {
    case 'doctors':
      html = renderDoctors(d);
      break;
    case 'times':
      html = renderTimes(d);
      break;
    case 'confirm':
      html = renderConfirm(d);
      break;
    case 'booked':
      html = renderBooked(d);
      break;
    case 'usual':
      html = renderUsual(d);
      break;
    case 'appointments':
      html = renderAppointments(d);
      break;
    case 'reminders':
      html = renderReminders(d);
      break;
    case 'emergency':
      html = renderEmergency(d, speech);
      break;
    case 'follow-up':
      html = renderSimple('Reminder saved', speech);
      break;
    case 'cancelled':
      html = renderSimple('Cancelled', speech);
      break;
    case 'family':
      html = renderSimple('Family', speech);
      break;
    case 'family-added':
      html = renderSimple('Added to the family', speech);
      break;
    case 'location':
      html = renderSimple('Your location', speech);
      break;
    case 'nearby':
      html = renderNearby(d, speech);
      break;
    case 'question':
      html = renderQuestion(d, speech);
      break;
    default:
      html = renderSimple(d.kind === 'error' ? 'Something needs a change' : 'DocSaathi', speech);
  }
  root.innerHTML = html;
  root.scrollTop = 0;
  void loadMaps();
}

root.addEventListener('click', (event) => {
  const target = (event.target as HTMLElement).closest<HTMLElement>('[data-say],[data-open]');
  if (!target) return;
  if (target.dataset.open) openMaps(target.dataset.open);
  else if (target.dataset.say) say(target.dataset.say);
});

function applyContext(ctx: McpUiHostContext | undefined): void {
  if (ctx?.theme) applyDocumentTheme(ctx.theme);
}

app.ontoolinput = () => {
  root.innerHTML = '<div class="loading"><span class="spinner"></span> Checking the UHI network…</div>';
};
app.ontoolresult = (result) => render(result as Any);
app.ontoolcancelled = (params) => {
  root.innerHTML = renderSimple('Stopped', params.reason ?? 'That request was stopped.');
};
app.onhostcontextchanged = (ctx) => applyContext(ctx);
app.onteardown = async () => ({});
app.onerror = (err) => console.error(err);

app.connect().then(() => applyContext(app.getHostContext()));
