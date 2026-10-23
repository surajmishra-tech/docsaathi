// The DocSaathi MCP server: the tools Alexa+ (or any MCP client) calls.
import { registerAppResource, registerAppTool, RESOURCE_MIME_TYPE } from '@modelcontextprotocol/ext-apps/server';
import { McpServer, type CallToolResult } from '@modelcontextprotocol/server';
import { z } from 'zod';
import {
  bookAppointment,
  cancelAppointment,
  checkReminders,
  confirmAppointment,
  doctorTimes,
  familyList,
  findDoctors,
  findUsualDoctor,
  myAppointments,
  nearbyPlaces,
  prepareReschedule,
  rememberFollowUp,
  type Reply,
} from './booking.js';
import { addMember, householdById, memberLabel } from './family.js';
import { mapImage } from './google.js';
import { changeLocation } from './location.js';
import { SCREEN_URI, screenHtml } from './ui.js';

// Every tool answer comes with the DocSaathi screen (an MCP App), which Alexa+ renders on Echo Show.
const SCREEN_META = { ui: { resourceUri: SCREEN_URI } };

export const SERVER_INFO = {
  name: 'docsaathi',
  title: 'DocSaathi: find and book doctors in India',
  version: '0.1.0',
  description:
    'Find and book Indian doctors by voice for the whole family, in Hindi, English or Hinglish. Connects to India’s UHI (Unified Health Interface) doctor network.',
};

const INSTRUCTIONS = `DocSaathi helps an Indian family find and book doctors by voice.
- Keep replies short and spoken. Numbers are rupees. Times are India time.
- Families speak Hindi, English or Hinglish and use relation words (Dadi, Nani, Papa, Mummy, bhaiya). Pass their words as they are.
- Flow: find_doctors -> (get_doctor_times) -> book_appointment (holds a time and returns a confirm card) -> ask "Shall I book it?" -> confirm_appointment only after a clear yes.
- Never diagnose or give medical advice. If find_doctors or book_appointment returns kind "emergency", tell the user to call 112 (or 108 for an ambulance) right away and do not book.
- Doctors marked testData are from DocSaathi's test UHI network; say so if asked.
- Real clinics from Google Maps (find_nearby_clinics, and the "real clinics" under a doctor list) are not on UHI yet, so they cannot be booked: give the phone number or the directions.`;

// Short machine notes so an AI assistant keeps ids without reading them aloud.
function notesFor(data: Reply['data']): Record<string, unknown> {
  switch (data.kind) {
    case 'doctors':
      return {
        doctors: (data.doctors as Array<{ n: number; ref: string; name: string; firstSlot: { start: string } | null; fee: number }>).map((d) => ({
          n: d.n,
          ref: d.ref,
          name: d.name,
          first_free: d.firstSlot?.start,
          fee: d.fee,
        })),
      };
    case 'times':
      return {
        doctor_ref: (data.doctor as { ref?: string } | undefined)?.ref,
        replaces_appointment: data.replacesAppointment,
        times: (data.times as Array<{ start: string }>).slice(0, 12).map((t) => t.start),
      };
    case 'usual':
      return { doctor_ref: (data.doctor as { ref: string }).ref, first_free: (data.doctor as { firstSlot: { start: string } | null }).firstSlot?.start };
    case 'confirm':
      return { hold_id: data.holdId, expires_at: data.expiresAt };
    case 'booked':
      return { appointment_id: data.appointmentId, uhi_order_id: data.uhiOrderId, leave_by: data.leaveBy };
    case 'appointments':
      return { appointments: (data.appointments as Array<{ id: string; patient: string; doctor: string; start: string }>).map((a) => ({ id: a.id, patient: a.patient, doctor: a.doctor, start: a.start })) };
    default:
      return {};
  }
}

function toResult(reply: Reply): CallToolResult {
  const notes = notesFor(reply.data);
  const content: CallToolResult['content'] = [{ type: 'text', text: reply.speech }];
  if (Object.keys(notes).length) {
    content.push({ type: 'text', text: `Assistant notes (do not read aloud): ${JSON.stringify(notes)}` });
  }
  return { content, structuredContent: reply.data, ...(reply.data.kind === 'error' ? { isError: true } : {}) };
}

