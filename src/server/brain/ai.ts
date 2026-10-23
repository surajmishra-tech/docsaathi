// AI brain: a language model understands what the family says (any phrasing, in Hindi, English
// or Hinglish) and picks DocSaathi's MCP tools, the way Alexa+ would.
//
// The important things do NOT depend on the model:
//  - Our own rules answer first when they are sure: emergencies, yes/no to a held time, choosing
//    from what is on the screen, a location, a plain "hello". The model gets the free talk.
//  - A booking is only confirmed after the person says yes, in a later turn than the hold.
//  - The model never chooses the patient or the time by itself: if the person did not say who
//    it is for, Alexa asks; if they did not say a time, Alexa shows the times.
//  - "Found / held / booked" is only ever said from a real tool result.
//  - When the model is busy (rate limit) or fails, the rule brain answers instead.
import { memberLabel, membersOf, speakerOf, type Household, type Member } from '../family.js';
import { relationFromText } from '../words.js';
import { clock, formatDay, formatTime } from '../time.js';
import {
  cleanUtterance,
  demoRespond,
  detectMember,
  dropQuestions,
  hasPastVisit,
  namesNewProblem,
  noteToolCall,
  saysGoodbye,
  saysTime,
  stateOf,
  sureReply,
  type BrainReply,
} from './demo.js';
import { isHindi, L, toolSpeech } from './hindi.js';
import { LlmUnavailable, type LlmMessage, type LlmTool } from './llm.js';
import { chat } from './models.js';
import { linkRequired } from '../alexaLink.js';
import { callTool, kindOf, listTools, speechOf, type ToolCall } from './mcpClient.js';

const MAX_STEPS = 3; // model -> tools -> model ... per thing the person says
const MAX_CALLS = 3; // tools per model answer
const KEEP_MESSAGES = 12;

// A tool result that is only a step on the way: the model carries on in the same turn
// ("Added Riya" -> now find the dentist for Riya).
const STEP_KINDS = new Set(['family-added']);
// After these, the next request is a new topic (an earlier "for Dadi" no longer applies).
const TOPIC_DONE = new Set(['booked', 'cancelled', 'follow-up', 'emergency']);
// Tools where "who is it for" matters, and the ones that should not even start without knowing.
const HAS_PATIENT = new Set(['find_doctors', 'find_usual_doctor', 'book_appointment', 'remember_follow_up']);
const ASK_WHO_FIRST = new Set(['find_doctors', 'find_usual_doctor']);

