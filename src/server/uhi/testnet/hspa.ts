// Test Health Service Provider Application (HSPA) nodes for the local UHI network.
// Each node answers the UHI core actions for its clinics and signs every callback.
import { Router, type Response } from 'express';
import { config } from '../../config.js';
import { db, newId, nowIso } from '../../db.js';
import { addMinutes, clock, toIstIso } from '../../time.js';
import { SPECIALTIES, type SpecialtyCode } from '../../words.js';
import { publicBaseUrl, signingKey, TEST_HSPA_IDS, UHI_CITY } from '../registry.js';
import { afterAck, postSigned, readSigned, type RawBodyRequest } from '../transport.js';
import {
  ACK,
  nack,
  TAG,
  UHI_CORE_VERSION,
  UHI_COUNTRY,
  UHI_DOMAIN,
  type Catalog,
  type Fulfillment,
  type Intent,
  type Item,
  type Order,
  type Provider,
  type UhiAction,
  type UhiContext,
  type UhiError,
  type UhiRequest,
} from '../types.js';
import { freeSlots, type Slot, type WeeklySchedule } from './slots.js';

const HOLD_MINUTES = 5;
const HSPA_NAMES: Record<string, string> = {
  'citycare-test-hspa': 'CityCare Clinics (TEST network)',
  'healthfirst-test-hspa': 'HealthFirst Clinics (TEST network)',
};

interface DoctorRow {
  id: string;
  hspa_id: string;
  clinic_id: string;
  name: string;
  gender: string;
  specialty: SpecialtyCode;
  education: string;
  experience_years: number;
  languages: string;
  fee: number;
  slot_minutes: number;
  schedule_json: string;
  instructions: string | null;
}

interface ClinicRow {
  id: string;
  hspa_id: string;
  name: string;
  address: string;
  lat: number;
  lng: number;
  phone: string;
}

interface BookingRow {
  id: string;
  hspa_id: string;
  doctor_id: string;
  transaction_id: string;
  patient_name: string;
  patient_phone: string | null;
  start_at: string;
  end_at: string;
  status: 'held' | 'confirmed' | 'cancelled';
  hold_expires_at: string | null;
  clinic_state: 'new' | 'accepted' | 'rejected'; // what the clinic's desk decided
  clinic_note: string | null;
  context_json: string | null; // who booked (their app's address), to tell them about the decision
  created_at: string;
}

/** The clinic desk's decision, as it travels in a UHI order (fulfillment.state). */
function deskState(booking: Pick<BookingRow, 'clinic_state' | 'clinic_note'>): Fulfillment['state'] | undefined {
  if (booking.clinic_state === 'accepted') return { descriptor: { code: 'ACCEPTED', name: 'Accepted by the clinic' }, updated_at: new Date().toISOString() };
  if (booking.clinic_state === 'rejected') return { descriptor: { code: 'REJECTED', name: 'Not accepted by the clinic', short_desc: booking.clinic_note ?? undefined }, updated_at: new Date().toISOString() };
  return undefined;
}

function takenRanges(doctorId: string, now: Date) {
  const rows = db()
    .prepare("SELECT start_at, end_at, status, hold_expires_at FROM hspa_bookings WHERE doctor_id = ? AND status IN ('held','confirmed')")
    .all(doctorId) as Array<{ start_at: string; end_at: string; status: string; hold_expires_at: string | null }>;
  return rows
    .filter((r) => r.status === 'confirmed' || (r.hold_expires_at && new Date(r.hold_expires_at) > now))
    .map((r) => ({ start: new Date(r.start_at), end: new Date(r.end_at) }));
}

function doctorSlots(doc: DoctorRow, from: Date, to: Date, limit: number): Slot[] {
  const now = clock.now();
  return freeSlots({
    schedule: JSON.parse(doc.schedule_json) as WeeklySchedule,
    slotMinutes: doc.slot_minutes,
    from,
    to,
    taken: takenRanges(doc.id, now),
    now,
    limit,
  });
}

function fulfillmentId(doctorId: string, start: Date): string {
  return `${doctorId}|${toIstIso(start)}`;
}

