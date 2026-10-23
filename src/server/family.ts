// The family ("household"): members, identity tokens, and understanding who someone means.
import { config } from './config.js';
import { db, newId, nowIso } from './db.js';
import { geocode } from './google.js';
import { addDays, toIstIso, clock } from './time.js';
import { RELATIONS, relationFromText } from './words.js';

export interface Household {
  id: string;
  name: string;
  token: string;
  home_address: string;
  home_lat: number;
  home_lng: number;
  home_source: 'default' | 'device' | 'spoken';
  reply_lang: 'en' | 'hi';
}

/** "Hindi mein bolo" / "speak in English": the language Alexa answers this family in. */
export function setReplyLanguage(householdId: string, lang: 'en' | 'hi'): void {
  db().prepare('UPDATE households SET reply_lang = ? WHERE id = ?').run(lang, householdId);
}

export interface Member {
  id: string;
  household_id: string;
  name: string;
  relation: string;
  age: number | null;
  gender: string | null;
  phone: string | null;
  alt_names: string | null;
  notify: number;
  speaker: number;
}

export const DEMO_TOKEN = process.env.DEMO_FAMILY_TOKEN ?? 'demo-verma-family';

export function householdByToken(token: string): Household | undefined {
  return db().prepare('SELECT * FROM households WHERE token = ?').get(token) as unknown as Household | undefined;
}

export function householdById(id: string): Household | undefined {
  return db().prepare('SELECT * FROM households WHERE id = ?').get(id) as unknown as Household | undefined;
}

export function membersOf(householdId: string): Member[] {
  return db().prepare('SELECT * FROM members WHERE household_id = ? ORDER BY created_at').all(householdId) as unknown as Member[];
}

/** A friendly label: "Dadi (Kamla)" or "Aarav". */
export function memberLabel(m: Member): string {
  const rel = m.relation;
  if (rel === 'self' || rel === 'son' || rel === 'daughter' || rel === 'other') return m.name;
  const word = RELATIONS[rel]?.[0];
  if (!word) return m.name;
  const pretty = word.charAt(0).toUpperCase() + word.slice(1);
  return m.name.toLowerCase() === word ? pretty : `${pretty} (${m.name})`;
}

/** How to say who it is in a sentence: relation word if we have one, else the name. */
export function memberSpoken(m: Member): string {
  const rel = m.relation;
  if (rel === 'self') return 'you';
  if (['son', 'daughter', 'other'].includes(rel)) return m.name;
  const word = RELATIONS[rel]?.[0];
  return word ? word.charAt(0).toUpperCase() + word.slice(1) : m.name;
}

/** "Dadi, Papa, Mummy or Aarav" */
export function orList(items: string[], or = 'or'): string {
  return items.length <= 1 ? (items[0] ?? '') : `${items.slice(0, -1).join(', ')} ${or} ${items[items.length - 1]}`;
}

// ---------------------------------------------------------------------------
// Who is talking right now. A real Echo knows each family member by their voice (Alexa voice ID).
// The simulator cannot, so nobody is assumed: the speaker is set when they say who they are
// ("main Papa hoon"), answer "Who am I speaking with?", or pick themselves on the screen.
// It is forgotten when the conversation ends, so the next person is asked again.

export function speakerOf(householdId: string): Member | undefined {
  return membersOf(householdId).find((m) => m.speaker === 1);
}

export function setSpeaker(householdId: string, memberId: string | null): void {
  const d = db();
  d.prepare('UPDATE members SET speaker = 0 WHERE household_id = ?').run(householdId);
  if (memberId) d.prepare('UPDATE members SET speaker = 1 WHERE id = ? AND household_id = ?').run(memberId, householdId);
}

/** `askSpeaker`: they said "me" but nobody knows who is talking yet. */
export type MemberMatch = { member: Member } | { error: string; askSpeaker?: boolean };

/** Find the family member someone means: a name, a relation word ("Dadi"), or "me". */
export function resolveMember(householdId: string, text: string | undefined): MemberMatch {
  const members = membersOf(householdId);
  const t = (text ?? '').trim().toLowerCase();
  if (!t) {
    return { error: `Who is the appointment for? Your family: ${members.map(memberLabel).join(', ')}.` };
  }
  const byName = members.find(
    (m) =>
      new RegExp(`(^|[^a-z])${m.name.toLowerCase()}([^a-z]|$)`).test(t) ||
      (t.length >= 3 && m.name.toLowerCase().startsWith(t)) ||
      (m.alt_names ?? '').split(',').some((alt) => alt.trim() && t.includes(alt.trim().toLowerCase())),
  );
  if (byName) return { member: byName };
  const relation = relationFromText(t);
  if (relation === 'self') {
    // "me / mujhe / mere liye" = whoever is talking (see speakerOf). Not known yet: ask, never guess.
    const speaker = members.find((m) => m.speaker) ?? members.find((m) => m.relation === 'self');
    if (speaker) return { member: speaker };
    return { error: `Who am I speaking with? ${orList(members.map(memberSpoken))}?`, askSpeaker: true };
  }
  if (relation) {
    const byRelation = members.find((m) => m.relation === relation);
    if (byRelation) return { member: byRelation };
    const word = RELATIONS[relation][0];
    return { error: `I don't know your ${word} yet. Please tell me their name and age, and I'll add them to the family.` };
  }
  return { error: `I couldn't tell who "${text}" is. Your family: ${members.map(memberLabel).join(', ')}.` };
}