// Words that mean yes to "Shall I book it?" (broad on purpose: a miss only means Alexa asks again).
const AFFIRM = /(\b(yes|yeah|yep|yup|ya|haan|han|haa|hanji|ji|ok|okay|sure|confirm|pakka|theek|thik|done|go ahead|book|kar do|kardo|kar dijiye|karo|please do|do it|chalega|sahi hai|bilkul)\b|हाँ|हां|जी|ठीक|कर दो|बुक|पक्का)/i;
const NEGATIVE = /(\b(mat|nahi|nahin|no|nope|don'?t|do not|cancel|ruko|ruk|wait|not now|rehne do|baad mein|baad me|later)\b|नहीं|मत)/i;
// The model saying it DID something. Only true when a tool really did it in this turn.
const CLAIM = /\b(i have|i've|i|we have|we've)\s+(now\s+|just\s+|already\s+)?(held|booked|confirmed|cancelled|canceled|added|scheduled|reserved|found|moved|rescheduled|noted|saved|set|updated|changed|sent)\b|\b(is|are|has been|have been)\s+(now\s+)?(booked|confirmed|cancelled|canceled|held|scheduled|reserved|saved|updated)\b/i;
const NEGATED = /\b(not|nothing|never|haven't|hasn't|isn't|wasn't|can't|cannot|won't|didn't|don't|until|before|once|after)\b/i; // "nothing is booked until you say yes" is fine
// The model saying it WILL do something and then stopping, without calling the tool or asking anything.
const PROMISE = /\b(i'll|i will|i am going to|i'm going to|let me)\s+(now\s+|just\s+)?(book|hold|confirm|cancel|add|schedule|reserve|find|look|check|search|note|save|set|update)\b/i;
// Medicine names and doses must never be spoken.
const MEDICINE = /\b(paracetamol|crocin|dolo|calpol|ibuprofen|brufen|combiflam|aspirin|disprin|antibiotics?|azithro\w*|amoxi\w*|cetirizine|pantoprazole|omeprazole|\d+\s?mg)\b/i;
// The same guards when the model answers in Hindi.
const CLAIM_HI = /(बुक (कर दिया|कर दी|हो गया)|कन्फर्म (कर दिया|हो गया)|रद्द (कर दिया|हो गया)|जोड़ दिया|होल्ड कर (दिया|लिया)|रोक (दिया|लिया)|सेव कर (दिया|लिया)|ढूँढ (लिए|लिया)|मिल गए)/;
const PROMISE_HI = /(बुक कर (देती|दूँगी|रही)|कर देती हूँ|ढूँढ(ती)? (रही )?हूँ|देखती हूँ)/;
const MEDICINE_HI = /(पैरासिटामोल|पेरासिटामोल|क्रोसिन|डोलो|कैलपोल|आइबुप्रोफेन|एस्पिरिन|एंटीबायोटिक)/;
// The model asking who is talking ("Who am I speaking with?", "aap kaun bol rahe hain?").
const ASKS_WHO = /(who am i (speaking|talking) (with|to)|who is (speaking|talking)|who are you\b.*\?|may i know who|kaun bol (raha|rahi|rahe)|आप कौन|किससे बात|कौन बोल)/i;

// Always the same text, so the model provider can cache it. Everything that changes (the family,
// the place, the time) goes into the latest message instead.
const SYSTEM = `You are Alexa with the DocSaathi add-on, a friendly voice assistant that finds and books doctors for an Indian family. Talk like a kind clinic receptionist.
- People speak Hindi, English or Hinglish, sometimes in Hindi script. Reply in 1 or 2 short, simple spoken sentences, in the reply language named with their message. No lists, symbols or emojis. Answer greetings and small talk in one sentence, then offer help.
- To find a doctor you need two things: the problem (or the kind of doctor) and who it is for. As soon as you have both, call find_doctors in the same turn. Do not ask first: not when (no day or time said means the soonest free times), not what kind of doctor, and not whether the person they named is right.
- Pass their own words as "need". If you know the kind of doctor, add it in English at the end, e.g. "kam sunai deta hai, ENT" or "periods are irregular, gynecologist".
- When they talk about themselves ("meri tabiyat", "mujhe", "I", "my"), it is for the person speaking: pass patient "me" (DocSaathi knows who is speaking, or asks them). If the problem or the person is missing, ask one short question for just that. Never guess the person.
- They choose a doctor but no time: get_doctor_times. They say a time or "the earliest": book_appointment (it only holds the time). confirm_appointment only after a clear yes to "Shall I book it?".
- Someone not in the family list ("meri beti", "Rohit"): ask their name and age, call add_family_member, then continue with what they wanted.
- The doctors you can book are on the UHI network. If they want a real clinic to call, the nearest hospital, a chemist or a lab: find_nearby_clinics.
- Pass days and times as they said them ("kal subah", "6:30 baje").
- To do anything, call a tool. Never say you did or will do something without calling it. For what is already booked, call my_appointments; do not answer it from memory.
- Never diagnose or suggest medicines, doses or home remedies: say a doctor should check it and offer to find one.
- Emergency signs (chest pain, cannot breathe, unconscious, stroke, heavy bleeding, self-harm): say call 112 now, or 108 for an ambulance, and do not book.
- You only help with doctors and appointments; for anything else say so kindly in one sentence. Never read ids aloud.`;

// What the model sees of each MCP tool: a short description and only the parameters it should
// fill (param -> hint). Types and "required" come from the MCP server's own tools/list. The ids
// (hold, appointment being moved) are filled in by this code, not by the model.
const FOR_MODEL: Record<string, { about: string; params: Record<string, string> }> = {
  find_doctors: { about: 'Find doctors with free times for a problem or a kind of doctor.', params: { need: 'the problem or kind of doctor in their words, plus any wish they said ("lady doctor", "Marathi bolne wala", "paas mein")', patient: 'name or relation word they said, or "me"', when: 'day or time words they said' } },
  get_doctor_times: { about: 'Free times of one doctor from the list, so they can choose one.', params: { doctor: 'number or name from the list', when: '' } },
  book_appointment: { about: 'Hold the chosen time with a doctor. Not final: it returns a summary to confirm.', params: { doctor: 'number or name from the list', time: 'the time they said', patient: '' } },
  confirm_appointment: { about: 'Finish the booking. Only after a clear yes to "Shall I book it?".', params: {} },
  my_appointments: { about: 'List upcoming appointments.', params: { patient: '' } },
  cancel_appointment: { about: 'Cancel an upcoming appointment.', params: { appointment: 'whose it is, or the doctor name' } },
  reschedule_appointment: { about: 'Find new times to move an existing appointment.', params: { appointment: 'whose it is, or the doctor name', when: '' } },
  find_usual_doctor: { about: "A family member's usual doctor from past visits, with the next free time.", params: { patient: '', need: '', when: '' } },
  remember_follow_up: { about: 'Remember that a doctor asked someone to come back after some time.', params: { patient: '', after: 'how long, e.g. "3 months"' } },
  check_reminders: { about: 'Check-ups that are due.', params: {} },
  family_members: { about: 'List the family members.', params: {} },
  add_family_member: { about: 'Add someone new to the family.', params: { name: '', relation: 'relation word, e.g. "beti"', age: '', gender: '"F" or "M"' } },
  set_home_location: { about: 'Set where the family lives, for "near me".', params: { place: 'area and city' } },
  find_nearby_clinics: { about: 'Real clinics, hospitals, chemists or labs nearby from Google Maps, with phone numbers. They can be called, not booked.', params: { need: 'what they are looking for, in their words' } },
};

interface Talk {
  messages: LlmMessage[];
  topicStart: number; // where the current topic began (see TOPIC_DONE)
}
const talks = new Map<string, Talk>();

export function resetAi(householdId: string): void {
  talks.delete(householdId);
}

/** Alexa said something by herself (news from a clinic): the model should know, for the answer that follows. */
export function rememberAnnouncement(householdId: string, speech: string): void {
  const talk = talks.get(householdId);
  if (talk) talk.messages.push({ role: 'user', content: '(Nothing was said. Alexa gives news on her own.)' }, { role: 'assistant', content: speech });
}

// ---------------------------------------------------------------------------
// The tools come from the MCP server itself (tools/list), like any MCP client gets them.

interface McpTool {
  name: string;
  description?: string;
  inputSchema?: { properties?: Record<string, { type?: string; description?: string }>; required?: string[] };
  _meta?: { ui?: { visibility?: string[] } };
}

let toolCache: { tools: LlmTool[]; schemas: Map<string, McpTool> } | undefined;

function shorten(text: string | undefined, max: number): string {
  const t = (text ?? '').replace(/\s+/g, ' ').trim();
  if (t.length <= max) return t;
  const cut = t.slice(0, max);
  const stop = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf(': '), cut.lastIndexOf(', '));
  return (stop > max * 0.5 ? cut.slice(0, stop) : cut).trim();
}

async function toolsFor(householdId: string) {
  if (toolCache) return toolCache;
  // Tools marked for the screen only (MCP Apps visibility "app", like the map picture) are not for the model.
  const list = ((await listTools(householdId)).tools as unknown as McpTool[]).filter((t) => t._meta?.ui?.visibility?.includes('model') ?? true);
  toolCache = {
    schemas: new Map(list.map((t) => [t.name, t])),
    tools: list.map((t) => {
      const required = t.inputSchema?.required ?? [];
      const all = t.inputSchema?.properties ?? {};
      const shown = FOR_MODEL[t.name];
      // A tool added to the server later still works: all its parameters, descriptions shortened.
      const params = shown ? Object.keys(shown.params).filter((k) => k in all) : Object.keys(all);
      return {
        name: t.name,
        description: shown?.about ?? shorten(t.description, 120),
        parameters: {
          type: 'object',
          properties: Object.fromEntries(
            params.map((k) => {
              const hint = shown ? shown.params[k] : shorten(all[k].description, 70);
              // Optional values may be left out or sent as null.
              return [k, { type: required.includes(k) ? (all[k].type ?? 'string') : [all[k].type ?? 'string', 'null'], ...(hint ? { description: hint } : {}) }];
            }),
          ),
          required: required.filter((k) => params.includes(k)),
        },
      };
    }),
  };
  return toolCache;
}

/** Drop empty values; turn "25" into 25 where the tool wants a number. */
function tidyArgs(args: Record<string, unknown>, tool: McpTool | undefined): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args)) {
    if (v === null || v === undefined || v === '') continue;
    const type = tool?.inputSchema?.properties?.[k]?.type;
    if (type === 'number' && typeof v === 'string' && Number.isFinite(Number(v))) out[k] = Number(v);
    else if (type === 'boolean' && typeof v === 'string') out[k] = /^(true|yes|1)$/i.test(v);
    else if (type === 'string' && typeof v !== 'string') out[k] = String(v);
    else out[k] = v;
  }
  return out;
}