function parseFulfillmentId(id: string | undefined): { doctorId: string; start: Date } | null {
  if (!id || !id.includes('|')) return null;
  const [doctorId, iso] = id.split('|');
  const start = new Date(iso);
  return Number.isNaN(start.getTime()) ? null : { doctorId, start };
}

function agentOf(doc: DoctorRow): Fulfillment['agent'] {
  return {
    id: doc.id,
    name: doc.name,
    gender: doc.gender,
    tags: {
      [TAG.hprId]: doc.id,
      [TAG.education]: doc.education,
      [TAG.experience]: String(doc.experience_years),
      [TAG.languages]: doc.languages,
    },
  };
}

function slotFulfillment(doc: DoctorRow, slot: Slot): Fulfillment {
  return {
    id: fulfillmentId(doc.id, slot.start),
    type: 'PhysicalConsultation',
    agent: agentOf(doc),
    start: { time: { timestamp: toIstIso(slot.start) } },
    end: { time: { timestamp: toIstIso(slot.end) } },
  };
}

function consultationItem(doc: DoctorRow, fulfillment_id: string): Item {
  return {
    id: `consult|${fulfillment_id}`,
    descriptor: { name: 'Consultation', code: 'CONSULTATION' },
    price: { currency: 'INR', value: String(doc.fee) },
    category_id: doc.specialty,
    fulfillment_id,
  };
}

function providerFor(clinic: ClinicRow): Provider {
  return {
    id: clinic.id,
    descriptor: { name: clinic.name },
    locations: [
      {
        id: clinic.id,
        descriptor: { name: clinic.name },
        gps: `${clinic.lat.toFixed(6)},${clinic.lng.toFixed(6)}`,
        address: clinic.address,
      },
    ],
    categories: [],
    fulfillments: [],
    items: [],
    tags: { [TAG.testData]: 'true', [TAG.clinicPhone]: clinic.phone },
  };
}

function buildCatalog(hspaId: string, intent: Intent | undefined): Catalog {
  const code = intent?.category?.descriptor?.code as SpecialtyCode | undefined;
  const agent = intent?.fulfillment?.agent;
  const wantLang = intent?.fulfillment?.agent?.tags?.[TAG.languages];
  const maxFee = Number(intent?.tags?.['@docsaathi/max_fee'] ?? NaN);
  const now = clock.now();
  const from = new Date(intent?.fulfillment?.start?.time?.timestamp ?? now.toISOString());
  const to = new Date(intent?.fulfillment?.end?.time?.timestamp ?? addMinutes(now, 3 * 24 * 60).toISOString());
  const perDoctor = Number(intent?.tags?.['@docsaathi/slots_per_doctor'] ?? 4);

  let doctors = db().prepare('SELECT * FROM hspa_doctors WHERE hspa_id = ?').all(hspaId) as unknown as DoctorRow[];
  if (code && code in SPECIALTIES) doctors = doctors.filter((d) => d.specialty === code);
  if (agent?.id) doctors = doctors.filter((d) => d.id === agent.id);
  if (agent?.name) {
    const needle = agent.name.toLowerCase().replace(/^dr\.?\s*/, '');
    doctors = doctors.filter((d) => d.name.toLowerCase().includes(needle));
  }
  if (agent?.gender) doctors = doctors.filter((d) => d.gender === agent.gender);
  if (wantLang) doctors = doctors.filter((d) => d.languages.split(',').includes(wantLang));
  if (Number.isFinite(maxFee)) doctors = doctors.filter((d) => d.fee <= maxFee);

  const providers = new Map<string, Provider>();
  for (const doc of doctors) {
    const slots = doctorSlots(doc, from, to, perDoctor);
    if (slots.length === 0) continue;
    let provider = providers.get(doc.clinic_id);
    if (!provider) {
      const clinic = db().prepare('SELECT * FROM hspa_clinics WHERE id = ?').get(doc.clinic_id) as unknown as ClinicRow;
      provider = providerFor(clinic);
      providers.set(doc.clinic_id, provider);
    }
    if (!provider.categories!.some((c) => c.id === doc.specialty)) {
      provider.categories!.push({ id: doc.specialty, descriptor: { name: SPECIALTIES[doc.specialty].name, code: doc.specialty } });
    }
    for (const slot of slots) {
      const f = slotFulfillment(doc, slot);
      provider.fulfillments!.push(f);
      provider.items!.push(consultationItem(doc, f.id!));
    }
  }
  return { descriptor: { name: HSPA_NAMES[hspaId] ?? hspaId }, providers: [...providers.values()] };
}

