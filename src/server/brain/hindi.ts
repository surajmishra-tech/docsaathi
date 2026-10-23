// Alexa's words in two languages. "Hindi mein bolo" switches a family to Hindi, "speak in English"
// switches back. The Hindi is written by hand (not machine-translated on the fly), so the times,
// fees and the emergency numbers are always exact.
//
//  - `L(household, key, ...)`: the simulator's own lines (greetings, questions), in the family's language.
//  - `toolSpeech(household, call)`: what a DocSaathi tool result sounds like. English comes straight
//    from the MCP server; Hindi is built here from the same structured result the screen uses.
import { memberLabel, memberSpoken, membersOf, orList, type Household } from '../family.js';
import { spokenPlace } from '../booking.js';
import { clock, istDay, istParts, startOfIstDay } from '../time.js';
import { SPECIALTIES } from '../words.js';
import { kindOf, speechOf, type ToolCall } from './mcpClient.js';

type Any = Record<string, any>;

export const isHindi = (household: Household) => household.reply_lang === 'hi';
/** Does this text contain Hindi script? (Tells the simulator which voice to read it with.) */
export const hasHindi = (text: string) => /[ऀ-ॿ]/.test(text);

// ---------------------------------------------------------------------------
// People, days and times in Hindi

const RELATION_HI: Record<string, string> = {
  dadi: 'दादी', dada: 'दादा', nani: 'नानी', nana: 'नाना', papa: 'पापा', mummy: 'मम्मी', son: 'बेटा', daughter: 'बेटी',
  brother: 'भैया', sister: 'दीदी', wife: 'पत्नी', husband: 'पति', chacha: 'चाचा', chachi: 'चाची', bua: 'बुआ', mama: 'मामा',
  mami: 'मामी', bhabhi: 'भाभी', devar: 'देवर', jethani: 'जेठानी', bhanja: 'भांजा', bhateeja: 'भतीजा', bhateeji: 'भतीजी',
};

