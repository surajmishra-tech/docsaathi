// Demo brain: a small rule-based "Alexa" that talks like a helpful receptionist, keeps the
// conversation state, and calls DocSaathi's MCP tools. Used when no AWS account is set up,
// so judges can run the full demo offline. (The Bedrock brain replaces this with a real model.)
import { db } from '../db.js';
import { memberSpoken, resolveMember, setReplyLanguage, setSpeaker, speakerOf, type Household, type Member } from '../family.js';
import { clock, DAY_WORD, istParts, normalizeIndic, parseDurationDays, PART_WORD } from '../time.js';
import { checkEmergency, languageFromText, RELATIONS, relationFromText, resolveSpecialty } from '../words.js';
import { L, toolSpeech } from './hindi.js';
import { callTool, kindOf, speechOf, type ToolCall } from './mcpClient.js';

export interface BrainReply {
  speech: string;
  kind: string;
  tool: ToolCall | null;
  end?: boolean; // they said goodbye: a hands-free mic can close
  by?: string; // who understood this turn: an AI model name, or 'rules'
  unsure?: boolean; // the rules did not understand it (the generic "sorry" answer)
  lang?: 'en' | 'hi'; // the language of `speech`, so the right voice reads it
  speaker?: string | null; // who is talking after this turn (member id), so the screen can show it
}

type Pending = { name: string; args: Record<string, unknown> };

export interface ConversationState {
  patient?: string; // member name the conversation is about
  pendingHold?: string; // a held time waiting for "yes"
  lastKind?: string;
  lastDoctor?: string;
  lastDoctors?: string[]; // names on the doctor list, so "Mehta wali" is a choice
  lastTimes?: string[]; // times on the screen, so "doosra wala" is a time
  lastSearch?: Record<string, unknown>; // to search again for another day
  replaces?: string; // appointment being rescheduled
  awaiting?: Pending; // a call that needs to know who it is for
  awaitingProblem?: { patient?: string; when?: string; askedAgain?: boolean }; // we asked "what's the problem?"
  awaitingSpeaker?: { pending?: Pending; askedAgain?: boolean }; // we asked "Who am I speaking with?"
  // adding someone to the family (`becomesSpeaker`: it is the person talking, introducing themselves)
  newPerson?: { relation?: string; name?: string; age?: number; askedAge?: boolean; resume?: Pending; becomesSpeaker?: boolean };
  offer?: string; // we offered to find a doctor for this; "yes" does it
  due?: string; // whose check-up is due (we asked "Shall I find a time?")
  lastChat?: 'how'; // we just asked "how are you?"
  greeted?: boolean;
}

const states = new Map<string, ConversationState>();

export function resetConversation(householdId: string): void {
  states.delete(householdId);
}

// ---------------------------------------------------------------------------
// Shared with the AI brain, so both brains know where the conversation is and the rules can
// take over for a turn when the AI is busy.

export function stateOf(householdId: string): ConversationState {
  const state = states.get(householdId) ?? {};
  states.set(householdId, state);
  return state;
}

/** The AI brain called a tool: keep the rule brain's picture of the conversation up to date. */
export function noteToolCall(householdId: string, call: ToolCall): void {
  const state = stateOf(householdId);
  remember(state, call);
  const patient = call.arguments.patient;
  if (typeof patient === 'string' && patient && !call.result.isError && kindOf(call) !== 'question') state.patient = patient;
}

/** The AI brain is leading: forget any question the rule brain was waiting on. */
export function dropQuestions(householdId: string): void {
  clearQuestions(stateOf(householdId));
}

/** What they said, without the wake word, and with Hindi-script time words made readable. */
export function cleanUtterance(text: string): string {
  return normalizeIndic(text).replace(WAKE, ' ').replace(/\s+/g, ' ').trim();
}

/** Did they say a time ("6:30 baje"), or that any time will do ("sabse pehla")? */
export const saysTime = (t: string): boolean => CLOCK.test(t) || EARLIEST.test(t);
/** They named a different problem from the one on the screen ("aur meri aankh bhi"): a new search, not a choice. */
export function namesNewProblem(householdId: string, t: string): boolean {
  const now = resolveSpecialty(t);
  if (now.reason !== 'words' || DOCTOR_NAME.test(t) || ORDINAL.test(t) || CLOCK.test(t)) return false;
  const search = stateOf(householdId).lastSearch;
  return !search || resolveSpecialty(String(search.need ?? '')).code !== now.code;
}