function callbackContext(ctx: UhiContext, hspaId: string, action: UhiAction): UhiContext {
  return {
    ...ctx,
    action,
    core_version: UHI_CORE_VERSION,
    provider_id: hspaId,
    provider_uri: `${publicBaseUrl()}/uhi/hspa/${hspaId}`,
    timestamp: new Date().toISOString(),
  };
}

async function reply(hspaId: string, ctx: UhiContext, action: UhiAction, message: unknown, error?: UhiError): Promise<void> {
  // Test providers live on the local test network, so search results go back via the local test gateway.
  const target = action === 'on_search' ? `${publicBaseUrl()}/uhi/gateway/on_search` : `${ctx.consumer_uri}/${action}`;
  const payload: UhiRequest = { context: callbackContext(ctx, hspaId, action), message, ...(error ? { error } : {}) };
  await postSigned(target, payload, signingKey(hspaId));
}

function loadDoctor(hspaId: string, doctorId: string): DoctorRow | undefined {
  return db().prepare('SELECT * FROM hspa_doctors WHERE id = ? AND hspa_id = ?').get(doctorId, hspaId) as unknown as DoctorRow | undefined;
}

function loadClinic(clinicId: string): ClinicRow {
  return db().prepare('SELECT * FROM hspa_clinics WHERE id = ?').get(clinicId) as unknown as ClinicRow;
}

function isSlotFree(doc: DoctorRow, start: Date): Slot | undefined {
  const end = addMinutes(start, doc.slot_minutes);
  // Ask for a small window around the slot: if it is still offered, it is free.
  const slots = doctorSlots(doc, addMinutes(start, -1), addMinutes(end, 1), 5);
  return slots.find((s) => s.start.getTime() === start.getTime());
}

function orderView(doc: DoctorRow, clinic: ClinicRow, start: Date, patientName: string | undefined, extra: Partial<Order> = {}, desk?: Fulfillment['state']): Order {
  const f = slotFulfillment(doc, { start, end: addMinutes(start, doc.slot_minutes) });
  if (desk) f.state = desk;
  if (patientName) f.customer = { person: { name: patientName } };
  if (doc.instructions) f.start = { ...f.start, instructions: { name: 'Before your visit', short_desc: doc.instructions } };
  const price = { currency: 'INR', value: String(doc.fee) };
  const provider = providerFor(clinic);
  return {
    provider: { id: clinic.id, descriptor: provider.descriptor, locations: provider.locations },
    items: [{ id: `consult|${f.id}`, descriptor: { name: 'Consultation', code: 'CONSULTATION' }, price }],
    fulfillment: { ...f, tags: { ...f.tags, [TAG.clinicPhone]: clinic.phone, [TAG.testData]: 'true' } },
    quote: { price, breakup: [{ title: 'Consultation fee', price }] },
    payment: { type: 'POST-FULFILLMENT', status: 'NOT-PAID', params: { amount: String(doc.fee), currency: 'INR' } },
    ...extra,
  };
}

// ---------------------------------------------------------------------------
// The clinic's side ("clinic desk"): what the receptionist sees, and their accept / reject.
// A booking is confirmed by the clinic's system as soon as the time is free (like any online slot
// booking). The desk then accepts it, or says it cannot take it; the family's app is told at once
// with an unsolicited UHI on_status callback.

export interface DeskBooking {
  id: string;
  patient: string;
  phone: string | null;
  doctor: string;
  specialty: string;
  clinic: string;
  address: string;
  start: string;
  status: 'confirmed' | 'cancelled';
  decision: 'new' | 'accepted' | 'rejected';
  note: string | null;
  bookedAt: string;
}

type DeskRow = BookingRow & { doctor_name: string; specialty: SpecialtyCode; clinic_name: string; clinic_address: string };