// ---------------------------------------------------------------------------

/** What the model needs to know right now: who is in the family, where they are, the time. */
function context(household: Household, holding: boolean): string {
  const members = membersOf(household.id);
  const speaker = members.find((m) => m.speaker);
  const family = members.map((m) => `${memberLabel(m)}${m.age !== null ? ` ${m.age}` : ''}`).join('; ');
  const now = clock.now();
  return (
    `Already known, do not act on it. Family: ${family}. ` +
    `${speaker ? `The person speaking is ${memberLabel(speaker)}.` : 'Who is speaking is not known yet (any family member may be talking).'} ` +
    `Their area: ${household.home_address}. Time now: ${formatDay(now)} ${now.getUTCFullYear()}, ${formatTime(now)} India time.` +
    `${holding ? ' A time is held and waiting for their yes or no.' : ''}` +
    ` Reply language: ${isHindi(household) ? 'Hindi, written in Hindi script, polite and simple; you are a woman, so say "सकती हूँ", "करूँगी" (keep names, times and numbers as they are)' : 'English'}.`
  );
}

// The location tool is only offered when they seem to be talking about where they are,
// and only runs for a place they actually said.
const PLACE_TALK = /\b(live|lives|living|stay|staying|shift\w*|moved?|rehta|rehti|rehte|location|address|ghar|area|city|sheher|shehar|pata|colony|sector|nagar)\b|रहत|घर|शहर|पता/i;
function placeWasSaid(place: unknown, t: string): boolean {
  const said = t.toLowerCase();
  return String(place ?? '')
    .toLowerCase()
    .split(/[^a-zऀ-ॿ]+/)
    .some((w) => w.length >= 4 && said.includes(w));
}

