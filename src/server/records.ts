// The family's health record: which doctors each person saw, and what medicines the doctors wrote.
// So nobody has to remember "which doctor did Dadi see, and what did he give?" when they go to the
// next doctor. DocSaathi bookings appear by themselves; visits to other doctors and the medicines
// are added by the family. This is only a record of what the doctor wrote: DocSaathi never suggests
// a medicine. Every entry keeps who added it (the person talking at the time).
import express, { type Request, type Response, type Router } from 'express';
import { db, newId, nowIso } from './db.js';
import { memberLabel, membersOf, speakerOf, type Household, type Member } from './family.js';
import { clock, toIstIso } from './time.js';
import { SPECIALTIES, type SpecialtyCode } from './words.js';

interface VisitRow {
  id: string;
  member_id: string;
  doctor_name: string;
  specialty: string | null;
  clinic: string | null;
  visited_on: string;
  notes: string | null;
  added_by: string | null;
  created_at: string;
}

interface MedicineRow {
  id: string;
  member_id: string;
  name: string;
  how_to_take: string | null;
  days: number | null;
  doctor_name: string | null;
  started_on: string;
  notes: string | null;
  added_by: string | null;
  created_at: string;
}

/** "YYYY-MM-DD" in India time, on the demo clock. */
function today(): string {
  return toIstIso(clock.now()).slice(0, 10);
}

function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

function specialtyName(code: string | null): string | null {
  if (!code) return null;
  return SPECIALTIES[code as SpecialtyCode]?.name ?? code;
}

/** Everything the menu's "Doctors we visited" and "Medicine records" pages show. */
export function healthRecord(household: Household) {
  const members = membersOf(household.id);
  const byId = new Map(members.map((m) => [m.id, m]));
  const label = (id: string | null) => (id && byId.get(id) ? memberLabel(byId.get(id)!) : null);
  const now = toIstIso(clock.now());
  const day = today();

  // DocSaathi's own bookings: the past ones are visits, the rest are coming up.
  const booked = db()
    .prepare(
      `SELECT id, member_id, doctor_name, specialty, clinic_name, clinic_address, start_at, status, test_data FROM appointments
       WHERE household_id = ? AND status IN ('confirmed', 'completed') ORDER BY start_at DESC`,
    )
    .all(household.id) as Array<{
    id: string;
    member_id: string;
    doctor_name: string;
    specialty: string;
    clinic_name: string;
    clinic_address: string;
    start_at: string;
    status: string;
    test_data: number;
  }>;
  const fromBookings = booked.map((a) => ({
    id: a.id,
    source: 'docsaathi' as const,
    memberId: a.member_id,
    patient: label(a.member_id),
    doctor: a.doctor_name,
    specialty: specialtyName(a.specialty),
    clinic: a.clinic_name,
    date: a.start_at,
    testData: Boolean(a.test_data),
    upcoming: a.start_at > now,
  }));
  const added = db()
    .prepare('SELECT * FROM doctor_visits WHERE household_id = ? ORDER BY visited_on DESC, created_at DESC')
    .all(household.id) as unknown as VisitRow[];
  const fromFamily = added.map((v) => ({
    id: v.id,
    source: 'family' as const,
    memberId: v.member_id,
    patient: label(v.member_id),
    doctor: v.doctor_name,
    specialty: v.specialty,
    clinic: v.clinic,
    date: v.visited_on,
    notes: v.notes,
    addedBy: label(v.added_by),
    upcoming: false,
  }));
  const visits = [...fromBookings.filter((v) => !v.upcoming), ...fromFamily].sort((a, b) => (a.date < b.date ? 1 : -1));
  const upcoming = fromBookings.filter((v) => v.upcoming).sort((a, b) => (a.date < b.date ? -1 : 1));

  const meds = db()
    .prepare('SELECT * FROM medicines WHERE household_id = ? ORDER BY started_on DESC, created_at DESC')
    .all(household.id) as unknown as MedicineRow[];
  const medicines = meds.map((m) => {
    const ends = m.days ? daysBetween(day, m.started_on) + m.days : null; // days left, counting today
    return {
      id: m.id,
      memberId: m.member_id,
      patient: label(m.member_id),
      name: m.name,
      howToTake: m.how_to_take,
      days: m.days,
      doctor: m.doctor_name,
      startedOn: m.started_on,
      notes: m.notes,
      addedBy: label(m.added_by),
      daysLeft: ends === null ? null : Math.max(0, ends),
      current: ends === null || ends > 0,
    };
  });

  return {
    today: day,
    members: members.map((m) => ({ id: m.id, label: memberLabel(m), age: m.age })),
    upcoming,
    visits,
    medicines,
  };
}