const deskView = (r: DeskRow): DeskBooking => ({
  id: r.id,
  patient: r.patient_name,
  phone: r.patient_phone,
  doctor: r.doctor_name,
  specialty: SPECIALTIES[r.specialty]?.name ?? r.specialty,
  clinic: r.clinic_name,
  address: r.clinic_address,
  start: toIstIso(new Date(r.start_at)),
  status: r.status === 'cancelled' ? 'cancelled' : 'confirmed',
  decision: r.clinic_state,
  note: r.clinic_note,
  bookedAt: r.created_at,
});

const DESK_QUERY = `SELECT b.*, d.name AS doctor_name, d.specialty, c.name AS clinic_name, c.address AS clinic_address
  FROM hspa_bookings b JOIN hspa_doctors d ON d.id = b.doctor_id JOIN hspa_clinics c ON c.id = d.clinic_id`;

/** Bookings from yesterday onwards, newest first (held times that were never confirmed are left out). */
export function deskBookings(): DeskBooking[] {
  const since = addMinutes(clock.now(), -24 * 60).toISOString();
  const rows = db().prepare(`${DESK_QUERY} WHERE b.status IN ('confirmed','cancelled') AND b.start_at >= ? ORDER BY b.created_at DESC LIMIT 60`).all(since) as unknown as DeskRow[];
  return rows.map(deskView);
}

/** The desk accepts a booking, or says why it cannot take it. The family's app hears about it right away. */
export async function clinicDecision(bookingId: string, accept: boolean, note?: string): Promise<DeskBooking | undefined> {
  const booking = db().prepare('SELECT * FROM hspa_bookings WHERE id = ?').get(bookingId) as unknown as BookingRow | undefined;
  if (!booking || booking.status !== 'confirmed') return undefined;
  const doc = loadDoctor(booking.hspa_id, booking.doctor_id);
  if (!doc) return undefined;
  booking.clinic_state = accept ? 'accepted' : 'rejected';
  booking.clinic_note = accept ? null : (note ?? '').trim().slice(0, 140) || null;
  if (!accept) booking.status = 'cancelled';
  db().prepare('UPDATE hspa_bookings SET clinic_state = ?, clinic_note = ?, status = ? WHERE id = ?').run(booking.clinic_state, booking.clinic_note, booking.status, booking.id);

  // Tell the app that made the booking (an unsolicited on_status, signed like every UHI message).
  const asked: UhiContext = booking.context_json
    ? (JSON.parse(booking.context_json) as UhiContext)
    : {
        domain: UHI_DOMAIN,
        country: UHI_COUNTRY,
        city: UHI_CITY,
        action: 'status',
        core_version: UHI_CORE_VERSION,
        consumer_id: config.uhi.subscriberId,
        consumer_uri: `${publicBaseUrl()}/uhi/eua`,
        transaction_id: booking.transaction_id,
        message_id: crypto.randomUUID(),
        timestamp: new Date().toISOString(),
      };
  const order = orderView(doc, loadClinic(doc.clinic_id), new Date(booking.start_at), booking.patient_name, { id: booking.id, state: accept ? 'CONFIRMED' : 'CANCELLED' }, deskState(booking));
  const payload: UhiRequest = { context: { ...callbackContext(asked, booking.hspa_id, 'on_status'), message_id: crypto.randomUUID() }, message: { order } };
  await postSigned(`${asked.consumer_uri}/on_status`, payload, signingKey(booking.hspa_id));

  const row = db().prepare(`${DESK_QUERY} WHERE b.id = ?`).get(booking.id) as unknown as DeskRow;
  return deskView(row);
}

const slotGone: UhiError = { type: 'DOMAIN-ERROR', code: '30004', message: 'That time is no longer free. Please pick another time.' };
const notFound: UhiError = { type: 'DOMAIN-ERROR', code: '30001', message: 'Doctor or order not found at this provider.' };