/** Where the latest part of the conversation starts: at something the person said. */
function recentStart(history: LlmMessage[]): number {
  let start = Math.max(0, history.length - KEEP_MESSAGES);
  while (start < history.length && history[start].role !== 'user') start++;
  return start;
}

/**
 * Who the person said it is for, in this topic. The model's own idea of the patient is only
 * accepted if the person really mentioned them; otherwise the latest person they did mention.
 */
function patientFor(household: Household, talk: Talk, wanted: unknown): { patient?: string; unknown?: boolean } {
  const userSaid = talk.messages.slice(talk.topicStart).flatMap((m) => (m.role === 'user' && !m.content.startsWith('(') ? [m.content] : []));
  const said = userSaid.map((text) => detectMember(household, text)).filter((m): m is Member => Boolean(m));
  const kept = stateOf(household.id).patient; // from an earlier step of this booking
  const keptMember = kept ? detectMember(household, kept) : undefined;
  if (typeof wanted === 'string' && wanted.trim()) {
    const member = detectMember(household, wanted);
    if (!member) return { patient: wanted, unknown: true }; // someone new ("beti"), or "me" while nobody knows who is talking: the server asks
    if (said.some((m) => m.id === member.id) || keptMember?.id === member.id) return { patient: member.name };
  }
  // They talked about themselves ("mujhe", "meri"), and nobody knows who is talking: the server asks
  // "Who am I speaking with?" (never a guess, and never Mummy by default).
  if (!speakerOf(household.id) && userSaid.some((text) => relationFromText(text) === 'self')) return { patient: 'me', unknown: true };
  const latest = said.at(-1) ?? keptMember;
  return { patient: latest?.name };
}

