// DocSaathi's core: find doctors on the UHI network, hold a time, confirm it, remember it.
// Every function returns what to SAY (short, voice-first) plus DATA for the screen.
import { db, newId, nowIso } from './db.js';
import { householdById, memberLabel, membersOf, memberSpoken, resolveMember, type Household, type Member } from './family.js';
import { googleEnabled, nearbyClinics, travelTimes, type NearbyClinic, type Travel } from './google.js';
import {
  addDays,
  addMinutes,
  clock,
  DAY_WORD,
  formatDay,
  formatTime,
  istDay,
  minutesOfDay,
  parseClockTime,
  parseDurationDays,
  parseWhen,
  PART_WORD,
  relativeDay,
  speakableWhen,
  startOfIstDay,
  toIstIso,
} from './time.js';
import { cancelOrder, confirmOrder, initOrder, onProviderNews, searchDoctors, selectSlot, UhiDomainError, type DoctorOffer, type OfferSlot } from './uhi/eua.js';
import type { Order } from './uhi/types.js';
import { checkEmergency, languageFromText, LANGUAGE_NAMES, resolveSpecialty, SPECIALTIES, type SpecialtyCode } from './words.js';

export interface Reply {
  speech: string;
  data: Record<string, unknown> & { kind: string };
}

class Stop extends Error {
  /** `hospitalsFor`: a medical emergency; show this family's nearest real hospitals under "Call 112". */
  constructor(
    readonly reply: Reply,
    readonly hospitalsFor?: Household,
  ) {
    super(reply.speech);
  }
}

function say(kind: string, speech: string, data: Record<string, unknown> = {}): Reply {
  return { speech, data: { kind, ...data } };
}

/** Run a flow; `Stop` short-circuits with a friendly answer; UHI domain errors become spoken errors. */
async function run(fn: () => Promise<Reply>): Promise<Reply> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof Stop) return err.hospitalsFor ? withHospitals(err.reply, err.hospitalsFor) : err.reply;
    if (err instanceof UhiDomainError) return say('error', err.message, { code: err.uhiError.code });
    throw err;
  }
}

function guard(household: Household, ...texts: Array<string | undefined>): void {
  const emergency = checkEmergency(texts.filter(Boolean).join(' '));
  if (!emergency) return;
  const medical = emergency.kind === 'medical';
  throw new Stop(say('emergency', emergency.speech, { emergencyKind: emergency.kind, numbers: medical ? ['112', '108'] : ['14416', '112'] }), medical ? household : undefined);
}

function needMember(household: Household, text: string | undefined): Member {
  const match = resolveMember(household.id, text);
  if ('error' in match) {
    throw new Stop(say('question', match.error, { family: membersOf(household.id).map(memberLabel), ...(match.askSpeaker ? { askSpeaker: true } : {}) }));
  }
  return match.member;
}

const home = (h: Household) => ({ lat: h.home_lat, lng: h.home_lng });

// ---------------------------------------------------------------------------
// Real places near the family, from Google Maps (clinics, hospitals, pharmacies, labs).
// DocSaathi cannot book these (they are not on UHI yet): the family calls them or gets directions.

type PlaceCard = ReturnType<typeof nearbyCard>;

async function realPlaces(household: Household, query: string, limit: number): Promise<PlaceCard[]> {
  const places = await nearbyClinics(query, home(household), limit);
  const travel = places.length ? await travelTimes(home(household), places.map((p) => p.location)) : [];
  return places.map((p, i) => nearbyCard(p, travel[i])).sort((a, b) => (a.travel?.minutes ?? 99) - (b.travel?.minutes ?? 99));
}

// In an emergency "Call 112" must be said at once, so the nearest hospitals are looked up ahead
// of time (when the app starts and when the family's place changes) and kept for a few hours.
const HOSPITALS_FRESH_MS = 6 * 60 * 60_000;
const hospitalsNear = new Map<string, { at: number; where: string; places: PlaceCard[] }>();

export async function rememberHospitals(household: Household): Promise<void> {
  if (!googleEnabled()) return;
  const places = await realPlaces(household, 'hospital emergency', 3);
  hospitalsNear.set(household.id, { at: Date.now(), where: `${household.home_lat},${household.home_lng}`, places });
}

function withHospitals(reply: Reply, household: Household): Reply {
  const known = hospitalsNear.get(household.id);
  const here = `${household.home_lat},${household.home_lng}`;
  if (!known || known.where !== here || Date.now() - known.at > HOSPITALS_FRESH_MS) {
    void rememberHospitals(household).catch(() => undefined); // ready for next time
  }
  if (!known || known.where !== here || known.places.length === 0) return reply;
  return { speech: `${reply.speech} The nearest hospitals are on the screen.`, data: { ...reply.data, hospitals: known.places } };
}

const PLACE_KINDS: Array<[RegExp, string, string]> = [
  [/(hospital|aspatal|emergency room|अस्पताल)/i, 'hospital', 'hospitals'],
  [/(jan ?aushadhi|जन औषधि|generic medicine|sasti dawa)/i, 'Jan Aushadhi Kendra', 'Jan Aushadhi medicine shops (cheaper generic medicines)'],
  [/(pharmacy|chemist|medical store|medical shop|medicine shop|dawai? ki dukaan|दवा)/i, 'pharmacy', 'pharmacies'],
  [/(\blabs?\b|blood test|pathology|x-?ray|sonography|\bscan\b|जांच)/i, 'pathology lab', 'labs'],
];