export function testHspaRouter(): Router {
  const router = Router();

  router.post('/:hspaId/:action', (req: RawBodyRequest, res: Response) => {
    const hspaId = String(req.params.hspaId);
    const action = String(req.params.action) as UhiAction;
    if (!(TEST_HSPA_IDS as readonly string[]).includes(hspaId)) {
      res.status(404).json(nack({ type: 'CONTEXT-ERROR', code: '20002', message: 'Unknown provider' }));
      return;
    }
    const signed = readSigned<{ intent?: Intent; order?: Order }>(req, res);
    if (!signed) return;
    const { context, message } = signed.body;
    res.json(ACK);

    afterAck(`${hspaId} ${action}`, async () => {
      switch (action) {
        case 'search':
          await reply(hspaId, context, 'on_search', { catalog: buildCatalog(hspaId, message.intent) });
          return;
        case 'select':
        case 'init': {
          const order = message.order;
          const parsed = parseFulfillmentId(order?.fulfillment?.id);
          const doc = parsed && loadDoctor(hspaId, parsed.doctorId);
          const cb = action === 'select' ? 'on_select' : 'on_init';
          if (!parsed || !doc) return reply(hspaId, context, cb, { order }, notFound);
          const slot = isSlotFree(doc, parsed.start);
          if (!slot) return reply(hspaId, context, cb, { order }, slotGone);
          const clinic = loadClinic(doc.clinic_id);
          const patient = order?.fulfillment?.customer?.person?.name;
          if (action === 'select') {
            return reply(hspaId, context, 'on_select', { order: orderView(doc, clinic, parsed.start, patient) });
          }
          // init: hold the slot for a few minutes while the family confirms
          const id = newId('uhiord');
          const expires = addMinutes(clock.now(), HOLD_MINUTES);
          db()
            .prepare(
              `INSERT INTO hspa_bookings (id, hspa_id, doctor_id, transaction_id, patient_name, patient_phone, start_at, end_at, status, hold_expires_at, context_json, created_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'held', ?, ?, ?)`,
            )
            .run(id, hspaId, doc.id, context.transaction_id, patient ?? order?.billing?.name ?? 'Patient', order?.billing?.phone ?? null, slot.start.toISOString(), slot.end.toISOString(), expires.toISOString(), JSON.stringify(context), nowIso());
          return reply(hspaId, context, 'on_init', {
            order: orderView(doc, clinic, parsed.start, patient, { id, state: 'INITIALIZED', billing: order?.billing }),
          });
        }
        case 'confirm':
        case 'status':
        case 'cancel': {
          const cb = `on_${action}` as UhiAction;
          const id = message.order?.id;
          const booking = id
            ? (db().prepare('SELECT * FROM hspa_bookings WHERE id = ? AND hspa_id = ?').get(id, hspaId) as unknown as BookingRow | undefined)
            : undefined;
          const doc = booking && loadDoctor(hspaId, booking.doctor_id);
          if (!booking || !doc) return reply(hspaId, context, cb, { order: message.order }, notFound);
          const clinic = loadClinic(doc.clinic_id);
          if (action === 'confirm') {
            const expired = booking.status === 'held' && booking.hold_expires_at && new Date(booking.hold_expires_at) <= clock.now();
            if (booking.status === 'cancelled' || expired) {
              return reply(hspaId, context, cb, { order: message.order }, { ...slotGone, message: 'The hold on this time expired. Please book again.' });
            }
            db().prepare("UPDATE hspa_bookings SET status = 'confirmed', hold_expires_at = NULL WHERE id = ?").run(id!);
            booking.status = 'confirmed';
          } else if (action === 'cancel' && booking.status !== 'cancelled') {
            db().prepare("UPDATE hspa_bookings SET status = 'cancelled' WHERE id = ?").run(id!);
            booking.status = 'cancelled';
          }
          const state = booking.status === 'confirmed' ? 'CONFIRMED' : booking.status === 'cancelled' ? 'CANCELLED' : 'INITIALIZED';
          return reply(hspaId, context, cb, {
            order: orderView(doc, clinic, new Date(booking.start_at), booking.patient_name, { id, state }, deskState(booking)),
          });
        }
        default:
          return reply(hspaId, context, `on_${action}` as UhiAction, {}, { type: 'CORE-ERROR', code: '20003', message: `Unsupported action ${action}` });
      }
    });
  });

  return router;
}