const byRules = (reply: BrainReply): BrainReply => ({ ...reply, by: 'rules' });

// ---------------------------------------------------------------------------

export async function aiRespond(household: Household, text: string): Promise<BrainReply> {
  const t = cleanUtterance(text);
  const talk = talks.get(household.id) ?? { messages: [], topicStart: 0 };
  talks.set(household.id, talk);
  if (talk.messages.length > 80) {
    const drop = talk.messages.length - 40;
    talk.messages.splice(0, drop);
    talk.topicStart = Math.max(0, talk.topicStart - drop);
  }

  /** The rules answered this turn; the AI still gets to know what was said. */
  const heard = (reply: BrainReply): BrainReply => {
    if (t) talk.messages.push({ role: 'user', content: t }, { role: 'assistant', content: reply.speech });
    if (TOPIC_DONE.has(reply.kind)) talk.topicStart = talk.messages.length;
    return byRules(reply);
  };

  if (!t) return heard(await demoRespond(household, text)); // just "Alexa"

  // 1. The moments our own rules are sure about (emergency, yes/no, a choice on the screen, a location).
  const sure = await sureReply(household, text);
  if (sure) return heard(sure);

  // 2. Everything else: the model understands it.
  const before = talk.messages.length;
  try {
    dropQuestions(household.id); // the model leads now; forget what the rule brain was waiting on
    const reply = await aiTurn(household, t, talk);
    if (TOPIC_DONE.has(reply.kind)) talk.topicStart = talk.messages.length;
    return reply;
  } catch (err) {
    if (linkRequired(err)) throw err; // the rules could not call the tools either: Alexa asks to link
    const busy = err instanceof LlmUnavailable;
    if (busy) console.warn(`[ai] the rule brain answers this turn: ${err.message}`);
    else console.error('[ai]', err);
    talk.messages.length = before;
    const reply = await demoRespond(household, text);
    // The rules did not understand it either: that is only because the AI was busy. Ask them to repeat.
    if (reply.unsure) return byRules({ ...reply, speech: L(household, 'busy') });
    return heard(reply);
  }
}