/** "Dr. Amita Phadnis - Best Pediatrician in Pune | Child Clinic" -> "Dr. Amita Phadnis" (for speaking). */
export const spokenPlace = (name: string) => name.split(/\s+[-–|(:]\s*|\s*[|(]/)[0].split(' ').slice(0, 6).join(' ');

export function nearbyPlaces(householdId: string, input: { need?: string }): Promise<Reply> {
  return run(async () => {
    const household = householdById(householdId)!;
    const text = input.need ?? '';
    guard(household, text);
    if (!googleEnabled()) {
      return say('nearby', "I can't look up real clinics right now, because Google Maps is not switched on for this DocSaathi.", { title: 'Real clinics near you', places: [] });
    }
    const kind = PLACE_KINDS.find(([re]) => re.test(text));
    const spec = resolveSpecialty(text);
    const named = spec.matched !== null;
    const query = kind ? kind[1] : named ? `${SPECIALTIES[spec.code].name} clinic` : 'doctor clinic';
    const label = kind ? kind[2] : named ? `${SPECIALTIES[spec.code].plain} clinics` : 'clinics';
    const places = await realPlaces(household, query, 5);
    const title = `Real ${label} near you`;
    if (places.length === 0) {
      return say('nearby', `I couldn't find ${label} near ${household.home_address} on Google Maps.`, { title, label, places: [] });
    }
    const spoken = places.slice(0, 2).map((p) => `${spokenPlace(p.name)}, ${p.travel?.minutes ?? '?'} minutes away${p.rating ? `, rated ${p.rating}` : ''}${p.openNow ? ', open now' : ''}`);
    return say(
      'nearby',
      `Here are real ${label} near you, from Google Maps. The nearest is ${spoken[0]}.${spoken[1] ? ` Next is ${spoken[1]}.` : ''} ` +
        `I can't book these by voice yet, but their phone numbers and directions are on the screen.`,
      { title, label, places, source: 'Google Maps' },
    );
  });
}

// ---------------------------------------------------------------------------
// Last results: lets people say "the first one", "Dr. Mehta", "6:30 wala".

interface StoredOffer extends DoctorOffer {
  travel?: Travel;
}

function saveResults(householdId: string, offers: StoredOffer[]): void {
  db()
    .prepare('INSERT INTO last_results (household_id, results_json, created_at) VALUES (?, ?, ?) ON CONFLICT(household_id) DO UPDATE SET results_json = excluded.results_json, created_at = excluded.created_at')
    .run(householdId, JSON.stringify(offers), nowIso());
}

function loadResults(householdId: string): StoredOffer[] {
  const row = db().prepare('SELECT results_json FROM last_results WHERE household_id = ?').get(householdId) as { results_json: string } | undefined;
  return row ? (JSON.parse(row.results_json) as StoredOffer[]) : [];
}

const STOPWORDS = new Set([
  'the', 'for', 'with', 'and', 'book', 'show', 'more', 'times', 'time', 'please', 'today', 'tomorrow', 'wala', 'wali', 'wale',
  'aaj', 'kal', 'baje', 'this', 'that', 'one', 'can', 'you', 'ke', 'liye', 'appointment', 'clinic', 'free', 'next', 'usual',
  'morning', 'evening', 'subah', 'shaam', 'dadi', 'papa', 'mummy', 'nani', 'nana', 'dada',
]);

const ORDINALS: Array<[RegExp, number]> = [
  [/\b(1|1st|first|one|pehla|pehle|pehli|pahla|ek)\b|पहल[ाेी]/, 0],
  [/\b(2|2nd|second|two|doosra|dusra|doosre|dusre|doosri|dusri|do)\b|दूसर[ाेी]/, 1],
  [/\b(3|3rd|third|three|teesra|tisra|teesre|teesri|teen)\b|तीसर[ाेी]/, 2],
  [/\b(4|4th|fourth|four|chautha|char)\b/, 3],
  [/\b(5|5th|fifth|five|paanchva|paanch)\b/, 4],
];

function findOffer(householdId: string, ref: string | undefined): StoredOffer | undefined {
  const offers = loadResults(householdId);
  if (!offers.length || !ref) return offers.length === 1 ? offers[0] : undefined;
  const t = ref.toLowerCase().trim();
  const exact = offers.find((o) => `${o.providerId}|${o.clinic.id}|${o.doctor.id}` === ref || o.doctor.id === ref);
  if (exact) return exact;
  const words = nameWords(t);
  const byName = offers.find((o) => words.some((w) => o.doctor.name.toLowerCase().includes(w) || o.clinic.name.toLowerCase().includes(w)));
  if (byName) return byName;
  for (const [re, idx] of ORDINALS) if (re.test(t)) return offers[idx];
  return undefined;
}

function nameWords(ref: string): string[] {
  return ref
    .toLowerCase()
    .replace(/\bdr\.?\b|\bdoctor\b/g, ' ')
    .split(/[^a-zऀ-ॿ]+/)
    .filter((w) => w.length >= 3 && !STOPWORDS.has(w));
}

/** A doctor from the last list, or, if they named someone else, look that doctor up on the UHI network. */
async function resolveOffer(household: Household, ref: string | undefined): Promise<StoredOffer | undefined> {
  const found = findOffer(household.id, ref);
  if (found || !ref) return found;
  const words = nameWords(ref).filter((w) => /^[a-z]+$/.test(w));
  if (words.length === 0) return undefined;
  const from = clock.now();
  const to = addDays(startOfIstDay(from), 4);
  const needles = [...new Set([words.join(' '), ...words.filter((w) => w.length >= 4)])];
  for (const needle of needles) {
    const offers: StoredOffer[] = await searchDoctors({ doctorName: needle, from, to, slotsPerDoctor: 8 });
    if (offers.length === 0) continue;
    const travel = await travelTimes(home(household), offers.map((o) => ({ lat: o.clinic.lat ?? household.home_lat, lng: o.clinic.lng ?? household.home_lng })));
    offers.forEach((o, i) => (o.travel = travel[i]));
    const offer = offers[0];
    saveResults(household.id, [offer, ...loadResults(household.id).filter((o) => offerRef(o) !== offerRef(offer))]);
    return offer;
  }
  return undefined;
}

export function offerRef(o: DoctorOffer): string {
  return `${o.providerId}|${o.clinic.id}|${o.doctor.id}`;
}

// ---------------------------------------------------------------------------
// Addresses and links into the real world (maps, calendar, WhatsApp)

/** "Model Colony, Pune" from "Model Colony, Pune (test address)". */
const cleanAddress = (address: string) => address.replace(/\s*\(test address\)$/, '');
/** The part people say: "Model Colony". */
const areaOf = (address: string) => cleanAddress(address).split(',')[0].trim();

/** Opens Google Maps with the way there from wherever the person is. */
function directionsUrl(lat?: number | null, lng?: number | null): string | null {
  if (typeof lat !== 'number' || typeof lng !== 'number' || !Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  return `https://www.google.com/maps/dir/?api=1&destination=${lat.toFixed(6)},${lng.toFixed(6)}&travelmode=driving`;
}

/** A link that shows the place as a pin in Google Maps (good to send to someone on WhatsApp). */
function pinUrl(lat?: number | null, lng?: number | null): string | null {
  if (typeof lat !== 'number' || typeof lng !== 'number' || !Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  return `https://www.google.com/maps/search/?api=1&query=${lat.toFixed(6)},${lng.toFixed(6)}`;
}

/** Opens WhatsApp with this text ready; the family picks who to send it to. */
const whatsappUrl = (text: string) => `https://wa.me/?text=${encodeURIComponent(text)}`;

/** Puts the appointment into the family's own Google Calendar (they press Save there). */
function calendarUrl(s: HoldSummary): string {
  const compact = (iso: string) => new Date(iso).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const q = new URLSearchParams({
    action: 'TEMPLATE',
    text: `Doctor: ${s.doctor} (${s.patient})`,
    dates: `${compact(s.start)}/${compact(s.end)}`,
    details: `${s.specialty}. Fee ${s.fee} rupees, pay at the clinic.${s.instructions ? ` ${s.instructions}` : ''} Booked with DocSaathi on Alexa.`,
    location: `${s.clinic.replace(/ \(TEST\)$/, '')}, ${cleanAddress(s.address)}`,
  });
  return `https://calendar.google.com/calendar/render?${q.toString()}`;
}

// ---------------------------------------------------------------------------
// Screen cards

function doctorCard(o: StoredOffer, n: number) {
  const first = o.slots[0];
  return {
    n,
    ref: offerRef(o),
    name: o.doctor.name,
    specialty: o.doctor.specialtyName,
    gender: o.doctor.gender,
    education: o.doctor.education,
    experienceYears: o.doctor.experienceYears,
    languages: o.doctor.languages.map((l) => LANGUAGE_NAMES[l] ?? l),
    clinic: o.clinic.name,
    address: cleanAddress(o.clinic.address),
    area: areaOf(o.clinic.address),
    phone: o.clinic.phone ?? null,
    lat: o.clinic.lat ?? null,
    lng: o.clinic.lng ?? null,
    directions: directionsUrl(o.clinic.lat, o.clinic.lng),
    fee: o.fee,
    testData: o.testData,
    network: o.networkName,
    travel: o.travel,
    firstSlot: first ? { start: first.start, label: speakableWhen(new Date(first.start)) } : null,
    slots: o.slots.slice(0, 6).map((s) => ({ start: s.start, label: formatTime(new Date(s.start)), day: relativeDay(new Date(s.start)) })),
  };
}

function nearbyCard(c: NearbyClinic, travel?: Travel) {
  // Google's full address is long: keep the street and area, drop the city, PIN code and country.
  const address = c.address.split(',').slice(0, 3).join(',').trim();
  const map = c.mapsUrl ?? pinUrl(c.location.lat, c.location.lng);
  return {
    name: c.name,
    address,
    phone: c.phone,
    rating: c.rating,
    ratingCount: c.ratingCount,
    openNow: c.openNow,
    mapsUrl: c.mapsUrl,
    lat: c.location.lat,
    lng: c.location.lng,
    directions: directionsUrl(c.location.lat, c.location.lng),
    // "Send this clinic to someone": name, address, phone and the map pin, ready in WhatsApp.
    share: whatsappUrl(`${c.name}, ${address}.${c.phone ? ` Phone: ${c.phone}.` : ''}${map ? ` Map: ${map}` : ''}`),
    travel,
    source: 'Google Maps',
  };
}

// ---------------------------------------------------------------------------
// Find doctors

export interface FindInput {
  need: string;
  patient?: string;
  when?: string;
  nearHome?: boolean;
  doctorGender?: string;
  language?: string;
  maxFee?: number;
}

export function findDoctors(householdId: string, input: FindInput): Promise<Reply> {
  return run(async () => {
    const household = householdById(householdId)!;
    guard(household, input.need, input.patient);
    let member: Member | undefined;
    if (input.patient) member = needMember(household, input.patient);
    const spec = resolveSpecialty(input.need, member?.age ?? undefined);
    const window = parseWhen(input.when ?? input.need);
    const genderText = `${input.doctorGender ?? ''} ${input.need}`.toLowerCase();
    const gender = /\b(female|woman|lady|mahila|ladies)\b/.test(genderText) ? 'F' : /\b(male|man|gents)\b/.test(input.doctorGender ?? '') ? 'M' : undefined;
    // A doctor who speaks a language: said on its own, or inside the request ("Marathi bolne wale doctor").
    const language = (input.language ? (languageFromText(input.language) ?? input.language) : undefined) ?? languageFromText(input.need);
    const near = input.nearHome ?? /\b(near|nearby|close|paas|pass|nazdeek|nearest)\b/.test(input.need.toLowerCase());

    let offers: StoredOffer[] = await searchDoctors({ specialty: spec.code, from: window.from, to: window.to, gender, language, maxFee: input.maxFee });
    let widened = false;
    if (offers.length === 0) {
      // Nothing in that window: look at the next 3 days so the family still gets an answer.
      offers = await searchDoctors({ specialty: spec.code, from: clock.now(), to: addDays(startOfIstDay(clock.now()), 4), gender, language, maxFee: input.maxFee });
      widened = offers.length > 0;
    }

    const travel = await travelTimes(home(household), offers.map((o) => ({ lat: o.clinic.lat ?? household.home_lat, lng: o.clinic.lng ?? household.home_lng })));
    offers.forEach((o, i) => (o.travel = travel[i]));
    offers.sort((a, b) => {
      const ta = a.travel?.minutes ?? 99;
      const tb = b.travel?.minutes ?? 99;
      const sa = a.slots[0]?.start ?? '';
      const sb = b.slots[0]?.start ?? '';
      return near ? ta - tb || sa.localeCompare(sb) : sa.localeCompare(sb) || ta - tb;
    });
    offers = offers.slice(0, 5);
    saveResults(household.id, offers);

    const specialty = SPECIALTIES[spec.code];
    const nearbyQuery = `${specialty.name} clinic`;
    const google = googleEnabled() ? await realPlaces(household, nearbyQuery, 3) : [];

    const forWhom = member ? ` for ${memberSpoken(member)}` : '';
    const cards = offers.map((o, i) => doctorCard(o, i + 1));
    let speech: string;
    if (offers.length === 0) {
      const wish = `${gender === 'F' ? 'lady ' : gender === 'M' ? 'male ' : ''}${language ? `${LANGUAGE_NAMES[language] ?? language}-speaking ` : ''}`;
      speech = `I couldn't find a ${wish}${specialty.plain}${forWhom} with free time ${window.label} on the UHI network.`;
      speech += google.length ? ` I found ${google.length} clinics near you on Google Maps that you can call.` : ' Try another day or time.';
    } else {
      const top = offers.slice(0, 3).map((o, i) => {
        const first = o.slots[0] ? speakableWhen(new Date(o.slots[0].start)) : '';
        const area = areaOf(o.clinic.address);
        return `${i + 1}: ${o.doctor.name}${area ? ` in ${area}` : ''}, ${o.travel?.minutes ?? '?'} minutes away, free ${first}, fee ${o.fee} rupees`;
      });
      speech =
        `${widened ? `Nothing free ${window.label}, but here are the next free times. ` : ''}` +
        `I found ${offers.length} ${offers.length === 1 ? specialty.plain : `${specialty.plain}s`}${forWhom}. ${top.join('. ')}. ` +
        `${offers.length > 3 ? 'The others are on the screen. ' : ''}` +
        `${google.length ? `I've also put ${google.length === 1 ? 'a real clinic' : `${google.length} real clinics`} near you on the screen, to call. ` : ''}` +
        `Which one should I book?`;
    }
    return say('doctors', speech, {
      need: input.need,
      understood: { specialty: specialty.name, plain: specialty.plain, words: spec.matched, reason: spec.reason },
      window: { label: widened ? 'next 3 days' : window.label, from: toIstIso(window.from), to: toIstIso(window.to) },
      patient: member ? memberLabel(member) : null,
      doctors: cards,
      nearbyOnGoogle: google,
      source: 'UHI network',
    });
  });
}

// ---------------------------------------------------------------------------
// More times for one doctor

async function refreshOffer(offer: StoredOffer, from: Date, to: Date): Promise<StoredOffer | undefined> {
  const found = await searchDoctors({ doctorId: offer.doctor.id, from, to, slotsPerDoctor: 40 });
  const fresh = found.find((o) => o.doctor.id === offer.doctor.id && o.clinic.id === offer.clinic.id);
  return fresh ? { ...fresh, travel: offer.travel } : undefined;
}

export function doctorTimes(householdId: string, input: { doctor: string; when?: string }): Promise<Reply> {
  return run(async () => {
    const offer = await resolveOffer(householdById(householdId)!, input.doctor);
    if (!offer) throw new Stop(say('question', `I couldn't find ${input.doctor} on the network. Say the number from the list, or ask me to find doctors.`));
    const window = parseWhen(input.when);
    let fresh = await refreshOffer(offer, window.from, window.to);
    let widened = false;
    if (!fresh || fresh.slots.length === 0) {
      // Nothing in that window (for example "this evening", asked late at night): the next 3 days, as find_doctors does.
      const later = await refreshOffer(offer, clock.now(), addDays(startOfIstDay(clock.now()), 4));
      if (later && later.slots.length > 0) {
        fresh = later;
        widened = true;
      }
    }
    if (!fresh || fresh.slots.length === 0) {
      return say('times', `${offer.doctor.name} has no free time ${window.label}. Should I look at another day?`, { doctor: doctorCard(offer, 1), times: [] });
    }
    const others = loadResults(householdId).map((o) => (offerRef(o) === offerRef(offer) ? fresh : o));
    saveResults(householdId, others);
    const byDay = new Map<string, string[]>();
    for (const s of fresh.slots) {
      const d = relativeDay(new Date(s.start));
      byDay.set(d, [...(byDay.get(d) ?? []), formatTime(new Date(s.start))]);
    }
    const spoken = [...byDay.entries()].slice(0, 2).map(([d, times]) => `${d} at ${times.slice(0, 4).join(', ')}`).join('; ');
    return say('times', `${widened ? `Nothing free ${window.label}. ` : ''}${fresh.doctor.name} is free ${spoken}. Which time should I book?`, {
      doctor: doctorCard(fresh, 1),
      times: fresh.slots.slice(0, 24).map((s) => ({ start: s.start, label: formatTime(new Date(s.start)), day: relativeDay(new Date(s.start)) })),
    });
  });
}

// ---------------------------------------------------------------------------
// Book (hold) and confirm

async function pickSlot(offer: StoredOffer, timeText: string | undefined): Promise<{ offer: StoredOffer; slot: OfferSlot }> {
  if (!timeText) return { offer, slot: offer.slots[0] };
  const exact = offer.slots.find((s) => s.start === timeText || s.fulfillmentId === timeText);
  if (exact) return { offer, slot: exact };

  // An exact timestamp (from a screen or an AI) or everyday words like "6:30 wala", "kal 10 baje".
  const isoMatch = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(timeText) ? new Date(timeText) : undefined;
  const at = isoMatch && !Number.isNaN(isoMatch.getTime()) ? isoMatch : undefined;
  const wanted = at ? minutesOfDay(at) : parseClockTime(timeText);
  const hasDay = Boolean(at) || DAY_WORD.test(timeText);
  const dayStart = at ? startOfIstDay(at) : hasDay ? startOfIstDay(parseWhen(timeText).from) : undefined;
  const matches = (o: StoredOffer) =>
    o.slots.find((s) => {
      const d = new Date(s.start);
      const dayOk = !dayStart || (d >= dayStart && d < addDays(dayStart, 1));
      return dayOk && (wanted === undefined || minutesOfDay(d) === wanted);
    });
  const direct = matches(offer);
  if (direct) return { offer, slot: direct };

  // Not in the short list: ask the clinic for that day's full list (or the next 3 days).
  const refreshFrom = dayStart && dayStart > clock.now() ? dayStart : clock.now();
  const fresh = await refreshOffer(offer, refreshFrom, addDays(startOfIstDay(refreshFrom), dayStart ? 1 : 3));
  const found = fresh && matches(fresh);
  if (fresh && found) return { offer: fresh, slot: found };
  const options = (fresh ?? offer).slots.slice(0, 4).map((s) => speakableWhen(new Date(s.start)));
  throw new Stop(say('question', `${offer.doctor.name} isn't free at ${timeText}. Free times: ${options.join(', ')}. Which one?`, { doctor: doctorCard(fresh ?? offer, 1) }));
}

interface HoldSummary {
  patient: string;
  patientSpoken: string;
  doctor: string;
  specialty: string;
  clinic: string;
  address: string;
  start: string;
  end: string;
  when: string;
  fee: number;
  instructions: string | null;
  clinicPhone: string | null;
  testData: boolean;
  travel?: Travel;
  lat?: number | null;
  lng?: number | null;
  directions?: string | null;
  replaces?: string | null;
}

export interface BookInput {
  doctor: string;
  time?: string;
  patient?: string;
  replacesAppointment?: string;
}

export function bookAppointment(householdId: string, input: BookInput): Promise<Reply> {
  return run(async () => {
    const household = householdById(householdId)!;
    guard(household, input.patient, input.doctor);
    const member = needMember(household, input.patient);
    const offer0 = await resolveOffer(household, input.doctor);
    if (!offer0) throw new Stop(say('question', `Which doctor? Say the number or the name from the list, or ask me to find doctors first.`));
    const { offer, slot } = await pickSlot(offer0, input.time);

    // UHI: select (is it still free? what is the price?), then init (hold it for 5 minutes).
    await selectSlot(offer, slot);
    const payer = membersOf(household.id).find((m) => m.notify && m.phone) ?? membersOf(household.id).find((m) => m.phone);
    const order = await initOrder(
      offer,
      slot,
      { name: `${member.name} (${household.name.replace(/ \(demo\)$/, '')})`, gender: member.gender ?? undefined },
      { name: payer?.name ?? member.name, phone: payer?.phone ?? '+91 00000 00000' },
    );

    const start = new Date(slot.start);
    const summary: HoldSummary = {
      patient: memberLabel(member),
      patientSpoken: memberSpoken(member),
      doctor: offer.doctor.name,
      specialty: offer.doctor.specialtyName,
      clinic: offer.clinic.name,
      address: cleanAddress(offer.clinic.address),
      start: slot.start,
      end: slot.end,
      when: speakableWhen(start),
      fee: Number(order.quote?.price.value ?? offer.fee),
      instructions: order.fulfillment?.start?.instructions?.short_desc ?? null,
      clinicPhone: offer.clinic.phone ?? null,
      testData: offer.testData,
      travel: offer.travel,
      lat: offer.clinic.lat ?? null,
      lng: offer.clinic.lng ?? null,
      directions: directionsUrl(offer.clinic.lat, offer.clinic.lng),
      replaces: input.replacesAppointment ?? null,
    };
    const holdId = newId('hold');
    const expires = addMinutes(clock.now(), 5);
    db()
      .prepare(
        `INSERT INTO holds (id, household_id, member_id, transaction_id, provider_id, provider_uri, order_json, summary_json, replaces_appointment_id, expires_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(holdId, household.id, member.id, offer.transactionId, offer.providerId, offer.providerUri, JSON.stringify(order), JSON.stringify(summary), input.replacesAppointment ?? null, expires.toISOString(), nowIso());

    const speech =
      `${summary.patientSpoken} with ${summary.doctor} ${summary.when}, ${summary.fee} rupees at ${summary.clinic.replace(/ \(TEST\)$/, '')} in ${areaOf(summary.address)}. ` +
      `${summary.instructions ? `The clinic says: ${summary.instructions} ` : ''}Shall I book it?`;
    return say('confirm', speech, { holdId, expiresAt: toIstIso(expires), summary });
  });
}

export function confirmAppointment(householdId: string, input: { holdId?: string }): Promise<Reply> {
  return run(async () => {
    const household = householdById(householdId)!;
    const row = (
      input.holdId
        ? db().prepare('SELECT * FROM holds WHERE id = ? AND household_id = ?').get(input.holdId, household.id)
        : db().prepare('SELECT * FROM holds WHERE household_id = ? ORDER BY created_at DESC LIMIT 1').get(household.id)
    ) as
      | { id: string; member_id: string; transaction_id: string; provider_id: string; provider_uri: string; order_json: string; summary_json: string; replaces_appointment_id: string | null; expires_at: string }
      | undefined;
    if (!row) throw new Stop(say('question', 'There is nothing waiting to be booked. Which doctor and time would you like?'));
    if (new Date(row.expires_at) <= clock.now()) {
      db().prepare('DELETE FROM holds WHERE id = ?').run(row.id);
      throw new Stop(say('error', 'That time was held for 5 minutes and the hold has run out. Shall I check the times again?'));
    }
    const summary = JSON.parse(row.summary_json) as HoldSummary;
    const confirmed: Order = await confirmOrder({ id: row.provider_id, uri: row.provider_uri }, row.transaction_id, JSON.parse(row.order_json) as Order);
    db().prepare('DELETE FROM holds WHERE id = ?').run(row.id);

    const loc = confirmed.provider?.locations?.[0];
    const [lat, lng] = (loc?.gps ?? '').split(',').map(Number);
    const appointmentId = newId('apt');
    const spec = Object.values(SPECIALTIES).find((s) => s.name === summary.specialty)?.code ?? 'GENERAL_MEDICINE';
    db()
      .prepare(
        `INSERT INTO appointments (id, household_id, member_id, transaction_id, order_id, provider_id, provider_uri, doctor_id, doctor_name, specialty,
           clinic_name, clinic_address, clinic_lat, clinic_lng, clinic_phone, start_at, end_at, fee, instructions, status, test_data, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'confirmed', ?, ?, ?)`,
      )
      .run(
        appointmentId, household.id, row.member_id, row.transaction_id, confirmed.id ?? '', row.provider_id, row.provider_uri,
        confirmed.fulfillment?.agent?.id ?? '', summary.doctor, spec, summary.clinic, summary.address,
        Number.isFinite(lat) ? lat : null, Number.isFinite(lng) ? lng : null, summary.clinicPhone, summary.start, summary.end,
        summary.fee, summary.instructions, summary.testData ? 1 : 0, nowIso(), nowIso(),
      );

    // Reschedule: release the old appointment only after the new one is confirmed.
    let replacedNote = '';
    if (row.replaces_appointment_id) {
      const old = await cancelStored(household.id, row.replaces_appointment_id);
      if (old) replacedNote = ` I've cancelled the old time, ${speakableWhen(new Date(old.start_at))}.`;
    }

    // Follow-up memory: a matching open follow-up is now booked.
    db()
      .prepare("UPDATE follow_ups SET status = 'booked' WHERE household_id = ? AND member_id = ? AND status = 'open' AND (specialty = ? OR doctor_name = ?)")
      .run(household.id, row.member_id, spec, summary.doctor);

    // Leave-by time: travel time + 10 minutes to reach early.
    const start = new Date(summary.start);
    const travel = summary.travel ?? (await travelTimes(home(household), [{ lat: lat || household.home_lat, lng: lng || household.home_lng }]))[0];
    const leaveBy = addMinutes(start, -(travel.minutes + 10));
    const leaveText = leaveBy <= clock.now() ? 'Please leave now' : `Please leave by ${formatTime(leaveBy)}`;

    // Tell the family (demo message; a real deployment would send SMS/WhatsApp here).
    const member = membersOf(household.id).find((m) => m.id === row.member_id)!;
    const notify = membersOf(household.id).filter((m) => m.notify && m.id !== member.id);
    const text = `DocSaathi: ${memberLabel(member)} is booked with ${summary.doctor}, ${summary.when}, at ${summary.clinic}, ${summary.address}. Fee ${summary.fee} rupees. ${leaveText}.`;
    for (const m of notify) {
      db()
        .prepare('INSERT INTO family_messages (id, household_id, to_member_id, to_label, body, created_at) VALUES (?, ?, ?, ?, ?, ?)')
        .run(newId('msg'), household.id, m.id, memberLabel(m), text, nowIso());
    }
    const toWhom = notify.map((m) => `${memberSpoken(m)}'s phone`).join(' and ');

    const speech =
      `Done! ${summary.patientSpoken === 'you' ? 'You are' : `${summary.patientSpoken} is`} booked with ${summary.doctor} ${summary.when}. ` +
      `${leaveText}, it's about ${travel.minutes} minutes away.${toWhom ? ` I've sent the details to ${toWhom}.` : ''}${replacedNote}` +
      ` I'll tell you when the clinic accepts it.`;
    return say('booked', speech, {
      clinicState: 'new',
      appointmentId,
      uhiOrderId: confirmed.id,
      state: confirmed.state,
      summary,
      leaveBy: toIstIso(leaveBy),
      travel,
      messages: notify.map((m) => ({ to: memberLabel(m), body: text })),
      // Real-world next steps, one tap each: the way there, their own calendar, a message to anyone.
      links: {
        directions: summary.directions ?? directionsUrl(lat, lng),
        calendar: calendarUrl(summary),
        // The message plus the clinic's pin on the map, so whoever gets it can tap and see where it is.
        whatsapp: whatsappUrl(`${text}${pinUrl(lat, lng) ? ` Map: ${pinUrl(lat, lng)}` : ''}`),
      },
    });
  });
}

// ---------------------------------------------------------------------------
// Appointments: list and cancel

interface AppointmentRow {
  id: string;
  member_id: string;
  provider_id: string;
  provider_uri: string;
  transaction_id: string;
  order_id: string;
  doctor_id: string;
  doctor_name: string;
  specialty: SpecialtyCode;
  clinic_name: string;
  clinic_address: string;
  start_at: string;
  fee: number;
  instructions: string | null;
  status: string;
  test_data: number;
  clinic_state: 'new' | 'accepted' | 'rejected';
  clinic_note: string | null;
}

// ---------------------------------------------------------------------------
// The clinic's answer. The clinic desk accepts a booking or says it cannot take it; its system
// tells DocSaathi with an unsolicited UHI on_status. We update the family's appointment, message
// the family, and leave a notice that Alexa says by herself.

function applyClinicNews(body: { context: { provider_id?: string }; message: unknown }): void {
  const order = (body.message as { order?: Order }).order;
  const code = order?.fulfillment?.state?.descriptor?.code;
  if (!order?.id || (code !== 'ACCEPTED' && code !== 'REJECTED')) return;
  const row = db()
    .prepare('SELECT * FROM appointments WHERE order_id = ? AND provider_id = ?')
    .get(order.id, body.context.provider_id ?? '') as unknown as (AppointmentRow & { household_id: string }) | undefined;
  if (!row || row.clinic_state === (code === 'ACCEPTED' ? 'accepted' : 'rejected')) return;
  const note = order.fulfillment?.state?.descriptor?.short_desc ?? null;
  if (code === 'ACCEPTED') {
    db().prepare("UPDATE appointments SET clinic_state = 'accepted', updated_at = ? WHERE id = ?").run(nowIso(), row.id);
  } else {
    db().prepare("UPDATE appointments SET clinic_state = 'rejected', clinic_note = ?, status = 'cancelled', updated_at = ? WHERE id = ?").run(note, nowIso(), row.id);
    // Tell the family members who get messages, like for a booking.
    const members = membersOf(row.household_id);
    const patient = members.find((m) => m.id === row.member_id);
    const text = `DocSaathi: ${row.clinic_name} cannot take ${patient ? memberLabel(patient) : 'the'} appointment with ${row.doctor_name}, ${speakableWhen(new Date(row.start_at))}${note ? ` (${note})` : ''}. Ask Alexa for another time.`;
    for (const m of members.filter((x) => x.notify)) {
      db().prepare('INSERT INTO family_messages (id, household_id, to_member_id, to_label, body, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(newId('msg'), row.household_id, m.id, memberLabel(m), text, nowIso());
    }
  }
  db()
    .prepare('INSERT INTO notices (id, household_id, kind, appointment_id, note, delivered, created_at) VALUES (?, ?, ?, ?, ?, 0, ?)')
    .run(newId('ntc'), row.household_id, code === 'ACCEPTED' ? 'clinic-accepted' : 'clinic-rejected', row.id, note, nowIso());
}
onProviderNews(applyClinicNews);

export interface Notice {
  kind: 'clinic-accepted' | 'clinic-rejected';
  patient: string; // label, e.g. "Dadi (Kamla)"
  patientSpoken: string;
  doctor: string;
  clinic: string;
  specialty: SpecialtyCode;
  start: string;
  note: string | null;
  speech: string; // English
}

/** News not yet said to the family (each one only once). */
export function takeNotices(householdId: string): Notice[] {
  const rows = db()
    .prepare(
      `SELECT n.id, n.kind, n.note, a.member_id, a.doctor_name, a.clinic_name, a.specialty, a.start_at
       FROM notices n JOIN appointments a ON a.id = n.appointment_id WHERE n.household_id = ? AND n.delivered = 0 ORDER BY n.created_at`,
    )
    .all(householdId) as Array<{ id: string; kind: Notice['kind']; note: string | null; member_id: string; doctor_name: string; clinic_name: string; specialty: SpecialtyCode; start_at: string }>;
  const members = membersOf(householdId);
  const done = db().prepare('UPDATE notices SET delivered = 1 WHERE id = ?');
  return rows.map((r) => {
    done.run(r.id);
    const m = members.find((x) => x.id === r.member_id);
    const who = m ? memberSpoken(m) : 'your family member';
    const clinic = r.clinic_name.replace(/ \(TEST\)$/, '');
    const when = speakableWhen(new Date(r.start_at));
    const speech =
      r.kind === 'clinic-accepted'
        ? `Good news. ${clinic} has accepted ${who === 'you' ? 'your' : `${who}'s`} appointment with ${r.doctor_name} ${when}.`
        : `A message from ${clinic}: they cannot take ${who === 'you' ? 'your' : `${who}'s`} appointment with ${r.doctor_name} ${when}${r.note ? `. They said: ${r.note}` : ''}. Shall I find another time?`;
    return { kind: r.kind, patient: m ? memberLabel(m) : '', patientSpoken: who, doctor: r.doctor_name, clinic, specialty: r.specialty, start: r.start_at, note: r.note, speech };
  });
}

function upcoming(householdId: string, memberId?: string): AppointmentRow[] {
  const since = addMinutes(clock.now(), -60).toISOString();
  const rows = db()
    .prepare("SELECT * FROM appointments WHERE household_id = ? AND status = 'confirmed' ORDER BY start_at")
    .all(householdId) as unknown as AppointmentRow[];
  return rows.filter((r) => new Date(r.start_at).toISOString() >= since && (!memberId || r.member_id === memberId));
}

function appointmentCard(r: AppointmentRow, members: Member[]) {
  const m = members.find((x) => x.id === r.member_id);
  return {
    id: r.id,
    patient: m ? memberLabel(m) : '',
    doctor: r.doctor_name,
    specialty: SPECIALTIES[r.specialty]?.name ?? r.specialty,
    clinic: r.clinic_name,
    address: r.clinic_address,
    start: r.start_at,
    when: speakableWhen(new Date(r.start_at)),
    fee: r.fee,
    instructions: r.instructions,
    testData: r.test_data === 1,
    clinicState: r.clinic_state, // 'new' = waiting for the clinic, 'accepted', 'rejected'
    clinicNote: r.clinic_note,
  };
}

const CLINIC_STATE_SPOKEN: Record<string, string> = { new: 'waiting for the clinic to accept', accepted: 'accepted by the clinic', rejected: 'not accepted by the clinic' };

export function myAppointments(householdId: string, input: { patient?: string }): Promise<Reply> {
  return run(async () => {
    const household = householdById(householdId)!;
    const member = input.patient ? needMember(household, input.patient) : undefined;
    const members = membersOf(household.id);
    const rows = upcoming(household.id, member?.id);
    if (rows.length === 0) {
      return say('appointments', `${member ? `${memberSpoken(member)} has` : 'Your family has'} no upcoming doctor appointments.`, { appointments: [] });
    }
    const spoken = rows.slice(0, 3).map((r) => {
      const m = members.find((x) => x.id === r.member_id)!;
      return `${memberSpoken(m)} with ${r.doctor_name} ${speakableWhen(new Date(r.start_at))}, ${CLINIC_STATE_SPOKEN[r.clinic_state] ?? ''}`;
    });
    // Also the ones a clinic could not take in the last two days, so nobody is surprised.
    const since = addDays(clock.now(), -2).toISOString();
    const rejected = (
      db().prepare("SELECT * FROM appointments WHERE household_id = ? AND clinic_state = 'rejected' AND updated_at >= ?").all(household.id, since) as unknown as AppointmentRow[]
    ).filter((r) => !member || r.member_id === member.id);
    return say('appointments', `${rows.length === 1 ? 'One appointment' : `${rows.length} appointments`}: ${spoken.join('; ')}.`, {
      appointments: rows.map((r) => appointmentCard(r, members)),
      rejected: rejected.map((r) => appointmentCard(r, members)),
    });
  });
}

async function cancelStored(householdId: string, appointmentId: string): Promise<AppointmentRow | undefined> {
  const row = db().prepare('SELECT * FROM appointments WHERE id = ? AND household_id = ?').get(appointmentId, householdId) as unknown as AppointmentRow | undefined;
  if (!row || row.status !== 'confirmed') return undefined;
  await cancelOrder({ id: row.provider_id, uri: row.provider_uri }, row.transaction_id, row.order_id);
  db().prepare("UPDATE appointments SET status = 'cancelled', updated_at = ? WHERE id = ?").run(nowIso(), row.id);
  return row;
}

function findAppointment(householdId: string, ref: string | undefined): AppointmentRow | undefined {
  const rows = upcoming(householdId);
  if (!ref) return rows.length === 1 ? rows[0] : undefined;
  const byId = rows.find((r) => r.id === ref);
  if (byId) return byId;
  const t = ref.toLowerCase();
  const match = resolveMember(householdId, ref);
  const member = 'member' in match ? match.member : undefined;
  const byDoctor = rows.find((r) => t.split(/\s+/).some((w) => w.length >= 3 && w !== 'appointment' && r.doctor_name.toLowerCase().includes(w)));
  if (byDoctor && !member) return byDoctor;
  if (member) return rows.find((r) => r.member_id === member.id && (!byDoctor || r.id === byDoctor.id));
  for (const [re, idx] of ORDINALS) if (re.test(t)) return rows[idx];
  return undefined;
}

export function cancelAppointment(householdId: string, input: { appointment?: string }): Promise<Reply> {
  return run(async () => {
    const household = householdById(householdId)!;
    const row = findAppointment(household.id, input.appointment);
    if (!row) throw new Stop(say('question', 'Which appointment should I cancel? Say whose it is or the doctor’s name.'));
    await cancelStored(household.id, row.id);
    const m = membersOf(household.id).find((x) => x.id === row.member_id)!;
    return say('cancelled', `Cancelled ${memberSpoken(m)}'s appointment with ${row.doctor_name} ${speakableWhen(new Date(row.start_at))}. The clinic has been told.`, {
      appointmentId: row.id,
      patient: memberLabel(m),
      doctor: row.doctor_name,
      start: row.start_at,
    });
  });
}

export function prepareReschedule(householdId: string, input: { appointment?: string; when?: string }): Promise<Reply> {
  return run(async () => {
    const household = householdById(householdId)!;
    const row = findAppointment(household.id, input.appointment);
    if (!row) throw new Stop(say('question', 'Which appointment should I move? Say whose it is or the doctor’s name.'));
    const window = parseWhen(input.when);
    const found = await searchDoctors({ doctorId: row.doctor_id, from: window.from, to: window.to, slotsPerDoctor: 12 });
    if (found.length === 0) {
      return say('times', `${row.doctor_name} has no other free time ${window.label}. Should I look at another day?`, { appointmentId: row.id, times: [] });
    }
    saveResults(household.id, found);
    const offer = found[0];
    const times = offer.slots.slice(0, 4).map((s) => speakableWhen(new Date(s.start)));
    return say('times', `${row.doctor_name} is free ${times.join(', ')}. Which new time? I'll keep the old one until the new one is booked.`, {
      appointmentId: row.id,
      replacesAppointment: row.id,
      doctor: doctorCard(offer, 1),
      times: offer.slots.slice(0, 24).map((s) => ({ start: s.start, label: formatTime(new Date(s.start)), day: relativeDay(new Date(s.start)) })),
    });
  });
}

// ---------------------------------------------------------------------------
// Memory: usual doctor and follow-ups

export function findUsualDoctor(householdId: string, input: { patient?: string; need?: string; when?: string }): Promise<Reply> {
  return run(async () => {
    const household = householdById(householdId)!;
    guard(household, input.need, input.patient);
    const member = needMember(household, input.patient);
    const rows = db()
      .prepare("SELECT * FROM appointments WHERE household_id = ? AND member_id = ? AND status IN ('confirmed','completed') ORDER BY start_at DESC")
      .all(household.id, member.id) as unknown as AppointmentRow[];
    const spec = input.need ? resolveSpecialty(input.need, member.age ?? undefined) : undefined;
    const last = rows.find((r) => !spec || spec.reason === 'default' || r.specialty === spec.code) ?? rows[0];
    if (!last) {
      return say('question', `I don't have any past visits for ${memberSpoken(member)} yet. What kind of doctor do you need?`, { patient: memberLabel(member) });
    }
    const window = parseWhen(input.when ?? (input.need && (DAY_WORD.test(input.need) || PART_WORD.test(input.need)) ? input.need : undefined));
    const to = input.when || input.need ? window.to : addDays(startOfIstDay(clock.now()), 7);
    let offers: StoredOffer[] = await searchDoctors({ doctorId: last.doctor_id, from: window.from, to, slotsPerDoctor: 8 });
    if (offers.length === 0) offers = await searchDoctors({ doctorId: last.doctor_id, from: clock.now(), to: addDays(startOfIstDay(clock.now()), 7), slotsPerDoctor: 8 });
    if (offers.length === 0) {
      return say('question', `${last.doctor_name} has no free time this week. Should I find another ${SPECIALTIES[last.specialty]?.plain ?? 'doctor'}?`, { patient: memberLabel(member) });
    }
    const travel = await travelTimes(home(household), offers.map((o) => ({ lat: o.clinic.lat ?? household.home_lat, lng: o.clinic.lng ?? household.home_lng })));
    offers.forEach((o, i) => (o.travel = travel[i]));
    saveResults(household.id, offers);
    const offer = offers[0];
    const first = offer.slots[0];
    const lastVisit = `last visit ${formatDay(new Date(last.start_at))}`;
    return say(
      'usual',
      `${memberSpoken(member)} usually sees ${last.doctor_name}, the ${SPECIALTIES[last.specialty]?.plain ?? 'doctor'}. ` +
        `${speakableWhen(new Date(first.start)).replace(/^./, (c) => c.toUpperCase())} is free. Shall I book it?`,
      { patient: memberLabel(member), patientSpoken: memberSpoken(member), lastVisit, lastVisitDate: last.start_at, doctor: doctorCard(offer, 1) },
    );
  });
}

export function rememberFollowUp(householdId: string, input: { patient?: string; after: string; doctor?: string; note?: string }): Promise<Reply> {
  return run(async () => {
    const household = householdById(householdId)!;
    const member = needMember(household, input.patient);
    const days = parseDurationDays(input.after);
    if (!days) throw new Stop(say('question', 'After how long? For example: 2 weeks or 3 months.'));
    const last = db()
      .prepare("SELECT * FROM appointments WHERE household_id = ? AND member_id = ? AND status IN ('confirmed','completed') ORDER BY start_at DESC LIMIT 1")
      .get(household.id, member.id) as unknown as AppointmentRow | undefined;
    const doctorName = input.doctor ?? last?.doctor_name ?? null;
    const specialty = last?.specialty ?? null;
    const due = addDays(startOfIstDay(clock.now()), days);
    db()
      .prepare("INSERT INTO follow_ups (id, household_id, member_id, doctor_id, doctor_name, specialty, due_on, note, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'open', ?)")
      .run(newId('fu'), household.id, member.id, last?.doctor_id ?? null, doctorName, specialty, istDay(due), input.note ?? null, nowIso());
    return say(
      'follow-up',
      `Okay. I'll remind you when ${memberSpoken(member)}'s check-up${doctorName ? ` with ${doctorName}` : ''} is due, around ${formatDay(due)}.`,
      { patient: memberLabel(member), doctor: doctorName, dueOn: istDay(due) },
    );
  });
}

export function checkReminders(householdId: string): Promise<Reply> {
  return run(async () => {
    const household = householdById(householdId)!;
    const soon = istDay(addDays(clock.now(), 7));
    const rows = db()
      .prepare("SELECT * FROM follow_ups WHERE household_id = ? AND status = 'open' AND due_on <= ? ORDER BY due_on")
      .all(household.id, soon) as Array<{ id: string; member_id: string; doctor_name: string | null; specialty: string | null; due_on: string; note: string | null }>;
    if (rows.length === 0) return say('reminders', 'No check-ups are due this week.', { reminders: [] });
    const members = membersOf(household.id);
    const items = rows.map((r) => {
      const m = members.find((x) => x.id === r.member_id)!;
      return { id: r.id, patient: memberLabel(m), patientSpoken: memberSpoken(m), doctor: r.doctor_name, specialty: r.specialty, dueOn: r.due_on, note: r.note };
    });
    const first = items[0];
    return say(
      'reminders',
      `${first.patientSpoken}'s check-up${first.doctor ? ` with ${first.doctor}` : ''} is due${first.dueOn <= istDay(clock.now()) ? ' now' : ` on ${formatDay(new Date(`${first.dueOn}T00:00:00+05:30`))}`}. Shall I find a time?` +
        (items.length > 1 ? ` ${items.length - 1} more check-up${items.length > 2 ? 's are' : ' is'} due soon.` : ''),
      { reminders: items },
    );
  });
}

export function familyList(householdId: string): Reply {
  const members = membersOf(householdId);
  return say('family', `Your family: ${members.map(memberLabel).join(', ')}.`, {
    members: members.map((m) => ({ id: m.id, name: m.name, relation: m.relation, label: memberLabel(m), age: m.age, gender: m.gender, getsMessages: Boolean(m.notify) })),
  });
}