export function addMember(
  householdId: string,
  input: { name: string; relation?: string; age?: number; gender?: string; phone?: string },
): Member {
  const relation = input.relation ? relationFromText(input.relation) ?? input.relation.toLowerCase() : 'other';
  const id = newId('mem');
  db()
    .prepare('INSERT INTO members (id, household_id, name, relation, age, gender, phone, notify, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?)')
    .run(id, householdId, input.name.trim(), relation, input.age ?? null, input.gender ?? null, input.phone ?? null, nowIso());
  return db().prepare('SELECT * FROM members WHERE id = ?').get(id) as unknown as Member;
}

/** Put the demo back to its starting point (for recording the video again). Keeps the family and Dadi's past visit. */
export function resetDemoData(householdId: string): void {
  const d = db();
  for (const table of ['notices', 'holds', 'follow_ups', 'family_messages', 'last_results']) {
    d.prepare(`DELETE FROM ${table} WHERE household_id = ?`).run(householdId);
  }
  d.prepare("DELETE FROM appointments WHERE household_id = ? AND transaction_id <> 'seed'").run(householdId);
  d.prepare('DELETE FROM hspa_bookings').run();
}

/** The demo family: the Verma family. Everything here is an example, not a real person. */
export async function seedDemoFamily(): Promise<Household> {
  const existing = householdByToken(DEMO_TOKEN);
  if (existing) return existing;
  const home = (await geocode(config.home.address)) ?? { lat: config.home.lat, lng: config.home.lng };
  const id = newId('hh');
  db()
    .prepare('INSERT INTO households (id, name, token, home_address, home_lat, home_lng, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(id, 'Verma family (demo)', DEMO_TOKEN, config.home.address, home.lat, home.lng, nowIso());
  // [name, relation, age, gender, phone (impossible test numbers), gets messages, other spellings]
  // Nobody is "the speaker" to begin with: anyone in the family may be talking.
  const people: Array<[string, string, number, string, string | null, number, string]> = [
    ['Kamla', 'dadi', 72, 'F', null, 0, 'कमला'],
    ['Rajesh', 'papa', 45, 'M', '+91 00000 11111', 1, 'राजेश'],
    ['Neha', 'mummy', 41, 'F', '+91 00000 22222', 0, 'नेहा'],
    ['Aarav', 'son', 7, 'M', null, 0, 'आरव,arav,aarow'],
  ];
  const insert = db().prepare(
    'INSERT INTO members (id, household_id, name, relation, age, gender, phone, alt_names, notify, speaker, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)',
  );
  const ids: Record<string, string> = {};
  for (const [name, relation, age, gender, phone, notify, alts] of people) {
    ids[relation] = newId('mem');
    insert.run(ids[relation], id, name, relation, age, gender, phone, alts, notify, nowIso());
  }
  // Memory from before: Dadi saw the sugar doctor about 3 months ago (so "book Dadi's usual" works).
  const past = addDays(clock.now(), -92);
  const pastStart = new Date(Math.floor(past.getTime() / 60_000) * 60_000);
  db()
    .prepare(
      `INSERT INTO appointments (id, household_id, member_id, transaction_id, order_id, provider_id, provider_uri, doctor_id, doctor_name,
         specialty, clinic_name, clinic_address, clinic_lat, clinic_lng, clinic_phone, start_at, end_at, fee, instructions, status, test_data, created_at, updated_at)
       VALUES (?, ?, ?, 'seed', 'seed-order', 'citycare-test-hspa', ?, 'test.rakesh.sharma@hpr.abdm', 'Dr. Rakesh Sharma',
         'DIABETOLOGY', 'Sharma Diabetes & Thyroid Care (TEST)', 'Deccan (test address)', NULL, NULL, NULL, ?, ?, 700, NULL, 'completed', 1, ?, ?)`,
    )
    .run(newId('apt'), id, ids.dadi, `${config.baseUrl}/uhi/hspa/citycare-test-hspa`, toIstIso(pastStart), toIstIso(pastStart), nowIso(), nowIso());
  return householdByToken(DEMO_TOKEN)!;
}