// ---------------------------------------------------------------------------
// Adding and removing (from the menu's forms)

const text = (v: unknown, max: number) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null);
const DATE = /^\d{4}-\d{2}-\d{2}$/;

function memberOf(household: Household, id: unknown): Member | undefined {
  return typeof id === 'string' ? membersOf(household.id).find((m) => m.id === id) : undefined;
}

export function recordsRouter(householdFor: (req: Request) => Household | undefined): Router {
  const router = express.Router();
  const family = (req: Request, res: Response): Household | undefined => {
    const household = householdFor(req);
    if (!household) res.status(401).json({ error: 'Unknown family' });
    return household;
  };

  router.get('/api/records', (req, res) => {
    const household = family(req, res);
    if (household) res.json(healthRecord(household));
  });

  router.post('/api/records/visits', (req, res) => {
    const household = family(req, res);
    if (!household) return;
    const b = (req.body ?? {}) as Record<string, unknown>;
    const member = memberOf(household, b.memberId);
    const doctor = text(b.doctor, 80);
    const date = typeof b.date === 'string' && DATE.test(b.date) ? b.date : null;
    if (!member || !doctor || !date) {
      res.status(400).json({ error: 'Please choose who it was for, the doctor, and the date.' });
      return;
    }
    if (date > today()) {
      res.status(400).json({ error: 'That date is in the future. Book an appointment for that instead.' });
      return;
    }
    db()
      .prepare('INSERT INTO doctor_visits (id, household_id, member_id, doctor_name, specialty, clinic, visited_on, notes, added_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(newId('visit'), household.id, member.id, doctor, text(b.specialty, 60), text(b.clinic, 120), date, text(b.notes, 300), speakerOf(household.id)?.id ?? null, nowIso());
    res.json(healthRecord(household));
  });

  router.delete('/api/records/visits/:id', (req, res) => {
    const household = family(req, res);
    if (!household) return;
    db().prepare('DELETE FROM doctor_visits WHERE id = ? AND household_id = ?').run(String(req.params.id), household.id);
    res.json(healthRecord(household));
  });

  router.post('/api/records/medicines', (req, res) => {
    const household = family(req, res);
    if (!household) return;
    const b = (req.body ?? {}) as Record<string, unknown>;
    const member = memberOf(household, b.memberId);
    const name = text(b.name, 80);
    const started = typeof b.startedOn === 'string' && DATE.test(b.startedOn) ? b.startedOn : today();
    const days = b.days === undefined || b.days === null || b.days === '' ? null : Number(b.days);
    if (!member || !name) {
      res.status(400).json({ error: 'Please choose who it is for and write the medicine name as the doctor wrote it.' });
      return;
    }
    if (days !== null && (!Number.isInteger(days) || days < 1 || days > 3650)) {
      res.status(400).json({ error: 'Days must be a whole number from 1 to 3650 (or leave it empty).' });
      return;
    }
    db()
      .prepare('INSERT INTO medicines (id, household_id, member_id, name, how_to_take, days, doctor_name, started_on, notes, added_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(newId('med'), household.id, member.id, name, text(b.howToTake, 120), days, text(b.doctor, 80), started, text(b.notes, 300), speakerOf(household.id)?.id ?? null, nowIso());
    res.json(healthRecord(household));
  });

  router.delete('/api/records/medicines/:id', (req, res) => {
    const household = family(req, res);
    if (!household) return;
    db().prepare('DELETE FROM medicines WHERE id = ? AND household_id = ?').run(String(req.params.id), household.id);
    res.json(healthRecord(household));
  });

  return router;
}