async function aiTurn(household: Household, t: string, talk: Talk): Promise<BrainReply> {
  const history = talk.messages;
  const state = stateOf(household.id);
  const heldBefore = Boolean(state.pendingHold); // a time held in an earlier turn, waiting for yes/no
  const { tools: allTools, schemas } = await toolsFor(household.id);
  const tools = PLACE_TALK.test(t) ? allTools : allTools.filter((tool) => tool.name !== 'set_home_location');
  const said: LlmMessage = { role: 'user', content: t };
  history.push(said);
  // Only the message being answered carries the context; older ones stay as they were said.
  const withContext: LlmMessage = { role: 'user', content: `(${context(household, heldBefore)})\nThey say: ${t}` };
  // The window is fixed for the whole turn, so each request in it starts with exactly the same text
  // as the one before (the model provider can cache it, and Claude's thinking stays valid).
  const from = recentStart(history);
  const messages = (): LlmMessage[] => [{ role: 'system', content: SYSTEM }, ...history.slice(from).map((m) => (m === said ? withContext : m))];

  let last: ToolCall | null = null; // the latest tool that ran (its screen is shown)
  const spoken: string[] = []; // what the tools that ran in this turn say, in the family's language
  const spokenEn: string[] = []; // the same in English, which is what the model's history keeps (shorter)
  let model = '';
  let nudged = false;
  let blockedBooking = false; // the model tried to confirm before the person said yes

  const joined = (parts: string[]) => [...new Set(parts)].join(' ');
  const finish = (speech: string, kind: string, extra: Partial<BrainReply> = {}, remembered = speech): BrainReply => {
    history.push({ role: 'assistant', content: remembered });
    return { speech, kind, tool: last, by: model || 'ai', ...extra };
  };
  /** A tool ran but the model cannot carry on: say the tool's result, and keep the conversation going. */
  const fromTools = (): BrainReply => {
    let speech = joined(spoken);
    if (kindOf(last!) === 'family-added') {
      const name = String(last!.arguments.name ?? 'they');
      state.awaitingProblem = { patient: name };
      speech += ` ${L(household, 'whatFor', name)}`;
    }
    return finish(speech, kindOf(last!), {}, joined(spokenEn));
  };

  for (let step = 0; step < MAX_STEPS; step++) {
    let answer;
    try {
      answer = await chat(messages(), tools);
    } catch (err) {
      if (last) return fromTools(); // never do a turn twice
      throw err;
    }
    model = answer.model;

    // --- The model talks (a question, small talk, or the next line after a step).
    if (answer.toolCalls.length === 0) {
      let speech = answer.text;
      if (!speech) {
        if (last) return fromTools();
        throw new LlmUnavailable('the model gave an empty answer');
      }
      if (MEDICINE.test(speech) || MEDICINE_HI.test(speech)) speech = L(household, 'noAdvice');
      const asks = /[?？]/.test(speech);
      const claims =
        (CLAIM.test(speech) && !NEGATED.test(speech)) || (PROMISE.test(speech) && !asks) || (CLAIM_HI.test(speech) && !speech.includes('नहीं')) || (PROMISE_HI.test(speech) && !asks);
      if (!last && claims) {
        // It says it did (or will do) something, but no tool ran. Ask once more; if it insists, use the rules.
        if (nudged) throw new LlmUnavailable('the model talked about an action without calling a tool');
        nudged = true;
        history.push({ role: 'assistant', content: speech }, { role: 'user', content: '(Note: no tool was called, so nothing was done. Call the right tool now, or ask one short question. Do not say that something was or will be done.)' });
        continue;
      }
      if (nudged) history.splice(-2, 2); // forget the correction
      if (heldBefore && NEGATIVE.test(t) && !last) {
        // "abhi rehne do": the held time is let go, and we say so plainly (no "I'll keep it for you").
        state.pendingHold = undefined;
        speech = L(household, 'notBookedLater');
      }
      // The model asked in its own words who is talking: the answer ("Papa") is then taken by our rules.
      if (!last && !speakerOf(household.id) && ASKS_WHO.test(speech)) state.awaitingSpeaker = {};
      return finish(speech, last ? kindOf(last) : 'chat', saysGoodbye(t) ? { end: true } : {});
    }

    // --- The model uses tools.
    if (nudged) {
      history.splice(-2, 2);
      nudged = false;
    }
    history.push(answer.message);
    let waiting = false; // a result is ready to be said: the person answers before anything else runs
    let askWho = false;
    for (const [i, call] of answer.toolCalls.entries()) {
      const tell = (content: string) => history.push({ role: 'tool', tool_call_id: call.id, content });
      if (!schemas.has(call.name)) {
        tell(`There is no tool called ${call.name}.`);
        continue;
      }
      if (i >= MAX_CALLS || waiting || askWho) {
        tell('Skipped: say the result first and wait for their answer.');
        continue;
      }
      // The heart of "nothing is booked until you say yes": the hold must be from an earlier turn,
      // and what they just said must be a yes.
      if (call.name === 'confirm_appointment' && !(heldBefore && AFFIRM.test(t) && !NEGATIVE.test(t))) {
        tell('NOT booked: they have not clearly said yes yet. Ask "Shall I book it?" and wait for their answer.');
        blockedBooking = true;
        continue;
      }
      let name = call.name;
      let args = tidyArgs(call.arguments, schemas.get(call.name));
      if (name === 'set_home_location' && !placeWasSaid(args.place, t)) {
        tell('Not run: they did not say a new place. Do what they asked for instead.');
        continue;
      }

      // "Mere appointments" means the family's appointments, not only the speaker's own.
      if (name === 'my_appointments' && args.patient && (relationFromText(String(args.patient)) === 'self' || detectMember(household, String(args.patient))?.speaker)) {
        delete args.patient;
      }

      // They named a new problem ("aur meri aankh bhi"): that is a new search, whatever the model picked.
      if ((name === 'get_doctor_times' || name === 'book_appointment') && namesNewProblem(household.id, t)) {
        name = 'find_doctors';
        args = { need: t };
      }

      // The ids are ours to fill in, not the model's.
      if (name === 'confirm_appointment') args = { hold_id: state.pendingHold };
      if (name === 'book_appointment' && state.replaces) args.replaces_appointment = state.replaces;

      // Who it is for must come from the person, never from the model's guess.
      if (HAS_PATIENT.has(name)) {
        const who = patientFor(household, talk, args.patient);
        if (who.patient) args.patient = who.patient;
        else delete args.patient;
        if (!who.patient && ASK_WHO_FIRST.has(name)) {
          // (The other tools ask by themselves; a search should know the person first: a child needs a child doctor.)
          tell('Not run: they have not said who it is for. They are being asked now.');
          askWho = true;
          continue;
        }
        // Memory first: someone who has seen this kind of doctor before gets their usual doctor.
        const member = who.unknown ? undefined : detectMember(household, String(args.patient ?? ''));
        if (name === 'find_doctors' && member && hasPastVisit(household, member, String(args.need ?? ''))) {
          name = 'find_usual_doctor';
          args = { patient: member.name, need: args.need, when: args.when };
        }
      }
      // They picked a doctor from the list but said no time: show the times and ask, never guess one.
      if (name === 'book_appointment' && state.lastKind === 'doctors' && !saysTime(t)) {
        name = 'get_doctor_times';
        args = { doctor: args.doctor };
      }

      let done: ToolCall;
      try {
        done = await callTool(household.id, name, args);
      } catch (err) {
        if (linkRequired(err)) throw err;
        tell(`The tool failed: ${err instanceof Error ? err.message : String(err)}`.slice(0, 300));
        continue;
      }
      if (done.result.isError && kindOf(done) === 'unknown') {
        // The tool did not accept the arguments: that is for the model to fix, not for the family to hear.
        tell(`The tool did not accept that: ${speechOf(done)}`.slice(0, 400));
        continue;
      }
      noteToolCall(household.id, done);
      last = done;
      spoken.push(toolSpeech(household, done));
      spokenEn.push(speechOf(done));
      if (STEP_KINDS.has(kindOf(done))) {
        tell(`[${kindOf(done)}] ${speechOf(done)}`.slice(0, 400));
      } else {
        tell(`[${kindOf(done)}] Done. Its result is said to the person next.`);
        waiting = true;
      }
    }

    if (last && !STEP_KINDS.has(kindOf(last))) return finish(joined(spoken), kindOf(last), {}, joined(spokenEn));
    if (askWho) return finish(`${spoken.length ? `${joined(spoken)} ` : ''}${L(household, 'whoFor')}`, 'question');
    // Otherwise (a step on the way, a blocked booking, or a tool that needs fixing): the model carries on.
  }

  if (last) return fromTools();
  if (blockedBooking) return finish(L(household, state.pendingHold ? 'bookItQuestion' : 'nothingWaitingYet'), 'question');
  throw new LlmUnavailable('the model did not finish the turn');
}