/** "Dadi (Kamla)" / "Dadi" -> "दादी"; "Aarav" -> "आरव" (if the family gave a Hindi spelling); "you" -> "आप". */
export function personHi(household: Household, text: string): string {
  const t = text.trim();
  if (/^(you|me)$/i.test(t)) return 'आप';
  const member = membersOf(household.id).find((m) => memberLabel(m) === t || memberSpoken(m) === t || m.name === t);
  if (member) {
    if (!['self', 'son', 'daughter', 'other'].includes(member.relation) && RELATION_HI[member.relation]) return RELATION_HI[member.relation];
    const hindiName = (member.alt_names ?? '').split(',').map((s) => s.trim()).find(hasHindi);
    return hindiName ?? member.name;
  }
  return RELATION_HI[t.split(/[\s(]/)[0].toLowerCase()] ?? t;
}
const ka = (p: string) => (p === 'आप' ? 'आपका' : `${p} का`); // X's (appointment)
const ke = (p: string) => (p === 'आप' ? 'आपके' : `${p} के`); // X's (doctor) / for X
const ko = (p: string) => (p === 'आप' ? 'आपको' : `${p} को`); // to X

const WEEKDAYS_HI = ['रविवार', 'सोमवार', 'मंगलवार', 'बुधवार', 'गुरुवार', 'शुक्रवार', 'शनिवार'];
const MONTHS_HI = ['जनवरी', 'फ़रवरी', 'मार्च', 'अप्रैल', 'मई', 'जून', 'जुलाई', 'अगस्त', 'सितंबर', 'अक्टूबर', 'नवंबर', 'दिसंबर'];
const partOfDay = (hour: number) => (hour < 12 ? 'सुबह' : hour < 16 ? 'दोपहर' : hour < 20 ? 'शाम' : 'रात');

/** "5:30" (always with minutes, for lists) */
function clockDigits(date: Date): string {
  const p = istParts(date);
  return `${p.hour % 12 === 0 ? 12 : p.hour % 12}:${String(p.minute).padStart(2, '0')}`;
}
/** "शाम 5:30" / "सुबह 10" */
function clockHi(date: Date): string {
  const p = istParts(date);
  return `${partOfDay(p.hour)} ${p.hour % 12 === 0 ? 12 : p.hour % 12}${p.minute ? `:${String(p.minute).padStart(2, '0')}` : ''}`;
}
/** "आज" / "कल" / "परसों" / "शुक्रवार 2 अक्टूबर को" */
function dayHi(date: Date): string {
  const diff = Math.round((startOfIstDay(date).getTime() - startOfIstDay(clock.now()).getTime()) / 86_400_000);
  if (diff === 0) return 'आज';
  if (diff === 1) return 'कल';
  if (diff === 2) return 'परसों';
  const p = istParts(date);
  return `${WEEKDAYS_HI[p.weekday]} ${p.day} ${MONTHS_HI[p.month - 1]} को`;
}
/** "कल सुबह 10:30 बजे" */
const whenHi = (date: Date) => `${dayHi(date)} ${clockHi(date)} बजे`;
/** "29 दिसंबर" from "2026-12-29" */
function dateHi(day: string): string {
  const [, m, d] = day.split('-').map(Number);
  return `${d} ${MONTHS_HI[m - 1]}`;
}

const SPECIALTY_HI: Record<string, string> = {
  GENERAL_MEDICINE: 'फैमिली डॉक्टर',
  PEDIATRICS: 'बच्चों के डॉक्टर',
  DIABETOLOGY: 'शुगर के डॉक्टर',
  CARDIOLOGY: 'दिल के डॉक्टर',
  ORTHOPEDICS: 'हड्डी के डॉक्टर',
  DENTISTRY: 'दांतों के डॉक्टर',
  OPHTHALMOLOGY: 'आंखों के डॉक्टर',
  DERMATOLOGY: 'त्वचा के डॉक्टर',
  ENT: 'कान, नाक और गले के डॉक्टर',
  GYNECOLOGY: 'महिला रोग की डॉक्टर',
  PSYCHIATRY: 'मन के डॉक्टर',
};
/** From the English name or plain name of a specialty ("Pediatrician", "child doctor"). */
function specialtyHi(english: string | undefined): string {
  const found = Object.values(SPECIALTIES).find((s) => s.name === english || s.plain === english);
  return found ? SPECIALTY_HI[found.code] : 'डॉक्टर';
}

// What the test clinics ask patients to bring (the clinic's own words, from the network).
const CLINIC_NOTES_HI: Array<[RegExp, string]> = [
  [/^For a sugar test, come fasting/, 'शुगर की जांच के लिए खाली पेट आइए (8 से 10 घंटे कुछ न खाएँ; पानी पी सकते हैं)। अपनी शुगर की डायरी और पुरानी रिपोर्ट साथ लाइए।'],
  [/^Bring the child's vaccination card and any old prescriptions/, 'बच्चे का टीकाकरण कार्ड और पुराने पर्चे साथ लाइए।'],
  [/^Bring the child's vaccination card/, 'बच्चे का टीकाकरण कार्ड साथ लाइए।'],
  [/^Bring any X-ray or MRI reports/, 'एक्स-रे या एमआरआई की रिपोर्ट हो तो साथ लाइए।'],
  [/^Bring your current glasses\. Eye drops/, 'अपना चश्मा साथ लाइए। आई ड्रॉप से कुछ घंटे धुंधला दिख सकता है, इसलिए लौटते समय खुद गाड़ी न चलाएँ।'],
  [/^Bring your current glasses/, 'अपना चश्मा साथ लाइए।'],
  [/^Bring your glucose diary/, 'अपनी शुगर की डायरी और पुरानी रिपोर्ट साथ लाइए।'],
  [/^Bring your old ECG/, 'अपनी पुरानी ईसीजी, इको और खून की रिपोर्ट, और जो दवाएँ आप लेते हैं, साथ लाइए।'],
];
const clinicNoteHi = (note: string) => CLINIC_NOTES_HI.find(([re]) => re.test(note))?.[1] ?? note;

const areaOf = (address: string | undefined) => (address ?? '').split(',')[0].trim();
const cleanClinic = (name: string | undefined) => (name ?? '').replace(/\s*\(TEST\)\s*$/, '');

// ---------------------------------------------------------------------------
// The simulator's own lines

function familyHintHi(household: Household): string {
  const others = membersOf(household.id)
    .filter((m) => !m.speaker)
    .map((m) => personHi(household, memberSpoken(m)));
  return `आप "मेरे लिए" कह सकते हैं${others.length ? `, या ${others.join(', ')}` : ''}।`;
}
function familyHintEn(household: Household): string {
  const others = membersOf(household.id)
    .filter((m) => !m.speaker)
    .map(memberSpoken);
  return `You can say "me"${others.length ? `, or ${others.join(', ')}` : ''}.`;
}
/** Who they can book for: "You can say "me", or Dadi, Papa, Aarav." */
export const familyHint = (household: Household) => (isHindi(household) ? familyHintHi(household) : familyHintEn(household));

type Line = (h: Household, a: string, b: string) => string;
const both = (en: string, hi: string): [Line, Line] => [() => en, () => hi];

// [English, Hindi]. `a` and `b` are the blanks (a name, a place); names are put into Hindi inside.
const LINES = {
  listening: both("Yes, I'm listening. Who needs a doctor?", 'जी, मैं सुन रही हूँ। किसे डॉक्टर को दिखाना है?'),
  notBooked: both("Okay, I haven't booked it. Would you like another time or another doctor?", 'ठीक है, मैंने बुक नहीं किया। क्या आप कोई और समय या कोई और डॉक्टर चाहेंगे?'),
  notBookedLater: both("Okay, I haven't booked it. Tell me when you want to book, or ask for another time.", 'ठीक है, मैंने बुक नहीं किया। जब बुक करना हो तब बताइए, या कोई और समय पूछिए।'),
  bookItQuestion: both('Shall I book it? Please say yes or no.', 'क्या मैं बुक कर दूँ? कृपया हाँ या नहीं कहिए।'),
  nothingWaiting: both("There's nothing waiting to be booked. Which doctor do you need, and for whom?", 'अभी बुक करने के लिए कुछ नहीं है। आपको कौन सा डॉक्टर चाहिए, और किसके लिए?'),
  nothingWaitingYet: both("There's nothing waiting to be booked yet. Which doctor and time would you like?", 'अभी बुक करने के लिए कुछ नहीं है। आपको कौन सा डॉक्टर और कौन सा समय चाहिए?'),
  wontAdd: both("Okay, I won't add anyone. Tell me whenever someone needs a doctor.", 'ठीक है, मैं किसी को नहीं जोड़ूँगी। जब भी किसी को डॉक्टर की ज़रूरत हो, मुझे बताइए।'),
  nameAgain: both("Sorry, I didn't catch the name. What is their name?", 'माफ़ कीजिए, नाम समझ नहीं आया। उनका नाम क्या है?'),
  noProblem: both('Okay, no problem. Tell me whenever someone needs a doctor.', 'ठीक है, कोई बात नहीं। जब भी किसी को डॉक्टर की ज़रूरत हो, मुझे बताइए।'),
  linkFirst: both(
    "DocSaathi isn't linked to this Alexa yet. Tap Link account on the screen, sign in with your family's mobile number and PIN, then ask me again.",
    'डॉकसाथी अभी इस एलेक्सा से जुड़ा नहीं है। स्क्रीन पर Link account दबाइए, परिवार के मोबाइल नंबर और पिन से साइन इन कीजिए, फिर मुझसे दोबारा पूछिए।',
  ),
  busy: both('Sorry, I need a moment. Please say that once more.', 'माफ़ कीजिए, एक पल दीजिए। कृपया वही बात एक बार फिर कहिए।'),
  unsure: both(
    `Sorry, I didn't get that. I can find and book a doctor for your family. Tell me who is unwell and what the problem is, like "Papa ko ghutne mein dard hai".`,
    'माफ़ कीजिए, मैं समझ नहीं पाई। मैं आपके परिवार के लिए डॉक्टर ढूँढकर अपॉइंटमेंट बुक कर सकती हूँ। बताइए किसकी तबीयत ख़राब है और क्या तकलीफ़ है, जैसे "पापा के घुटने में दर्द है"।',
  ),
  // Asking what is wrong and who it is for
  sorryToHear: both("I'm sorry to hear that. ", 'यह सुनकर दुख हुआ। '),
  sureHelp: both('Sure, I can help. ', 'ज़रूर, मैं मदद करती हूँ। '),
  examples: both('For example fever, stomach pain, tooth pain, skin, eyes, or a check-up.', 'जैसे बुखार, पेट दर्द, दांत दर्द, त्वचा, आंखें, या चेक-अप।'),
  whoAndProblem: both('Who is it for, and what is the problem?', 'किसे दिखाना है, और क्या तकलीफ़ है?'),
  problem: both('What is the problem?', 'क्या तकलीफ़ है?'),
  problemOf: [(_h, who) => `What problem does ${who} have?`, (h, who) => `${ko(personHi(h, who))} क्या तकलीफ़ है?`],
  whoFor: [(h) => `Okay. Who is it for? ${familyHintEn(h)}`, (h) => `ठीक है। किसे दिखाना है? ${familyHintHi(h)}`],
  startFamilyDoctor: both("I'll start with a family doctor, who can check it and guide you.", 'मैं पहले फैमिली डॉक्टर दिखाती हूँ, जो देखकर आगे बता देंगे।'),
  rightDoctor: [(_h, plain) => `For that, the right doctor is ${/^[aeiou]/i.test(plain) ? 'an' : 'a'} ${plain}.`, (_h, plain) => `इसके लिए ${specialtyHi(plain)} सही रहेंगे।`],
  // Someone new in the family
  newRelation: [(_h, word) => `I don't know your ${word} yet. What is their name?`, (_h, word) => `मैं आपके ${RELATION_HI[word.toLowerCase()] ?? word} को अभी नहीं जानती। उनका नाम क्या है?`],
  newWho: both('Sure, I can add them. What is their name?', 'ज़रूर, मैं जोड़ देती हूँ। उनका नाम क्या है?'),
  howOld: [(_h, name) => `And how old is ${name}?`, (_h, name) => `और ${name} की उम्र कितनी है?`],
  newNameHowOld: [
    (_h, name) => `I don't know ${name} yet, so I'll add them to your family. How old is ${name}?`,
    (_h, name) => `मैं ${name} को अभी नहीं जानती, इसलिए उन्हें आपके परिवार में जोड़ रही हूँ। ${name} की उम्र कितनी है?`,
  ],
  whatFor: [(_h, name) => `What does ${name} need a doctor for?`, (_h, name) => `${name} को किस तकलीफ़ के लिए डॉक्टर को दिखाना है?`],
  // Everyday talk
  noAdvice: both(
    "I'm not a doctor, so I can't suggest medicines or say what it is. A doctor should check it. Shall I find one for you?",
    'मैं डॉक्टर नहीं हूँ, इसलिए दवा नहीं बता सकती और यह भी नहीं कह सकती कि क्या हुआ है। इसे डॉक्टर को दिखाना चाहिए। क्या मैं आपके लिए डॉक्टर ढूँढूँ?',
  ),
  testData: both(
    `The doctors I can book are test doctors on DocSaathi's UHI test network, so no real clinic gets a booking. The booking steps are the real UHI steps. For real clinics you can call, say "real clinics near me".`,
    'जिन डॉक्टरों को मैं बुक कर सकती हूँ, वे DocSaathi के UHI टेस्ट नेटवर्क के टेस्ट डॉक्टर हैं, इसलिए किसी असली क्लिनिक में बुकिंग नहीं जाती। बुकिंग के स्टेप असली UHI वाले हैं। असली क्लिनिक के लिए, जिन्हें आप फ़ोन कर सकते हैं, कहिए "पास के असली क्लिनिक"।',
  ),
  where: [
    (_h, place) => `I'm looking for doctors near ${place}. To change it, say "I live in" and your area, or tap the location button.`,
    (_h, place) => `मैं ${place} के पास डॉक्टर ढूँढ रही हूँ। बदलने के लिए अपना इलाका बताइए, जैसे "मैं रोहिणी, दिल्ली में रहता हूँ", या लोकेशन बटन दबाइए।`,
  ],
  about: both(
    "I'm DocSaathi, your family's doctor helper on Alexa. I can find doctors near you, book an appointment for anyone in the family, and remind you about check-ups. I don't give medical advice. Just tell me who is unwell and what the problem is.",
    'मैं DocSaathi हूँ, Alexa पर आपके परिवार की डॉक्टर सहायक। मैं आपके पास के डॉक्टर ढूँढ सकती हूँ, परिवार में किसी के लिए भी अपॉइंटमेंट बुक कर सकती हूँ, और चेक-अप की याद दिला सकती हूँ। मैं इलाज की सलाह नहीं देती। बस बताइए किसकी तबीयत ख़राब है और क्या तकलीफ़ है।',
  ),
  howAreYou: both("I'm doing well, thank you for asking! How are you feeling today?", 'मैं ठीक हूँ, पूछने के लिए धन्यवाद! आप आज कैसा महसूस कर रहे हैं?'),
  gladFine: both('Glad to hear that! If anyone in the family needs a doctor, just tell me.', 'यह सुनकर अच्छा लगा! परिवार में किसी को डॉक्टर की ज़रूरत हो तो बस बता दीजिए।'),
  // `b` = who is talking, when known ("Namaste Papa!")
  greeting: [
    (_h, daypart, who) => `Namaste${who ? ` ${who}` : ''}! ${daypart}. I'm DocSaathi. I can find a doctor and book an appointment for anyone in your family. Who needs a doctor today?`,
    (h, _daypart, who) => `नमस्ते${who ? ` ${personHi(h, who)}` : ''}! मैं DocSaathi हूँ। मैं आपके परिवार में किसी के लिए भी डॉक्टर ढूँढकर अपॉइंटमेंट बुक कर सकती हूँ। आज किसे डॉक्टर को दिखाना है?`,
  ],
  greetingAgain: [
    (_h, who) => `Hello again${who ? `, ${who}` : ''}! Who needs a doctor?`,
    (h, who) => `फिर से नमस्ते${who ? ` ${personHi(h, who)}` : ''}! किसे डॉक्टर को दिखाना है?`,
  ],
  // Who is talking (a real Echo knows by the voice; here we ask)
  speakerAgain: [
    (h) => `Sorry, I didn't catch who is speaking. Is it ${orList(membersOf(h.id).map(memberSpoken))}?`,
    (h) => `माफ़ कीजिए, समझ नहीं आया कि कौन बोल रहा है। ${orList(membersOf(h.id).map((m) => personHi(h, memberSpoken(m))), 'या')}?`,
  ],
  thanksSpeaker: [(_h, who) => `Thank you, ${who}.`, (h, who) => `धन्यवाद, ${personHi(h, who)}।`],
  okSpeaker: [(_h, who) => `Okay, ${who}.`, (h, who) => `ठीक है, ${personHi(h, who)}।`],
  helloSpeaker: [(_h, who) => `Namaste ${who}! How can I help you?`, (h, who) => `नमस्ते ${personHi(h, who)}! बताइए, मैं क्या मदद करूँ?`],
  newSpeakerHowOld: [
    (_h, name) => `Nice to meet you, ${name}. I'll add you to the family. How old are you?`,
    (_h, name) => `आपसे मिलकर अच्छा लगा, ${name}। मैं आपको परिवार में जोड़ रही हूँ। आपकी उम्र कितनी है?`,
  ],
  helpSpeaker: [(_h, name) => `How can I help you, ${name}?`, (_h, name) => `बताइए ${name}, मैं क्या मदद करूँ?`],
  welcome: both("You're welcome! Take care. I'm here whenever someone needs a doctor.", 'आपका स्वागत है! अपना ध्यान रखिए। जब भी डॉक्टर की ज़रूरत हो, मैं यहीं हूँ।'),
  bye: both('Okay, bye! Take care of yourself and the family.', 'ठीक है, नमस्ते! अपना और परिवार का ध्यान रखिए।'),
  // Switching the language (always said in the NEW language)
  nowHindi: both('ठीक है, अब मैं हिंदी में बात करूँगी। बताइए, किसे डॉक्टर को दिखाना है?', 'ठीक है, अब मैं हिंदी में बात करूँगी। बताइए, किसे डॉक्टर को दिखाना है?'),
  nowEnglish: both("Okay, I'll speak English now. Who needs a doctor?", "Okay, I'll speak English now. Who needs a doctor?"),
} satisfies Record<string, [Line, Line]>;

export type LineKey = keyof typeof LINES;

/** One of the simulator's own lines, in the family's language. */
export function L(household: Household, key: LineKey, a = '', b = ''): string {
  return LINES[key][isHindi(household) ? 1 : 0](household, a, b);
}

// ---------------------------------------------------------------------------
// What a tool result sounds like

/** The few plain sentences the server sends without data (questions and errors), in Hindi. */
function serverTextHi(household: Household, text: string, d: Any): string | undefined {
  let m: RegExpMatchArray | null;
  if (/^Who is the appointment for\?/.test(text)) return `अपॉइंटमेंट किसके लिए है? ${familyHintHi(household)}`;
  if ((m = text.match(/^I don't know your (\S+) yet/))) return `मैं आपके ${RELATION_HI[m[1].toLowerCase()] ?? m[1]} को अभी नहीं जानती। कृपया उनका नाम और उम्र बताइए, मैं उन्हें परिवार में जोड़ दूँगी।`;
  if ((m = text.match(/^I couldn't tell who "(.+?)" is/))) return `मैं समझ नहीं पाई कि "${m[1]}" कौन हैं। ${familyHintHi(household)}`;
  if (/^Who am I speaking with\?/.test(text)) return `मैं किससे बात कर रही हूँ? ${orList(membersOf(household.id).map((m) => personHi(household, memberSpoken(m))), 'या')}?`;
  if (/^Which doctor\?/.test(text)) return 'कौन सा डॉक्टर? लिस्ट में से नंबर या नाम बताइए, या पहले मुझसे डॉक्टर ढूँढने को कहिए।';
  if (/isn't free at /.test(text) && d.doctor) {
    const free = ((d.doctor.slots ?? []) as Any[]).slice(0, 4).map((s) => whenHi(new Date(s.start)));
    return `${d.doctor.name} उस समय खाली नहीं हैं।${free.length ? ` खाली समय: ${free.join(', ')}।` : ''} कौन सा रखूँ?`;
  }
  if (/nothing waiting to be booked/.test(text)) return L(household, 'nothingWaitingYet');
  if (/^That time was held for 5 minutes/.test(text)) return 'वह समय 5 मिनट के लिए रोका गया था और अब छूट गया है। क्या मैं खाली समय दोबारा देखूँ?';
  if ((m = text.match(/^Which appointment should I (cancel|move)\?/))) return `कौन सा अपॉइंटमेंट ${m[1] === 'cancel' ? 'रद्द करना' : 'बदलना'} है? बताइए किसका है, या डॉक्टर का नाम।`;
  if ((m = text.match(/^I couldn't find (.+) on the network/))) return `मुझे नेटवर्क पर "${m[1]}" नहीं मिले। लिस्ट में से नंबर बताइए, या मुझसे डॉक्टर ढूँढने को कहिए।`;
  if (/^I don't have any past visits for/.test(text)) return `मेरे पास ${d.patient ? ke(personHi(household, d.patient)) : 'उनके'} पुराने अपॉइंटमेंट की जानकारी नहीं है। आपको किस तरह का डॉक्टर चाहिए?`;
  if ((m = text.match(/^(.+) has no free time this week/))) return `${m[1]} के पास इस हफ़्ते कोई खाली समय नहीं है। क्या मैं कोई और डॉक्टर ढूँढूँ?`;
  if (/^After how long\?/.test(text)) return 'कितने समय बाद? जैसे 2 हफ़्ते या 3 महीने।';
  if ((m = text.match(/^I couldn't find "(.+?)" in India/))) return `मुझे भारत में "${m[1]}" नहीं मिला। अपना इलाका और शहर बताइए, जैसे "Rohini, Delhi"।`;
  if (/^That time is no longer free/.test(text)) return 'वह समय अब खाली नहीं है। कृपया कोई और समय चुनिए।';
  if (/^The hold on this time expired/.test(text)) return 'इस समय की होल्ड ख़त्म हो गई है। कृपया दोबारा बुक कीजिए।';
  return undefined;
}

function doctorsHi(h: Household, d: Any, english: string): string {
  const docs = (d.doctors ?? []) as Any[];
  const kind = specialtyHi(d.understood?.plain);
  const who = d.patient ? `${ke(personHi(h, d.patient))} लिए ` : '';
  const real = ((d.nearbyOnGoogle ?? []) as Any[]).length;
  if (docs.length === 0) {
    return `${who}${kind} का उस समय कोई खाली समय नहीं मिला।${real ? ` Google Maps पर आपके पास ${real} असली क्लिनिक मिले हैं, जिन्हें आप फ़ोन कर सकते हैं।` : ' कोई और दिन या समय बताइए।'}`;
  }
  const top = docs.slice(0, 3).map((x, i) => {
    const free = x.firstSlot ? `${whenHi(new Date(x.firstSlot.start))} खाली हैं, ` : '';
    return `${i + 1}: ${x.name}, ${x.area ? `${x.area} में, ` : ''}${x.travel?.minutes ?? '?'} मिनट दूर, ${free}फ़ीस ${x.fee} रुपये`;
  });
  return (
    `${/^Nothing free/.test(english) ? 'उस समय कोई खाली नहीं है, पर आगे के खाली समय ये हैं। ' : ''}` +
    `${who}${docs.length} ${kind} मिले हैं। ${top.join('। ')}। ` +
    `${docs.length > 3 ? 'बाकी स्क्रीन पर हैं। ' : ''}` +
    `${real ? `आपके पास के ${real} असली क्लिनिक भी स्क्रीन पर हैं, फ़ोन करने के लिए। ` : ''}` +
    `किसे बुक करूँ?`
  );
}

function timesHi(d: Any): string {
  const name = d.doctor?.name ?? 'डॉक्टर';
  const times = ((d.times ?? []) as Any[]).map((t) => new Date(t.start));
  if (times.length === 0) return `${name} के पास उस समय कोई खाली समय नहीं है। क्या मैं कोई और दिन देखूँ?`;
  const byDay = new Map<string, Date[]>();
  for (const t of times) byDay.set(dayHi(t), [...(byDay.get(dayHi(t)) ?? []), t]);
  const spoken = [...byDay.entries()].slice(0, 2).map(([day, list]) => {
    const [first, ...rest] = list.slice(0, 4);
    return `${day} ${partOfDay(istParts(first).hour)} ${[first, ...rest].map(clockDigits).join(', ')} बजे`;
  });
  return `${name} ${spoken.join(' और ')} खाली हैं। ${d.replacesAppointment ? 'कौन सा नया समय रखूँ? नया समय बुक होने तक पुराना समय बना रहेगा।' : 'कौन सा समय बुक करूँ?'}`;
}

function confirmHi(h: Household, d: Any): string {
  const s = d.summary as Any;
  const who = personHi(h, s.patientSpoken ?? s.patient);
  const area = areaOf(s.address);
  return (
    `${ka(who)} अपॉइंटमेंट ${s.doctor} के साथ ${whenHi(new Date(s.start))}, ${area ? `${area} के ` : ''}${cleanClinic(s.clinic)} में। फ़ीस ${s.fee} रुपये।` +
    `${s.instructions ? ` क्लिनिक का कहना है: ${clinicNoteHi(s.instructions)}` : ''} क्या मैं बुक कर दूँ?`
  );
}

function bookedHi(h: Household, d: Any, english: string): string {
  const s = d.summary as Any;
  const who = personHi(h, s.patientSpoken ?? s.patient);
  const leave = d.leaveBy ? new Date(d.leaveBy) : null;
  const leaveText = !leave ? '' : leave <= clock.now() ? ' अभी निकल जाइए।' : ` ${clockHi(leave)} बजे तक घर से निकल जाइए।`;
  const told = ((d.messages ?? []) as Any[]).map((m) => personHi(h, m.to));
  return (
    `हो गया! ${ka(who)} अपॉइंटमेंट ${s.doctor} के साथ ${whenHi(new Date(s.start))} बुक हो गया है।${leaveText}` +
    ` क्लिनिक लगभग ${d.travel?.minutes ?? '?'} मिनट दूर है।` +
    `${told.length ? ` मैंने ${told.join(' और ')} के फ़ोन पर जानकारी भेज दी है।` : ''}` +
    `${/cancelled the old time/.test(english) ? ' पुराना समय रद्द कर दिया है।' : ''}` +
    ' क्लिनिक के मंज़ूर करते ही मैं बता दूँगी।'
  );
}

const CLINIC_STATE_HI: Record<string, string> = { new: 'क्लिनिक की मंज़ूरी बाकी है', accepted: 'क्लिनिक ने मंज़ूर कर लिया है', rejected: 'क्लिनिक ने मना कर दिया है' };

// Why a clinic could not take a booking (the reasons on the clinic desk).
const REASONS_HI: Array<[RegExp, string]> = [
  [/doctor.*not available/i, 'डॉक्टर उस समय उपलब्ध नहीं हैं'],
  [/closed/i, 'उस दिन क्लिनिक बंद है'],
  [/another time/i, 'कृपया किसी और समय आइए'],
];
const reasonHi = (note: string) => REASONS_HI.find(([re]) => re.test(note))?.[1] ?? note;

/** What Alexa says by herself when a clinic accepts a booking or cannot take it. */
export function noticeSpeech(household: Household, n: { kind: string; patientSpoken: string; doctor: string; clinic: string; start: string; note: string | null; speech: string }): string {
  if (!isHindi(household)) return n.speech;
  const who = personHi(household, n.patientSpoken);
  const when = whenHi(new Date(n.start));
  if (n.kind === 'clinic-accepted') return `अच्छी ख़बर। ${n.clinic} ने ${ka(who)} ${n.doctor} के साथ ${when} का अपॉइंटमेंट मंज़ूर कर लिया है।`;
  return `${n.clinic} से संदेश: वे ${ka(who)} ${n.doctor} के साथ ${when} का अपॉइंटमेंट नहीं ले पाएँगे${n.note ? `, क्योंकि ${reasonHi(n.note)}` : ''}। क्या मैं कोई और समय ढूँढूँ?`;
}

function usualHi(h: Household, d: Any): string {
  const doc = d.doctor as Any;
  const who = personHi(h, d.patientSpoken ?? d.patient);
  const first = doc.firstSlot ? new Date(doc.firstSlot.start) : null;
  return `${ke(who)} ${specialtyHi(doc.specialty)} ${doc.name} हैं।${first ? ` ${whenHi(first)} का समय खाली है। क्या मैं बुक कर दूँ?` : ''}`;
}

function appointmentsHi(h: Household, d: Any): string {
  const list = (d.appointments ?? []) as Any[];
  if (list.length === 0) return 'कोई आने वाला अपॉइंटमेंट नहीं है।';
  const spoken = list.slice(0, 3).map((a) => `${ka(personHi(h, a.patient))} ${a.doctor} के साथ ${whenHi(new Date(a.start))}${CLINIC_STATE_HI[a.clinicState] ? `, ${CLINIC_STATE_HI[a.clinicState]}` : ''}`);
  return `${list.length === 1 ? 'एक अपॉइंटमेंट है' : `${list.length} अपॉइंटमेंट हैं`}: ${spoken.join('; ')}।`;
}

function remindersHi(h: Household, d: Any): string {
  const list = (d.reminders ?? []) as Any[];
  if (list.length === 0) return 'इस हफ़्ते कोई चेक-अप नहीं होना है।';
  const first = list[0];
  const due = first.dueOn <= istDay(clock.now()) ? 'अब होना है' : `${dateHi(first.dueOn)} को होना है`;
  return (
    `${ka(personHi(h, first.patientSpoken ?? first.patient))} चेक-अप${first.doctor ? ` ${first.doctor} के साथ` : ''} ${due}। क्या मैं समय देखूँ?` +
    `${list.length > 1 ? ` ${list.length - 1} और चेक-अप जल्द होने हैं।` : ''}`
  );
}

function nearbyHi(d: Any, english: string): string {
  const places = (d.places ?? []) as Any[];
  const kind = /hospital/.test(d.label ?? '') ? 'अस्पताल' : /pharmac/.test(d.label ?? '') ? 'दवा की दुकानें' : /lab/.test(d.label ?? '') ? 'लैब' : 'क्लिनिक';
  if (/Google Maps is not switched on/.test(english)) return 'मैं अभी असली क्लिनिक नहीं ढूँढ सकती, क्योंकि इस DocSaathi में Google Maps चालू नहीं है।';
  if (places.length === 0) return `मुझे Google Maps पर आपके पास ${kind} नहीं मिले।`;
  const say = (p: Any) => `${spokenPlace(p.name)}, ${p.travel?.minutes ?? '?'} मिनट दूर${p.rating ? `, रेटिंग ${p.rating}` : ''}${p.openNow ? ', अभी खुला है' : ''}`;
  return (
    `Google Maps से आपके पास के असली ${kind} ये हैं। सबसे पास ${say(places[0])}।${places[1] ? ` उसके बाद ${say(places[1])}।` : ''} ` +
    `मैं इन्हें आवाज़ से बुक नहीं कर सकती, पर इनके फ़ोन नंबर और रास्ता स्क्रीन पर हैं।`
  );
}

function emergencyHi(d: Any): string {
  if (d.emergencyKind === 'mental-health') {
    return 'मुझे बहुत दुख है कि आप इस दौर से गुज़र रहे हैं। कृपया अभी टेली-मानस को 14416 पर कॉल कीजिए। यह मुफ़्त है और दिन-रात खुला है। अगर किसी की जान को ख़तरा है, तो 112 पर कॉल कीजिए। मैं इसके लिए अपॉइंटमेंट बुक नहीं करूँगी।';
  }
  return `यह इमरजेंसी लग रही है। अभी 112 पर कॉल कीजिए, या एम्बुलेंस के लिए 108 पर। मैं इसके लिए क्लिनिक का अपॉइंटमेंट बुक नहीं करूँगी।${(d.hospitals ?? []).length ? ' पास के अस्पताल स्क्रीन पर हैं।' : ''}`;
}

function resultHi(h: Household, call: ToolCall): string | undefined {
  const d = (call.result.structuredContent ?? {}) as Any;
  const english = speechOf(call);
  switch (d.kind) {
    case 'doctors':
      return doctorsHi(h, d, english);
    case 'times':
      return timesHi(d);
    case 'confirm':
      return confirmHi(h, d);
    case 'booked':
      return bookedHi(h, d, english);
    case 'usual':
      return usualHi(h, d);
    case 'appointments':
      return appointmentsHi(h, d);
    case 'reminders':
      return remindersHi(h, d);
    case 'emergency':
      return emergencyHi(d);
    case 'nearby':
      return nearbyHi(d, english);
    case 'cancelled':
      return d.patient && d.start ? `${ka(personHi(h, d.patient))} ${d.doctor} के साथ ${whenHi(new Date(d.start))} का अपॉइंटमेंट रद्द कर दिया है। क्लिनिक को बता दिया गया है।` : undefined;
    case 'follow-up':
      return `ठीक है। जब ${ka(personHi(h, d.patient))} चेक-अप${d.doctor ? ` ${d.doctor} के साथ` : ''} होना होगा, लगभग ${dateHi(d.dueOn)} को, मैं याद दिला दूँगी।`;
    case 'family':
      return `आपका परिवार: ${((d.members ?? []) as Any[]).map((m) => personHi(h, m.label)).join(', ')}।`;
    case 'family-added':
      return `${ko(personHi(h, d.member?.label ?? ''))} परिवार में जोड़ दिया है।`;
    case 'location':
      return `ठीक है। अब से मैं ${d.home?.label ?? 'वहाँ'} के पास के डॉक्टर ढूँढूँगी।`;
    default:
      return serverTextHi(h, english, d);
  }
}

/**
 * What to say for a tool result, in the family's language. If a Hindi sentence is not written
 * for it yet, the server's English one is used (better exact English than guessed Hindi).
 */
export function toolSpeech(household: Household, call: ToolCall): string {
  if (!isHindi(household) || kindOf(call) === 'unknown') return speechOf(call);
  try {
    return resultHi(household, call) ?? speechOf(call);
  } catch {
    return speechOf(call);
  }
}