const patientField = z
  .string()
  .describe(
    'Who the appointment is for: a name ("Aarav") or relation word ("Dadi", "Papa"), in any language. If you know who is speaking ' +
      '(for example from voice ID), pass their name; "me" works once DocSaathi knows who is speaking, and otherwise it asks.',
  );

export function buildServer(householdId: string): McpServer {
  const server = new McpServer(SERVER_INFO, { instructions: INSTRUCTIONS });

  registerAppTool(
    server,
    'find_doctors',
    {
      title: 'Find doctors',
      description:
        'Find doctors with free appointment times on India’s UHI network, from everyday words in Hindi, English or Hinglish ' +
        '(for example "bachchon ka doctor", "sugar wale doctor", "haddi", "daant", "aankh", "fever"). Understands time words like ' +
        '"aaj shaam", "kal subah", "tonight". Returns numbered doctors with the next free times, fees and travel time from home, plus real ' +
        'clinics nearby on Google Maps that can be called. Never diagnoses. Returns kind "emergency" with numbers to call if the words describe an emergency.',
      inputSchema: z.object({
        need: z.string().describe('What the family said they need, in their own words, e.g. "Aarav ko bukhaar hai, bachchon ka doctor, aaj shaam"'),
        patient: patientField.optional(),
        when: z.string().optional().describe('When, in their words: "aaj shaam", "tomorrow morning", "2026-10-05". Defaults to the next 3 days.'),
        near_home: z.boolean().optional().describe('Sort by nearest first (true if they said near, paas, nearby).'),
        doctor_gender: z.string().optional().describe('"female" or "male" if they asked for a lady or gents doctor.'),
        language: z.string().optional().describe('A language the doctor should speak, e.g. "Marathi".'),
        max_fee: z.number().optional().describe('Highest fee in rupees.'),
      }),
      annotations: { readOnlyHint: true, openWorldHint: true },
      _meta: SCREEN_META,
    },
    async (args) =>
      toResult(
        await findDoctors(householdId, {
          need: args.need,
          patient: args.patient,
          when: args.when,
          nearHome: args.near_home,
          doctorGender: args.doctor_gender,
          language: args.language,
          maxFee: args.max_fee,
        }),
      ),
  );

  registerAppTool(
    server,
    'get_doctor_times',
    {
      title: 'More free times',
      description: 'Show more free times for one doctor from the last list. The doctor can be the number ("1", "pehla"), the name ("Dr. Mehta") or the ref.',
      inputSchema: z.object({
        doctor: z.string().describe('Number, name or ref of the doctor from the last list'),
        when: z.string().optional().describe('Day or time words, e.g. "kal", "Saturday evening"'),
      }),
      annotations: { readOnlyHint: true, openWorldHint: true },
      _meta: SCREEN_META,
    },
    async (args) => toResult(await doctorTimes(householdId, { doctor: args.doctor, when: args.when })),
  );

  registerAppTool(
    server,
    'book_appointment',
    {
      title: 'Hold an appointment',
      description:
        'Hold a free time with a doctor for a family member. This does NOT finish the booking: it holds the time for 5 minutes and returns a ' +
        'confirm card with the doctor, time, fee and the clinic’s instructions. Read it to the user and ask "Shall I book it?". Call ' +
        'confirm_appointment only after a clear yes. To move an existing appointment, pass replaces_appointment.',
      inputSchema: z.object({
        doctor: z.string().describe('Number, name or ref of the doctor from the last list'),
        time: z.string().optional().describe('The time they chose: "6:30", "6:30 wala", "kal 10 baje" or an exact timestamp. Defaults to the first free time.'),
        patient: patientField.optional(),
        replaces_appointment: z.string().optional().describe('Appointment id being rescheduled (from reschedule_appointment).'),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
      _meta: SCREEN_META,
    },
    async (args) =>
      toResult(await bookAppointment(householdId, { doctor: args.doctor, time: args.time, patient: args.patient, replacesAppointment: args.replaces_appointment })),
  );

  registerAppTool(
    server,
    'confirm_appointment',
    {
      title: 'Confirm the appointment',
      description:
        'Finish a booking after the user clearly said yes ("haan", "yes", "book it"). Confirms with the clinic over UHI, saves it in the family’s ' +
        'memory, returns the leave-by time and messages the family.',
      inputSchema: z.object({
        hold_id: z.string().optional().describe('The hold_id from book_appointment. Defaults to the latest hold.'),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
      _meta: SCREEN_META,
    },
    async (args) => toResult(await confirmAppointment(householdId, { holdId: args.hold_id })),
  );

  registerAppTool(
    server,
    'my_appointments',
    {
      title: 'Family appointments',
      description: 'List upcoming doctor appointments for the family, or for one member.',
      inputSchema: z.object({ patient: patientField.optional() }),
      annotations: { readOnlyHint: true },
      _meta: SCREEN_META,
    },
    async (args) => toResult(await myAppointments(householdId, { patient: args.patient })),
  );

  registerAppTool(
    server,
    'cancel_appointment',
    {
      title: 'Cancel an appointment',
      description: 'Cancel an upcoming appointment and tell the clinic. Ask the user to confirm before calling this.',
      inputSchema: z.object({
        appointment: z.string().optional().describe('Appointment id, whose it is ("Dadi’s") or the doctor’s name.'),
      }),
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
      _meta: SCREEN_META,
    },
    async (args) => toResult(await cancelAppointment(householdId, { appointment: args.appointment })),
  );

  registerAppTool(
    server,
    'reschedule_appointment',
    {
      title: 'Move an appointment',
      description:
        'Find new free times with the same doctor for an existing appointment. Then call book_appointment with replaces_appointment; the old ' +
        'time is released only after the new one is confirmed.',
      inputSchema: z.object({
        appointment: z.string().optional().describe('Appointment id, whose it is, or the doctor’s name'),
        when: z.string().optional().describe('New day or time words'),
      }),
      annotations: { readOnlyHint: true, openWorldHint: true },
      _meta: SCREEN_META,
    },
    async (args) => toResult(await prepareReschedule(householdId, { appointment: args.appointment, when: args.when })),
  );

  registerAppTool(
    server,
    'find_usual_doctor',
    {
      title: 'Usual doctor',
      description: 'Find a family member’s usual doctor from past visits and that doctor’s next free times ("book Dadi’s usual sugar check-up").',
      inputSchema: z.object({
        patient: patientField.optional(),
        need: z.string().optional().describe('What kind of visit, in their words, e.g. "sugar check-up"'),
        when: z.string().optional().describe('Day or time words, e.g. "kal subah"'),
      }),
      annotations: { readOnlyHint: true, openWorldHint: true },
      _meta: SCREEN_META,
    },
    async (args) => toResult(await findUsualDoctor(householdId, { patient: args.patient, need: args.need, when: args.when })),
  );

  registerAppTool(
    server,
    'remember_follow_up',
    {
      title: 'Remember a follow-up',
      description: 'Remember that a doctor asked a family member to come back after some time ("Dr. Sharma said come back after 3 months").',
      inputSchema: z.object({
        patient: patientField.optional(),
        after: z.string().describe('How long: "2 weeks", "3 months", "10 din"'),
        doctor: z.string().optional().describe('Doctor name, if different from the last visit'),
        note: z.string().optional().describe('Anything to remember, e.g. "bring sugar reports"'),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false },
      _meta: SCREEN_META,
    },
    async (args) => toResult(await rememberFollowUp(householdId, { patient: args.patient, after: args.after, doctor: args.doctor, note: args.note })),
  );

  registerAppTool(
    server,
    'check_reminders',
    {
      title: 'Due check-ups',
      description: 'List follow-up check-ups that are due now or this week, so they can be booked.',
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true },
      _meta: SCREEN_META,
    },
    async () => toResult(await checkReminders(householdId)),
  );

  registerAppTool(
    server,
    'family_members',
    {
      title: 'Family members',
      description: 'List the family members DocSaathi can book for.',
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true },
      _meta: SCREEN_META,
    },
    async () => toResult(familyList(householdId)),
  );

  registerAppTool(
    server,
    'add_family_member',
    {
      title: 'Add a family member',
      description: 'Add someone to the family so appointments can be booked for them.',
      inputSchema: z.object({
        name: z.string().describe('Their name'),
        relation: z.string().optional().describe('Relation word, e.g. "Nani", "chacha", "bhabhi"'),
        age: z.number().optional().describe('Age in years (helps pick a child doctor)'),
        gender: z.string().optional().describe('"F" or "M"'),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false },
      _meta: SCREEN_META,
    },
    async (args) => {
      const m = addMember(householdId, { name: args.name, relation: args.relation, age: args.age, gender: args.gender });
      return toResult({ speech: `Added ${memberLabel(m)} to the family.`, data: { kind: 'family-added', member: { id: m.id, label: memberLabel(m) } } });
    },
  );

  registerAppTool(
    server,
    'find_nearby_clinics',
    {
      title: 'Real clinics nearby',
      description:
        'Real clinics, hospitals, pharmacies or labs near the family, from Google Maps, with phone numbers, ratings, opening status and ' +
        'directions. These are not on the UHI network yet, so they cannot be booked by voice: the family calls them. Use when they ask ' +
        'for a real clinic, the nearest hospital, a chemist, a lab, or a phone number to call.',
      inputSchema: z.object({
        need: z.string().optional().describe('What they are looking for, in their words, e.g. "nearest hospital", "skin clinic", "chemist"'),
      }),
      annotations: { readOnlyHint: true, openWorldHint: true },
      _meta: SCREEN_META,
    },
    async (args) => toResult(await nearbyPlaces(householdId, { need: args.need })),
  );

  registerAppTool(
    server,
    'set_home_location',
    {
      title: 'Set the family’s location',
      description:
        'Set where the family is, so "near me" and travel times use their own area. Use when they say where they live or are ' +
        '("I live in Rohini, Delhi", "main Andheri mein rehta hoon"). India only.',
      inputSchema: z.object({
        place: z.string().describe('Area and city in their words, e.g. "Rohini, Delhi" or "Andheri West, Mumbai"'),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
      _meta: SCREEN_META,
    },
    async (args) => toResult(await changeLocation(householdId, args.place)),
  );

  // A tool only the screen calls (visibility "app"): the screen has no network access of its own,
  // so it asks the server for the map picture through the host. The assistant never sees this tool.
  registerAppTool(
    server,
    'get_map',
    {
      title: 'Map picture',
      description:
        'For the DocSaathi screen: a map picture with the family home (H) and the clinics shown (numbered pins). With one clinic and ' +
        'route=true, the driving route from home is drawn. Returns a JPEG image.',
      inputSchema: z.object({
        places: z
          .array(z.object({ lat: z.number().min(-90).max(90), lng: z.number().min(-180).max(180), label: z.string().max(1).optional() }))
          .min(1)
          .max(6),
        route: z.boolean().optional(),
      }),
      annotations: { readOnlyHint: true, openWorldHint: true },
      _meta: { ui: { resourceUri: SCREEN_URI, visibility: ['app'] } },
    },
    async (args) => {
      const household = householdById(householdId)!;
      const image = await mapImage({ lat: household.home_lat, lng: household.home_lng }, args.places, Boolean(args.route));
      if (!image) return { content: [{ type: 'text', text: 'No map picture is available (Google Maps is not switched on).' }], isError: true };
      return { content: [{ type: 'image', data: image, mimeType: 'image/jpeg' }] };
    },
  );

  // The screen itself: one self-contained HTML file (no network access needed inside the sandbox).
  registerAppResource(
    server,
    'DocSaathi screen',
    SCREEN_URI,
    {
      mimeType: RESOURCE_MIME_TYPE,
      description: 'Doctor cards, free times, the confirm card and booking details, sized for Echo Show.',
      _meta: { ui: { prefersBorder: false } },
    },
    async () => ({ contents: [{ uri: SCREEN_URI, mimeType: RESOURCE_MIME_TYPE, text: screenHtml() }] }),
  );

  return server;
}