export const saysGoodbye = (t: string): boolean => BYE.test(t) || /\b(bye+|goodbye|alvida|tata|itna hi|that'?s all|nothing else)\b/i.test(t);

const WAKE = /\b(?:hey |ok |okay )?alexa\b[\s,.!?]*/gi;
// Yes / no / "the second one" also in Hindi script: Chrome's Hindi voice input writes Devanagari.
const YES = /^\s*((yes|yeah|yep|yup|haan|han|haa|ha|hanji|haan ji|ji|ji haan|ok|okay|sure|confirm|go ahead|please do|theek hai|thik hai|book it|book kar do|book karo|kar do|karo|done|pakka)\b|हाँ|हां|जी|ठीक है|कर दो|बुक कर दो|पक्का)/i;
const NO = /^\s*((no|nope|nahi|nahin|na|mat|rehne do|don'?t|cancel that)\b|नहीं|मत|रहने दो)/i;
const NEVER_MIND = /(rehne do|chhod[oe]|chod[oe]|never ?mind|leave it|forget it|jaane do|jane do|kuch nahi|kuch nahin|^nothing)/i;
const FOLLOW_UP = /(come back|wapas|vapas|dobara|follow.?up|phir se|again|revisit|review)/i;
const REMINDERS = /(reminder|remind|due|koi check.?up|checkup due|check-up due|yaad)/i;
const CANCEL = /\b(cancel|radd|hata do|hatao)\b/i;
const RESCHEDULE = /(reschedule|change the time|time badal|badal do|move it|shift)/i;
const LIST = /(my appointments|all appointments|upcoming appointments|appointments? (kab|list|dikhao|batao)|show (my |the |all )?(appointments|schedule)|kab hai|when is|kaun ?se appointment|mere appointment)/i;
const USUAL = /(usual|hamesha|regular|same doctor|pichli baar|last time|wahi doctor|wohi doctor)/i;
const MORE_TIMES = /(more times|other times|aur time|dusra time|doosra time|kab kab|times for|show times|change time)/i;
const FAMILY = /(family members|who is in my family|parivaar|parivar)/i;
const PICK = /(\b(book|wala|wali|wale|yeh|ye|this one|that one|pehl[aei]|pahl[aei]|doosr[aei]|dusr[aei]|teesr[aei]|first|second|third)\b|\b[1-5]\b|\bdr\.?\s|वाला|वाली|वाले|पहल[ाेी]|दूसर[ाेी]|तीसर[ाेी])/i;
const DOCTOR_NAME = /\bdr\.?\s/i;
const ORDINAL = /\b(pehl[aei]|pahl[aei]|doosr[aei]|dusr[aei]|teesr[aei]|first|second|third)\b|\b[1-5]\b(?!\s*(am|pm|baje|:))|पहल[ाेी]|दूसर[ाेी]|तीसर[ाेी]/i;
const ORDINAL_INDEX: Array<[RegExp, number]> = [
  [/\b(pehl[aei]|pahl[aei]|first|1st)\b|पहल[ाेी]/i, 0],
  [/\b(doosr[aei]|dusr[aei]|second|2nd)\b|दूसर[ाेी]/i, 1],
  [/\b(teesr[aei]|tisr[aei]|third|3rd)\b|तीसर[ाेी]/i, 2],
  [/\b(chauth[aei]|fourth|4th)\b|चौथ[ाेी]/i, 3],
];
// Signs that a sentence is more than a plain choice (the AI brain should understand it instead).
const HEDGE = /\b(lekin|magar|but|instead|change|badal\w*|another|different|koi aur|aur koi|ya|or)\b/i;
const QUESTION = /\?|\b(kya|kitn[aei]|kaun|kahan|kaha|kaise|kyun|kyon|what|which|how|where|why|when|who|fees?|charges?|distance|reviews?|experience)\b/i;
const NOT = /\b(nahi|nahin|not|no|mat|don'?t)\b/i;
const EARLIEST = /(earliest|first available|next available|as soon as|sabse pehl|sabse jaldi|jaldi se jaldi|koi bhi (time|samay)|any ?time|kabhi bhi|first slot|pehla (time|slot|samay))/i;
const CLOCK = /(\d{1,2}[:.]\d{2}\s*(am|pm)?|\d{1,2}\s*(am|pm|baje))/i;
const NAME_IS = /(?:naam|name(?:\s+is)?)\s*(?:hai\s+)?([A-Za-zऀ-ॿ]{2,})/i;
const AGE = /(\d{1,3})\s*(?:saal|sal|years?|yrs?|varsh)|age\s*(\d{1,3})/i;
const AGE_UNKNOWN = /(pata nahi|nahi pata|don'?t know|not sure|maloom nahi|skip)/i;
const ADD_MEMBER = /\b(add|jodo|jod do|shamil)\b.*\b(family|parivaa?r|member)\b|\b(new|naya|nayi) (family )?member\b/i;

// Everyday talk
const GREETING = /^(hello+|hi+|hey+|helo|hullo|namaste|namaskaa?r|pranam|salaam|salam|ram ram|radhe radhe|sat sri akal|good (morning|afternoon|evening)|suprabhat|नमस्ते|नमस्कार|हेलो|हैलो|हाय)(?![a-z])/i;
const HOW_ARE_YOU = /(how are (you|u)|how r u|how're you|how do you do|kaise ho|kaisi ho|kaise hain|kya haal|kya hal|what'?s up|wassup|कैसे हो|कैसी हो|कैसे हैं|क्या हाल)/i;
const I_AM_FINE = /\b(fine|good|great|well|theek|thik|badhiya|accha|acha|achha|mast)\b/i;
const THANKS = /(thank|thanx|thx|shukriya|dhanyavaa?d|dhanyawad|धन्यवाद|शुक्रिया)/i;
const BYE = /^(bye+|good ?bye|tata|alvida|see you|ok bye|okay bye|chalo bye|phir milte|phir milenge|good night|that'?s all|that is all|nothing else|bas itna hi|bas|stop)(?![a-z])/i;
const ABOUT = /(who are you|what are you|tum kaun|aap kaun|kaun ho|your name|tumhara naam|aapka naam|what can you do|what do you do|kya kar sakt|kya kya kar|how (do|does) (you|this|it) work|kaise kaam|^help$|help me$|madad karo|तुम कौन|आप कौन|क्या कर सकत)/i;
const REAL = /(real doctor|asli doctor|asli hai|really book|sach ?(mein|me) book|test data|\bfake\b|nakli)/i;
const ADVICE = /(which (medicine|tablet|drug|syrup)|what (medicine|tablet)|(kya|kaun ?si|konsi) (dawai|dawa|dava|medicine|tablet|goli)|dawai? bata|medicine bata|what should i (take|do|eat)|kya (khau|khaun|khaaun|khana chahiye|lu|loon|lena chahiye)|home remed|gharelu|nuskh|dosage|\bdose\b|is (it|this) serious|serious hai kya|kya bimari|konsi bimari|what (disease|illness)|ilaj bata|upay bata)/i;
const WHERE = /(where am i|meri location kya|location kya hai|kaun ?si location|which (city|area|location)|konsi city)/i;
// Asking for a REAL place to call or go to (from Google Maps), not a doctor to book.
const REAL_PLACE = /\bjan ?aushadhi|\b(real|asli)\s+(clinics?|hospitals?)|\b(nearest|nearby|closest|nazdeeki?)\s+(hospital|aspatal|clinic|chemist|pharmacy|medical store|lab)|\bpaas (ka|ki|ke|mein|me)( koi)? (hospital|aspatal|clinic|chemist|pharmacy|medical store|lab)\b|\b(hospital|aspatal|chemist|pharmacy|medical store|dawai? ki dukaan|pathology|blood test)\b.*\b(kahan|kaha|near|paas|nearest|batao|dikhao|find|where)\b|google maps|(phone|contact) number|clinic ka number|call kar(na|ne)/i;
const LOCATION: RegExp[] = [
  /\b(?:i live in|i stay in|i am in|i'm in|im in|we live in|my location is|my address is|my home is in|(?:set|change) (?:my )?(?:location|home|address) to)\s+(.+)$/i,
  /\b(?:main|mai|mein|hum|ham)\s+(.+?)\s+(?:mein|me|main)\s+(?:rehta|rehti|rehte|hoon|hu|hun|hain)\b/i,
  /\b(?:mera|meri|hamara|humara)\s+(?:ghar|location|address|pata)\s+(.+?)\s+(?:(?:mein|me)\s+)?(?:hai|hain)\b/i,
];

// Signs that they want a doctor, even if they haven't said what for.
const WANTS_DOCTOR = /(doctor|docter|daktar|dactar|\bdr\b|डॉक्टर|डाक्टर|clinic|hospital|aspatal|appointment|apointment|check.?up|dikhana|dikhwana|dikha ?do|ilaj|treatment|consult|specialist|physician|\bbook\b)/i;
const UNWELL = /(tabiyat|tabiyet|bimar|beemar|\bsick\b|unwell|not (feeling )?well|feeling (bad|low|ill|sick)|\bill\b|\bdard\b|\bpain|takleef|taklif|dikkat|problem|pareshani|(achha|accha|acha|theek|thik) nahi|\bchot\b|injur|swelling|sujan|soojan|तबीयत|बीमार|दर्द|तकलीफ)/i;
// Feeling unwell in a word ("bukhaar hai"), so Alexa says she is sorry before asking anything.
const SYMPTOM = /(bukha+r|fever|khansi|cough|ulti|vomit|chakkar|dizzy|jukaa?m|zukaa?m|sardi|\bcold\b|loose motion|dast|बुखार|खांसी|उल्टी|चक्कर|जुकाम)/i;
const SELF_HINT = /\b(my|i|i'm|im|mine|mere|meri|mera|mujhko|mujhe|humein|hame|hamein|apne liye|khud)\b|मेरे|मेरी|मेरा|मुझे/i;

const NAME_FILLERS = new Set(['for', 'ke', 'liye', 'ko', 'ka', 'ki', 'hai', 'hain', 'ji', 'naam', 'name', 'is', 'his', 'her', 'their', 'uska', 'unka', 'iska', 'inka', 'mera', 'meri', 'my', 'the', 'it', 'its', "it's", 'woh', 'wo', 'yeh', 'ye', 'saal', 'sal', 'years', 'year', 'old', 'age', 'umar', 'and', 'aur', 'add', 'family', 'member', 'to', 'new', 'a']);
const NOT_NAMES = new Set(['yes', 'no', 'haan', 'han', 'nahi', 'nahin', 'ok', 'okay', 'hello', 'hi', 'hey', 'doctor', 'dr', 'appointment', 'book', 'cancel', 'me', 'mujhe', 'main', 'mai', 'mein', 'today', 'tomorrow', 'aaj', 'kal', 'pata', 'dont', "don't", 'know', 'skip', 'nothing', 'kuch', 'someone', 'koi', 'friend', 'dost', 'patient', 'please', 'thanks', 'what', 'kya', 'who', 'kaun', 'aap', 'tum', 'hum', 'sab', 'sabhi', 'everyone', 'nobody']);

// Saying who is talking: "main Papa hoon", "main Neha bol rahi hoon", "I am Rajesh", "this is Dadi",
// "Papa bol raha hoon", "Dadi here", "mera naam Rohit hai". (A real Echo knows each voice.)
const INTRO_PATTERNS: RegExp[] = [
  /(?:^|[\s,.!?।])(?:main|mai|मैं)\s+([^\s,.!?।]+(?:\s+[^\s,.!?।]+)?)\s+(?:(?:bol|बोल)\s+)?(?:(?:raha|rahi|रहा|रही)\s+)?(?:hoon|hun|hu|हूँ|हूं|हु)(?=$|[\s,.!?।])/i,
  /(?:^|[\s,.!?])(?:i am|i'm|im|this is|myself)\s+([a-z]+(?:\s+[a-z]+)?)(?=$|[\s,.!?])/i,
  /^([^\s,.!?।]+(?:\s+[^\s,.!?।]+)?)\s+(?:(?:bol|बोल)\s+(?:raha|rahi|रहा|रही)(?:\s+(?:hoon|hun|hu|हूँ|हूं))?|here|speaking)(?=$|[\s,.!?।])/i,
];
const MY_NAME = /(?:^|[\s,.!?])(?:mera naam|my name is|my name's|मेरा नाम)\s+([A-Za-zऀ-ॿ]{2,})/i;
// Words that make it about someone else: "I am Aarav's mother", "this is for Dadi", "main Dadi ke saath hoon".
const NOT_INTRO = /(^|\s)(for|liye|ke|ka|ki|ko|se|saath|with|of|to|the|my|mera|meri|mere|appointment|doctor|wala|wali|wale)(\s|$)|['’]s(\s|$)/i;
const FOR_SOMEONE = /\b(ke ?liye|for)\b|के लिए/i;

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const reply = (speech: string, kind = 'question'): BrainReply => ({ speech, kind, tool: null });
const chat = (speech: string, extra: Partial<BrainReply> = {}): BrainReply => ({ speech, kind: 'chat', tool: null, ...extra });

export function detectMember(household: Household, text: string): Member | undefined {
  const match = resolveMember(household.id, text);
  return 'member' in match ? match.member : undefined;
}

/** "10 baje kal subah": the clock time plus any day and part-of-day words they said. */
function extractTime(t: string): string | undefined {
  const clockText = t.match(CLOCK)?.[0];
  if (!clockText) return undefined;
  return [clockText, t.match(DAY_WORD)?.[0], t.match(PART_WORD)?.[0]].filter(Boolean).join(' ');
}

const timeWords = (t: string) => (DAY_WORD.test(t) || PART_WORD.test(t) ? t : undefined);

/** The day they asked for in the last search ("kal"), so a later "5 baje" means that day. */
function searchDay(state: ConversationState): string | undefined {
  const search = state.lastSearch;
  if (!search) return undefined;
  return String(search.when ?? '').match(DAY_WORD)?.[0] ?? String(search.need ?? '').match(DAY_WORD)?.[0];
}

/** A name given as an answer: "Ramesh", "uska naam Ramesh hai", "Rohit ke liye". */
function nameFrom(t: string): string | undefined {
  const explicit = t.match(NAME_IS)?.[1];
  if (explicit) return cap(explicit);
  const words = t
    .replace(/[.,!?]/g, ' ')
    .split(/\s+/)
    .filter((w) => w && !NAME_FILLERS.has(w.toLowerCase()) && !/^\d+$/.test(w));
  const w = words[0];
  if (!w || words.length > 2 || !/^[A-Za-zऀ-ॿ]{2,}$/.test(w) || NOT_NAMES.has(w.toLowerCase())) return undefined;
  if (resolveSpecialty(w).matched || DAY_WORD.test(w) || PART_WORD.test(w) || relationFromText(w)) return undefined;
  return cap(w);
}

/** Did they say who they are? A family member, or a new name ("mera naam Rohit hai"). */
function speakerIntro(household: Household, t: string): { member?: Member; newName?: string; matched: string } | undefined {
  const named = t.match(MY_NAME);
  if (named) {
    const member = detectMember(household, named[1]);
    const newName = member ? undefined : nameFrom(named[1]);
    return member || newName ? { member, newName, matched: named[0] } : undefined;
  }
  for (const re of INTRO_PATTERNS) {
    const m = t.match(re);
    if (!m) continue;
    const who = m[1].trim();
    if (NOT_INTRO.test(who) || relationFromText(who) === 'self') continue;
    const member = detectMember(household, who);
    if (member) return { member, matched: m[0] };
  }
  return undefined;
}

/** What they said after saying who they are: "main Papa hoon, [mere ghutne mein dard hai]". */
function restAfter(t: string, matched: string): string {
  return t
    .replace(matched, ' ')
    .replace(/^[\s,.!?।-]*(?:(?:aur|and|toh|to|so|ji|hai|hoon|hu|hun|or)\b[\s,.!?।-]*)*/i, '')
    .trim();
}

function ageFrom(t: string): number | undefined {
  const m = t.match(AGE);
  const n = Number(m ? (m[1] ?? m[2]) : t.match(/\b(\d{1,3})\b/)?.[1]);
  return Number.isFinite(n) && n >= 0 && n <= 120 ? n : undefined;
}

function placeFrom(t: string): string | undefined {
  for (const re of LOCATION) {
    const place = t.match(re)?.[1]?.replace(/[.!?]+$/, '').trim();
    if (place) return place;
  }
  return undefined;
}

/** Has this person already SEEN this kind of doctor? Then their usual doctor comes first (memory). */
export function hasPastVisit(household: Household, member: Member, text: string): boolean {
  const spec = resolveSpecialty(text, member.age ?? undefined);
  if (spec.reason === 'default') return false;
  const rows = db()
    .prepare("SELECT start_at FROM appointments WHERE household_id = ? AND member_id = ? AND specialty = ? AND status IN ('confirmed','completed')")
    .all(household.id, member.id, spec.code) as Array<{ start_at: string }>;
  const now = clock.now().getTime();
  return rows.some((r) => new Date(r.start_at).getTime() < now);
}

function remember(state: ConversationState, call: ToolCall): void {
  const d = (call.result.structuredContent ?? {}) as Record<string, any>;
  state.awaiting = undefined;
  switch (d.kind) {
    case 'doctors':
      state.lastKind = 'doctors';
      state.lastDoctor = d.doctors?.[0]?.name;
      state.lastDoctors = (d.doctors ?? []).map((x: { name: string }) => x.name);
      state.lastSearch = call.arguments;
      break;
    case 'times':
      state.lastKind = 'times';
      state.lastDoctor = d.doctor?.name ?? state.lastDoctor;
      state.lastTimes = (d.times ?? []).map((x: { start: string }) => x.start);
      if (d.replacesAppointment) state.replaces = d.replacesAppointment;
      break;
    case 'usual':
      state.lastKind = 'usual';
      state.lastDoctor = d.doctor?.name;
      break;
    case 'confirm':
      state.pendingHold = d.holdId;
      state.lastDoctor = d.summary?.doctor ?? state.lastDoctor; // "change it to 7 baje" means this doctor
      break;
    case 'booked':
      // This booking is finished: the next request starts fresh.
      state.pendingHold = undefined;
      state.replaces = undefined;
      state.patient = undefined;
      state.lastSearch = undefined;
      state.lastKind = 'booked';
      break;
    case 'question': {
      // The server asked who it is for, or doesn't know this relation yet: remember what to retry.
      const asked = String(call.arguments.patient ?? '');
      const relation = asked ? relationFromText(asked) : undefined;
      // "me", but nobody knows who is talking yet: the answer says who, then this call is done for them.
      if (d.askSpeaker) state.awaitingSpeaker = { pending: { name: call.name, args: call.arguments } };
      else if (relation && relation !== 'self' && /don't know your/i.test(speechOf(call))) state.newPerson = { relation, resume: { name: call.name, args: call.arguments } };
      else if (d.family) state.awaiting = { name: call.name, args: call.arguments };
      break;
    }
    case 'reminders':
      state.lastKind = 'reminders';
      state.due = d.reminders?.[0]?.patientSpoken; // "Shall I find a time?" -> "haan"
      break;
    case 'error':
      break;
    default:
      // Something else is on the screen now (appointments, a reminder...): the old list is gone.
      if (typeof d.kind === 'string') state.lastKind = d.kind;
      break;
  }
}

async function use(household: Household, state: ConversationState, name: string, args: Record<string, unknown>): Promise<BrainReply> {
  const clean = Object.fromEntries(Object.entries(args).filter(([, v]) => v !== undefined && v !== ''));
  const call = await callTool(household.id, name, clean);
  remember(state, call);
  return { speech: toolSpeech(household, call), kind: kindOf(call), tool: call };
}

/** Drop any question we were waiting on (they changed the subject or said "never mind"). */
function clearQuestions(state: ConversationState): void {
  state.awaiting = undefined;
  state.awaitingProblem = undefined;
  state.awaitingSpeaker = undefined;
  state.newPerson = undefined;
  state.offer = undefined;
}

// ---------------------------------------------------------------------------
// Adding someone new to the family: ask the name, then the age, then carry on.

async function continueNewPerson(household: Household, state: ConversationState): Promise<BrainReply> {
  const np = state.newPerson!;
  const relWord = np.relation ? cap(RELATIONS[np.relation]?.[0] ?? np.relation) : undefined;
  if (!np.name) return reply(relWord ? L(household, 'newRelation', relWord) : L(household, 'newWho'));
  if (np.age === undefined && !np.askedAge) {
    np.askedAge = true;
    return reply(L(household, np.becomesSpeaker ? 'newSpeakerHowOld' : relWord ? 'howOld' : 'newNameHowOld', np.name));
  }
  state.newPerson = undefined;
  const added = await use(household, state, 'add_family_member', { name: np.name, relation: np.relation, age: np.age });
  if (added.kind !== 'family-added') return added;
  if (np.becomesSpeaker) {
    // The new person is the one talking: "me" now means them.
    const id = (added.tool?.result.structuredContent as { member?: { id?: string } } | undefined)?.member?.id;
    if (id) setSpeaker(household.id, id);
    if (!np.resume) return { ...added, speech: `${added.speech} ${L(household, 'helpSpeaker', np.name)}` };
  }
  if (!np.resume) {
    state.awaitingProblem = { patient: np.name };
    return { ...added, speech: `${added.speech} ${L(household, 'whatFor', np.name)}` };
  }
  state.patient = np.name;
  const next = await use(household, state, np.resume.name, { ...np.resume.args, patient: np.name });
  return { ...next, speech: `${added.speech} ${next.speech}` };
}

// ---------------------------------------------------------------------------
// A new request for a doctor. Like a receptionist: what is the problem, and who is it for?

async function startSearch(household: Household, state: ConversationState, text: string): Promise<BrainReply> {
  const t = text;
  const member = detectMember(household, t);
  const relation = relationFromText(t);
  const unknownPerson = !member && relation && relation !== 'self' ? relation : undefined;
  const asked = state.awaitingProblem;
  const named = resolveSpecialty(t, member?.age ?? undefined).matched !== null; // they said a problem or a kind of doctor
  const args = { need: t, language: languageFromText(t), when: timeWords(t) ? undefined : asked?.when };

  // Someone the family hasn't told us about ("Chacha"): get to know them first, then carry on.
  if (unknownPerson) {
    state.awaitingProblem = undefined;
    state.newPerson = { relation: unknownPerson, resume: named ? { name: 'find_doctors', args } : undefined };
    const nameMatch = t.match(NAME_IS);
    if (nameMatch) state.newPerson.name = cap(nameMatch[1]);
    return continueNewPerson(household, state);
  }

  const midFlow = ['doctors', 'times', 'usual'].includes(state.lastKind ?? '') ? state.patient : undefined;
  const patient = member?.name ?? asked?.patient ?? (SELF_HINT.test(t) ? 'me' : undefined) ?? midFlow;

  // They told us who, but not what is wrong ("Dadi ke liye"): ask once more before guessing.
  const onlyWho = Boolean(asked && !asked.askedAgain && !named && member && t.split(' ').length <= 4);
  if (!named && (!asked || onlyWho)) {
    if (!asked && !WANTS_DOCTOR.test(t) && !UNWELL.test(t) && !member) {
      return chat(L(household, 'unsure'), { unsure: true });
    }
    state.awaitingProblem = { patient, when: timeWords(t) ?? asked?.when, askedAgain: onlyWho };
    const opening = UNWELL.test(t) ? L(household, 'sorryToHear') : asked ? '' : L(household, 'sureHelp');
    const examples = L(household, 'examples');
    if (!patient) return reply(`${opening}${L(household, 'whoAndProblem')} ${examples}`);
    return reply(`${opening}${member && !member.speaker ? L(household, 'problemOf', memberSpoken(member)) : L(household, 'problem')} ${examples}`);
  }

  state.awaitingProblem = undefined;
  if (!patient) {
    state.awaiting = { name: 'find_doctors', args };
    return reply(L(household, 'whoFor'));
  }
  state.patient = patient;
  const found = await use(household, state, 'find_doctors', { ...args, patient });
  // "Mujhe bukhaar hai", but nobody knows who is talking: the server asks "Who am I speaking with?".
  if (found.kind === 'question' && (UNWELL.test(t) || SYMPTOM.test(t))) return { ...found, speech: `${L(household, 'sorryToHear')}${found.speech}` };
  // Say which kind of doctor we picked, unless they asked for that kind of doctor themselves.
  const understood = (found.tool?.result.structuredContent as { understood?: { plain?: string; reason?: string } } | undefined)?.understood;
  if (found.kind === 'doctors' && understood?.plain && !WANTS_DOCTOR.test(t)) {
    const why = understood.reason === 'default' ? L(household, 'startFamilyDoctor') : L(household, 'rightDoctor', understood.plain);
    return { ...found, speech: `${why} ${found.speech}` };
  }
  return found;
}

// ---------------------------------------------------------------------------
// Everyday talk: greet back, say what DocSaathi does, never give medical advice.

function smallTalk(household: Household, state: ConversationState, t: string, lastChat: string | undefined, wantsDoctor: boolean): BrainReply | undefined {
  if (ADVICE.test(t)) {
    state.offer = t;
    return chat(L(household, 'noAdvice'));
  }
  if (REAL.test(t)) return chat(L(household, 'testData'));
  if (wantsDoctor) return undefined;
  if (WHERE.test(t)) return chat(L(household, 'where', household.home_address));
  if (ABOUT.test(t)) return chat(L(household, 'about'));
  if (HOW_ARE_YOU.test(t)) {
    state.lastChat = 'how';
    return chat(L(household, 'howAreYou'));
  }
  if (lastChat === 'how' && I_AM_FINE.test(t)) return chat(L(household, 'gladFine'));
  if (GREETING.test(t)) {
    const hour = istParts(clock.now()).hour;
    const daypart = hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening';
    const again = state.greeted;
    state.greeted = true;
    const speaker = speakerOf(household.id);
    const name = speaker ? memberSpoken(speaker) : '';
    return chat(again ? L(household, 'greetingAgain', name) : L(household, 'greeting', daypart, name));
  }
  if (THANKS.test(t)) return chat(L(household, 'welcome'));
  if (BYE.test(t)) {
    clearQuestions(state);
    return chat(L(household, 'bye'), { end: true });
  }
  return undefined;
}

// "Hindi mein bolo" / "speak in English": the language Alexa answers in (not the doctor's language).
const SPEAK_HINDI = /(hindi (mein|me|main) (bolo|boliye|baat|batao|bol)|(speak|talk|reply|answer)( to me)? in hindi|speak hindi|talk hindi|hindi (please|bolo|boliye)|हिंदी में|हिन्दी में|हिंदी बोलो)/i;
const SPEAK_ENGLISH = /(english (mein|me|main) (bolo|boliye|baat|batao|bol)|(speak|talk|reply|answer)( to me)? in english|speak english|talk english|english (please|bolo|boliye)|अंग्रेज़ी में|अंग्रेजी में|इंग्लिश में)/i;

// ---------------------------------------------------------------------------

/**
 * One turn of the rule brain. With `sureOnly`, it answers only the moments the rules are sure
 * about (an emergency, yes/no to a held time, choosing from what is on the screen, a location)
 * and returns null for everything else, so the AI brain can use the rules as its safety rails.
 */
async function ruleTurn(household: Household, text: string, sureOnly: boolean): Promise<BrainReply | null> {
  const state = stateOf(household.id);
  const t = cleanUtterance(text);
  let lastChat: string | undefined;
  if (!sureOnly) {
    lastChat = state.lastChat;
    state.lastChat = undefined;
  }
  if (!t) return sureOnly ? null : chat(L(household, 'listening'));

  const words = t.split(' ').length;
  // "Sure" means a short, plain sentence: no "but", no question, no "not this one".
  const plain = !HEDGE.test(t) && !QUESTION.test(t);
  const member = detectMember(household, t);
  const relation = relationFromText(t);
  // Someone the family hasn't told us about yet ("Chacha").
  const unknownPerson = !member && relation && relation !== 'self' ? relation : undefined;
  const who = member?.name ?? unknownPerson;
  const newNeed = resolveSpecialty(t).reason === 'words'; // they named a kind of doctor / problem
  const wantsDoctor = newNeed || WANTS_DOCTOR.test(t) || UNWELL.test(t);
  const mentionsListedDoctor = (state.lastDoctors ?? []).some((name) =>
    name
      .toLowerCase()
      .replace(/^dr\.?\s*/, '')
      .split(/\s+/)
      .some((w) => /^[a-z]{4,}$/.test(w) && new RegExp(`\\b${w}\\b`, 'i').test(t)),
  );

  // 1. Safety first: emergency words go to the server's emergency guard, never to booking.
  if (checkEmergency(t)) {
    clearQuestions(state);
    return use(household, state, 'find_doctors', { need: t, patient: member?.name });
  }

  // 1b. "Hindi mein bolo" / "speak in English": switch the language Alexa answers in.
  //     ("Hindi bolne wala doctor chahiye" is about the doctor, so it is left alone.)
  const newLang = wantsDoctor ? undefined : SPEAK_HINDI.test(t) ? 'hi' : SPEAK_ENGLISH.test(t) ? 'en' : undefined;
  if (newLang) {
    setReplyLanguage(household.id, newLang);
    household.reply_lang = newLang;
    return { speech: L(household, newLang === 'hi' ? 'nowHindi' : 'nowEnglish'), kind: 'language', tool: null };
  }

  // 1c. Who is talking. A real Echo knows each family member by their voice; the simulator cannot,
  //     so it never guesses. They say it ("main Papa hoon", "I am Rajesh", "mera naam Rohit hai"),
  //     or answer "Who am I speaking with?" (asked when they said "me" and nobody knows who that is).
  const intro = speakerIntro(household, t);
  const asked = state.awaitingSpeaker;
  if (asked && !intro && (NEVER_MIND.test(t) || NO.test(t) || words > 5 || newNeed)) {
    state.awaitingSpeaker = undefined; // not an answer: carry on with what they said
  } else if (intro || asked) {
    // "Dadi ke liye" answers who it is FOR, not who is talking: do it for Dadi.
    if (asked?.pending && !intro && member && FOR_SOMEONE.test(t)) {
      state.awaitingSpeaker = undefined;
      state.patient = member.name;
      return use(household, state, asked.pending.name, { ...asked.pending.args, patient: member.name });
    }
    const speaker = intro?.member ?? (relation !== 'self' ? member : undefined);
    const newName = intro?.newName ?? (asked && !intro && !member && !unknownPerson && words === 1 ? nameFrom(t) : undefined);
    if (speaker) {
      setSpeaker(household.id, speaker.id);
      state.awaitingSpeaker = undefined;
      const spoken = memberSpoken(speaker);
      if (asked?.pending) {
        // Now do what they asked for before we asked who they are.
        state.patient = speaker.name;
        const next = await use(household, state, asked.pending.name, { ...asked.pending.args, patient: speaker.name });
        return { ...next, speech: `${L(household, 'thanksSpeaker', spoken)} ${next.speech}` };
      }
      if (asked && sureOnly) return null; // the AI asked in its own words: it carries on, now knowing who
      const rest = intro ? restAfter(t, intro.matched) : '';
      if (rest.split(' ').filter(Boolean).length >= 2) {
        // "Main Papa hoon, mere ghutne mein dard hai": the rest is the request.
        const next = await ruleTurn(household, rest, sureOnly);
        return next ? { ...next, speech: `${L(household, 'okSpeaker', spoken)} ${next.speech}` } : null;
      }
      return chat(L(household, 'helloSpeaker', spoken));
    }
    if (newName) {
      // Someone the family hasn't told us about is talking: get to know them, then carry on.
      state.awaitingSpeaker = undefined;
      state.newPerson = { name: newName, resume: asked?.pending, becomesSpeaker: true };
      return continueNewPerson(household, state);
    }
    if (asked && !asked.askedAgain) {
      asked.askedAgain = true;
      return reply(L(household, 'speakerAgain'));
    }
    state.awaitingSpeaker = undefined;
  }

  // 1d. With the AI brain: "meri tabiyat theek nahi, bukhaar hai" while nobody knows who is talking.
  //     Always the same answer (never the AI's guess): search for "me", which makes the server ask
  //     "Who am I speaking with?"; the answer then finishes this search. (The rule brain does the same in startSearch.)
  if (sureOnly && relation === 'self' && !member && !speakerOf(household.id) && (newNeed || SYMPTOM.test(t))) {
    const found = await use(household, state, 'find_doctors', { need: t, patient: 'me', when: timeWords(t), language: languageFromText(t) });
    return found.kind === 'question' ? { ...found, speech: `${L(household, 'sorryToHear')}${found.speech}` } : found;
  }

  // 2. Answering "Shall I book it?"
  // (A "yes" that also names a doctor number or a time is a new choice, not a yes: "haan, 7 baje kar do".)
  const plainYes = YES.test(t) && !ORDINAL.test(t) && !CLOCK.test(t);
  if (state.pendingHold && plainYes && (!sureOnly || (words <= 6 && plain))) {
    return use(household, state, 'confirm_appointment', { hold_id: state.pendingHold });
  }
  if (state.pendingHold && NO.test(t) && (!sureOnly || (words <= 3 && plain && !CLOCK.test(t)))) {
    state.pendingHold = undefined;
    return reply(L(household, 'notBooked'));
  }

  // 3. Answering "What is their name?" / "How old are they?" for someone new
  //    (in sure mode too when it is the person talking: they are answering our question about them)
  if (state.newPerson && (!sureOnly || state.newPerson.becomesSpeaker)) {
    const np = state.newPerson;
    if (NEVER_MIND.test(t) || (NO.test(t) && !np.name)) {
      clearQuestions(state);
      return chat(L(household, 'wontAdd'));
    }
    if (!np.name) {
      np.name = nameFrom(t);
      if (!np.name) return reply(L(household, 'nameAgain'));
      if (AGE.test(t)) np.age = ageFrom(t);
    } else if (np.age === undefined) {
      np.age = ageFrom(t);
      if (np.age === undefined && !AGE_UNKNOWN.test(t) && !np.askedAge) return continueNewPerson(household, state);
      np.askedAge = true;
    }
    return continueNewPerson(household, state);
  }

  // 4. "I live in Rohini, Delhi": near me should mean near them.
  const place = wantsDoctor ? undefined : placeFrom(t);
  if (place) return use(household, state, 'set_home_location', { place });

  // 4b. "Real clinics near me", "nearest hospital", "paas mein chemist": real places from Google Maps, to call.
  //     ("Phone number do" after a list of skin doctors means real skin clinics.)
  if (REAL_PLACE.test(t)) return use(household, state, 'find_nearby_clinics', { need: newNeed ? t : `${t} ${String(state.lastSearch?.need ?? '')}`.trim() });

  // 5. Everyday talk ("hello", "how are you", "thank you", "which medicine?").
  //     In sure mode only the very short ones: a plain "hello", "thank you" or "bye".
  if (!sureOnly || (words <= 3 && !wantsDoctor && (GREETING.test(t) || THANKS.test(t) || BYE.test(t)) && !HOW_ARE_YOU.test(t))) {
    const talk = smallTalk(household, state, t, lastChat, wantsDoctor);
    if (talk) return talk;
  }

  if (!sureOnly) {

    // 6. Answering "Who is it for?" with a name or relation ("Mummy", "Aarav", or someone new)
    if (state.awaiting && !newNeed) {
      const pending = state.awaiting;
      // "Mere liye" / "me": for whoever is talking (asked next, if nobody knows yet).
      if (relation === 'self' && !member) return use(household, state, pending.name, { ...pending.args, patient: 'me' });
      if (member) {
        state.patient = member.name;
        return use(household, state, pending.name, { ...pending.args, patient: member.name });
      }
      const said = t.match(NAME_IS)?.[1];
      const name = unknownPerson ? (said ? cap(said) : undefined) : nameFrom(t);
      if (unknownPerson || name) {
        state.awaiting = undefined;
        state.newPerson = { relation: unknownPerson, name, resume: pending };
        if (AGE.test(t)) state.newPerson.age = ageFrom(t);
        return continueNewPerson(household, state);
      }
    }

    // 7. Adding a family member ("Chacha ka naam Ramesh hai, 50 saal", "add Rohit to my family")
    const nameMatch = t.match(NAME_IS);
    if ((nameMatch && unknownPerson) || ADD_MEMBER.test(t)) {
      const name = nameMatch ? cap(nameMatch[1]) : nameFrom(t.replace(/\b(please|mere|meri|mera|my|mein|me|ko|in|karo|kar do)\b/gi, ' '));
      state.newPerson = { relation: unknownPerson, name, age: AGE.test(t) ? ageFrom(t) : undefined };
      return continueNewPerson(household, state);
    }
  }

  // 8. "Haan" / "nahi" when nothing is held
  if (plainYes && (!sureOnly || (words <= 6 && plain))) {
    // Alexa offered something ("Shall I find another time?", "Shall I find a doctor?"): yes does it.
    if (state.offer) {
      const offered = state.offer;
      state.offer = undefined;
      return startSearch(household, state, `${offered} doctor`);
    }
    // "Dadi's check-up is due. Shall I find a time?" -> their usual doctor's next free times.
    if (state.lastKind === 'reminders' && state.due) return use(household, state, 'find_usual_doctor', { patient: state.due });
    // A time was just offered: hold it (the confirm card still asks "Shall I book it?").
    if (state.lastDoctor && state.lastKind === 'doctors') {
      return use(household, state, 'get_doctor_times', { doctor: state.lastDoctor, when: searchDay(state) });
    }
    if (state.lastDoctor && ['usual', 'times'].includes(state.lastKind ?? '')) {
      return use(household, state, 'book_appointment', { doctor: state.lastDoctor, patient: member?.name ?? state.patient, replaces_appointment: state.replaces });
    }
    if (sureOnly) return null;
    return reply(L(household, 'nothingWaiting'));
  }

  const otherRequest = (FOLLOW_UP.test(t) && Boolean(parseDurationDays(t))) || REMINDERS.test(t) || CANCEL.test(t) || RESCHEDULE.test(t) || FAMILY.test(t) || LIST.test(t) || USUAL.test(t);
  if (!sureOnly) {
    const asking = Boolean(state.awaiting || state.awaitingProblem);
    if ((NO.test(t) && !newNeed) || (NEVER_MIND.test(t) && !wantsDoctor) || (asking && /^cancel$/i.test(t))) {
      clearQuestions(state);
      return chat(L(household, 'noProblem'));
    }
    state.offer = undefined;

    // 9. Follow-ups, reminders, cancel, move, family, list
    if (FOLLOW_UP.test(t) && parseDurationDays(t)) {
      return use(household, state, 'remember_follow_up', { patient: who ?? state.patient ?? 'me', after: t });
    }
    if (REMINDERS.test(t)) return use(household, state, 'check_reminders', {});
    if (CANCEL.test(t)) return use(household, state, 'cancel_appointment', { appointment: t });
    if (RESCHEDULE.test(t)) return use(household, state, 'reschedule_appointment', { appointment: t, when: t });
    if (FAMILY.test(t)) return use(household, state, 'family_members', {});
    // ("Mere appointments" = the family's appointments: the one device is shared by everyone.)
    if (LIST.test(t)) return use(household, state, 'my_appointments', { patient: relation === 'self' ? undefined : member?.name });

    // 10. Usual doctor: asked for, or this person has seen this kind of doctor before (memory first).
    if (member) state.patient = member.name;
    const patient = member?.name ?? state.patient;
    if (USUAL.test(t) && patient) return use(household, state, 'find_usual_doctor', { patient, need: t, when: timeWords(t) });
    if (member && hasPastVisit(household, member, t)) return use(household, state, 'find_usual_doctor', { patient: member.name, need: t, when: t });
  }

  // 11. More times for a doctor
  if (MORE_TIMES.test(t) && (state.lastDoctor || DOCTOR_NAME.test(t)) && (!sureOnly || !otherRequest)) {
    return use(household, state, 'get_doctor_times', { doctor: DOCTOR_NAME.test(t) ? t : state.lastDoctor, when: timeWords(t) });
  }

  // 12. Choosing from what is on the screen.
  //     But a new need ("Marathi bolne wale bachchon ka doctor") is a new search, not a choice.
  const namesDoctor = DOCTOR_NAME.test(t) || mentionsListedDoctor;
  const choosing = (PICK.test(t) || CLOCK.test(t) || EARLIEST.test(t) || mentionsListedDoctor) && !(newNeed && !namesDoctor && !CLOCK.test(t));
  const said = extractTime(t);
  const time = said && !DAY_WORD.test(t) && searchDay(state) ? `${said} ${searchDay(state)}` : said;
  const booking = { patient: who ?? state.patient, replaces_appointment: state.replaces };
  // In sure mode: a short plain choice ("pehla wala", "6:30 wala"), or a tap on the screen ("Book 5:00 PM today with Dr. ...").
  const clear = !sureOnly || (plain && !otherRequest && !unknownPerson && !NOT.test(t) && (words <= 8 || (CLOCK.test(t) && namesDoctor)));
  if (state.lastKind === 'times' && choosing && clear) {
    // Times for one doctor are on the screen: "6:30 wala", "doosra wala", "sabse pehla".
    if (namesDoctor && !time && !EARLIEST.test(t)) return use(household, state, 'get_doctor_times', { doctor: t, when: timeWords(t) });
    const nth = ORDINAL_INDEX.find(([re]) => re.test(t))?.[1];
    const picked = time ?? (nth !== undefined ? state.lastTimes?.[nth] : undefined);
    if (!picked && !EARLIEST.test(t) && nth === undefined && timeWords(t)) return use(household, state, 'get_doctor_times', { doctor: state.lastDoctor, when: t });
    return use(household, state, 'book_appointment', { doctor: namesDoctor ? t : state.lastDoctor, time: picked, ...booking });
  }
  if (state.lastKind && ['doctors', 'usual'].includes(state.lastKind) && choosing && clear) {
    // A doctor list is on the screen: "pehla wala", "Dr. Mehta", "Book 6:30 PM today with Dr. ...".
    const doctor = namesDoctor || ORDINAL.test(t) ? t : (state.lastDoctor ?? t);
    // They also said a time (or "the earliest", or tapped the usual doctor's time): hold it.
    if (time || EARLIEST.test(t) || state.lastKind === 'usual') return use(household, state, 'book_appointment', { doctor, time, ...booking });
    // Only the doctor: show that doctor's free times and ask which one.
    return use(household, state, 'get_doctor_times', { doctor, when: timeWords(t) ?? searchDay(state) });
  }

  // 13. Only a day or time ("kal subah") while something is on the screen: look at that day instead.
  if (timeWords(t) && !wantsDoctor && !member && words <= 6 && clear) {
    if (state.lastKind === 'times' && state.lastDoctor) return use(household, state, 'get_doctor_times', { doctor: state.lastDoctor, when: t });
    if (state.lastKind === 'doctors' && state.lastSearch) return use(household, state, 'find_doctors', { ...state.lastSearch, when: t });
  }

  // 14. Anything else: a new request. Ask what is wrong and who it is for, then find doctors.
  if (sureOnly) return null;
  return startSearch(household, state, t);
}

/** The rule brain (no AI key needed). */
export async function demoRespond(household: Household, text: string): Promise<BrainReply> {
  return (await ruleTurn(household, text, false))!;
}

/** Only the answers the rules are sure about; null means "let the AI understand this one". */
export function sureReply(household: Household, text: string): Promise<BrainReply | null> {
  return ruleTurn(household, text, true);
}
