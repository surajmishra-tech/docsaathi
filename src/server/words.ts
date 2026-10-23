// Everyday Indian health words -> the kind of doctor to see.
// This only ROUTES to a type of doctor. It never diagnoses anything.

export type SpecialtyCode =
  | 'GENERAL_MEDICINE'
  | 'PEDIATRICS'
  | 'DIABETOLOGY'
  | 'CARDIOLOGY'
  | 'ORTHOPEDICS'
  | 'DENTISTRY'
  | 'OPHTHALMOLOGY'
  | 'DERMATOLOGY'
  | 'ENT'
  | 'GYNECOLOGY'
  | 'PSYCHIATRY';

export interface Specialty {
  code: SpecialtyCode;
  name: string; // what the doctor is called
  plain: string; // how a family says it
}

export const SPECIALTIES: Record<SpecialtyCode, Specialty> = {
  GENERAL_MEDICINE: { code: 'GENERAL_MEDICINE', name: 'General Physician', plain: 'family doctor' },
  PEDIATRICS: { code: 'PEDIATRICS', name: 'Pediatrician', plain: 'child doctor' },
  DIABETOLOGY: { code: 'DIABETOLOGY', name: 'Diabetologist', plain: 'sugar doctor' },
  CARDIOLOGY: { code: 'CARDIOLOGY', name: 'Cardiologist', plain: 'heart doctor' },
  ORTHOPEDICS: { code: 'ORTHOPEDICS', name: 'Orthopedic', plain: 'bone and joint doctor' },
  DENTISTRY: { code: 'DENTISTRY', name: 'Dentist', plain: 'teeth doctor' },
  OPHTHALMOLOGY: { code: 'OPHTHALMOLOGY', name: 'Eye Specialist', plain: 'eye doctor' },
  DERMATOLOGY: { code: 'DERMATOLOGY', name: 'Dermatologist', plain: 'skin doctor' },
  ENT: { code: 'ENT', name: 'ENT Specialist', plain: 'ear, nose and throat doctor' },
  GYNECOLOGY: { code: 'GYNECOLOGY', name: 'Gynecologist', plain: "women's doctor" },
  PSYCHIATRY: { code: 'PSYCHIATRY', name: 'Psychiatrist', plain: 'mind and mood doctor' },
};

// Order matters: more specific phrases first. Romanised Hindi, Hinglish, English and Devanagari.
const WORDS: Array<[SpecialtyCode, RegExp]> = [
  ['PEDIATRICS', /(\bchild(ren)?\b|\bkids?\b|\bbaby\b|\binfant|\btoddler|pa?ediatric|\bba(c+)h?c?h?(a|e|on|o)\b|\bshishu|बच्च|शिशु|बाल रोग)/],
  ['DIABETOLOGY', /(sugar|diabet|endocrin|madhumeh|insulin|thyroid|शुगर|डायबिट|मधुमेह|थायर)/],
  ['CARDIOLOGY', /(\bheart|cardio|\bdil\b|dhadkan|palpitat|cholesterol|हृदय|दिल|धड़कन)/],
  [
    'ORTHOPEDICS',
    /(\bbones?\b|haddi|\bjoints?\b|\bknee|ghutn|ortho|back ?pain|back ?ache|kamar|\bpeeth\b|fracture|sprain|\bmoch\b|neck pain|gardan|shoulder|kandh[ae]|\blegs?\b|pair (me|mein) dard|pairon|\bankle|\bwrist|kalai|\belbow|kohni|slip ?dis[ck]|arthritis|gathiya|jodo?n? (ka|ke|me|mein) dard|sciatica|हड्डी|घुटन|कमर|जोड़|पीठ|गर्दन)/,
  ],
  ['DENTISTRY', /(\bteeth\b|\btooth|\bdent(ist|al)?\b|daant|\bdant\b|\bdaadh\b|masood|\bgums?\b|cavity|braces|root canal|दांत|दाँत|मसूड़)/],
  ['OPHTHALMOLOGY', /(\beyes?\b|ophthalm|\baa?nkh|\bvision\b|eye ?sight|\bnazar\b|dhundhla|\bblur|chashm|\bspecs\b|spectacle|cataract|motiyabind|आंख|आँख|चश्म|नज़र|धुंधला)/],
  [
    'DERMATOLOGY',
    /(\bskin\b|twacha|\brash(es)?\b|pimple|\bacne\b|muhase|\bitch|khujli|hair ?fall|hair ?loss|baal jhad|dandruff|eczema|psoriasis|fungal|\bdaane\b|\bdane\b|phunsi|\bboils?\b|derma|स्किन|त्वचा|खुजली|दाने|मुंहासे|मुहांसे)/,
  ],
  [
    'ENT',
    /(\bears?\b|ear ?ache|\bkaan\b|hearing|sunai|\bnose\b|\bnaak\b|nose ?bleed|nakseer|throat|\bgal[ae]\b|kharash|\bent\b|sinus|tonsil|snor|kharrate|कान|नाक|गला|गले)/,
  ],
  ['GYNECOLOGY', /(\bgyn|ladies doctor|ladies problem|women'?s doctor|pregnan|\bperiods?\b|mahwari|masik|\bpco[ds]\b|white discharge|mahila rog|stri rog|स्त्री रोग|गर्भ|माहवारी|पीरियड)/],
  ['PSYCHIATRY', /(psychiat|\bmental\b|depress|anxiety|anxious|\bstress|\btension\b|\bpanic|ghabrahat|udaas|udasi|neend nahi|insomnia|can'?t sleep|sleep problem|counsel|therap|\bmann? ka\b|मानसिक|तनाव|नींद नहीं)/],
  [
    'GENERAL_MEDICINE',
    /(general|physician|family doctor|normal doctor|\bmbbs\b|fever|bukhar|bukhaar|\bcold\b|\bsardi\b|khansi|cough|zukam|jukam|jukaam|\bnazla\b|\bflu\b|viral|\bbp\b|blood pressure|weakness|kamzori|thakan|fatigue|\bpet\b|stomach|tummy|acidity|\bgas\b|kabz|constipat|loose motion|\bdast\b|diarrh|\bulti|vomit|nausea|headache|s[ia]r ?dard|s[ia]r (me|mein) dard|migraine|chakkar|dizz|body ?pain|badan dard|infection|malaria|dengue|typhoid|बुखार|खांसी|सर्दी|पेट|सिर ?दर्द|सरदर्द|उल्टी|दस्त|जुकाम|ज़ुकाम|कमज़ोरी|कमजोरी)/,
  ],
];

export interface SpecialtyMatch {
  code: SpecialtyCode;
  matched: string | null; // the words we understood, for the spoken reply
  reason: 'words' | 'child-general' | 'default';
}

/**
 * Pick the kind of doctor from everyday words. When the words only say something general
 * (like "fever") and the patient is a child, a pediatrician is the right doctor.
 */
export function resolveSpecialty(need: string | undefined, patientAge?: number): SpecialtyMatch {
  const text = plain(need);
  for (const [code, re] of WORDS) {
    const m = text.match(re);
    if (m) {
      if (code === 'GENERAL_MEDICINE' && patientAge !== undefined && patientAge < 14) {
        return { code: 'PEDIATRICS', matched: m[0], reason: 'child-general' };
      }
      return { code, matched: m[0], reason: 'words' };
    }
  }
  if (patientAge !== undefined && patientAge < 14) {
    return { code: 'PEDIATRICS', matched: null, reason: 'child-general' };
  }
  return { code: 'GENERAL_MEDICINE', matched: null, reason: 'default' };
}

// ---------------------------------------------------------------------------
// Safety: emergencies are never booked. Official Indian numbers:
// 112 (all emergencies), 108 (ambulance), 14416 (Tele-MANAS mental health, free, 24x7).

export interface EmergencyCheck {
  emergency: true;
  kind: 'medical' | 'mental-health';
  speech: string;
}

const MEDICAL_EMERGENCY = new RegExp(
  [
    // chest pain / heart attack (words may sit in between: "seene mein tez dard", "सीने में तेज़ दर्द")
    'chest pain', 'pain in (his|her|my|the) chest', 'seene (me|mein|main) .{0,15}dard', 'chhati (me|mein) .{0,15}dard', 'heart attack', 'dil ka daura',
    'सीने में .{0,12}दर्द', 'छाती में .{0,12}दर्द',
    // breathing
    "can'?t breathe", 'cannot breathe', 'not breathing', 'breathless', 'short(ness)? of breath', '(difficulty|trouble|problem) breathing', 'breathing (difficulty|trouble|problem)',
    'saans (nahi|nahin|nhi)', 'saans (lene )?(me|mein) .{0,15}(dikkat|taklif|takleef|pareshani)', 'saans phool', 'सांस नहीं', 'सांस (लेने )?में .{0,15}(तकलीफ|दिक्कत|परेशानी)', 'सांस फूल',
    // unconscious, stroke, seizure
    'unconscious', 'behosh', 'बेहोश', "(not|isn'?t|won'?t|is not) waking up", "can'?t wake (him|her)", 'uth nahi (raha|rahi|rahe)', 'hosh nahi', 'होश नहीं',
    'stroke', 'lakwa', 'लकवा', 'paralys', 'face (is )?drooping', 'drooping face', 'slurred speech', "can'?t speak properly", 'bol (bhi )?nahi pa', 'zubaan ladkhada',
    'fits\\b', 'seizure', 'mirgi', 'मिर्गी', 'daur[ae] pa?d', 'daure aa', 'दौरा',
    // bleeding, poison, burns, accidents
    'heavy bleeding', 'bleeding (a lot|heavily)', 'bahut khoon', 'khoon (beh|nikal)', 'बहुत खून', 'burn(ed|t)? badly', 'severe accident', 'bada accident',
    // poison and swallowed medicine
    'poison', 'zeher', 'zehar', 'ज़हर', 'जहर', 'overdose', 'swallowed (a |the )?(whole |full )?(bottle|strip|lot of)', 'puri (sheeshi|shishi|bottle)',
    '(bahut|saari|sari|zyada) (goliyan|goli|dawai|dawa) (kha|pee|pi)', 'galti se .{0,25}(pee|pi|kha) (li|liya|liye)',
  ].join('|'),
);
const SELF_HARM = /(suicid|kill myself|end my life|want to die|(don'?t|do not) want to live|no reason to live|hurt myself|marna chahta|marna chahti|jeena nahi|jina nahi|zinda nahi rehna|aatmahatya|आत्महत्या|जीना नहीं|मरना चाहत)/;

/** Phones type curly quotes ("can’t"); the word lists use straight ones. */
const plain = (text: string | undefined) => (text ?? '').toLowerCase().replace(/[‘’`]/g, "'");

export function checkEmergency(text: string | undefined): EmergencyCheck | null {
  const t = plain(text);
  if (SELF_HARM.test(t)) {
    return {
      emergency: true,
      kind: 'mental-health',
      speech:
        "I'm really sorry you're going through this. Please call Tele-MANAS on 14416 now. It's free and open all day and night. If anyone is in danger, call 112. I won't book an appointment for this.",
    };
  }
  if (MEDICAL_EMERGENCY.test(t)) {
    return {
      emergency: true,
      kind: 'medical',
      speech:
        'This sounds like an emergency. Please call 112 now, or 108 for an ambulance. I will not book a clinic appointment for this.',
    };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Family words. Alexa+ India understands relation words; so does DocSaathi.

export const RELATIONS: Record<string, string[]> = {
  self: ['me', 'myself', 'mujhe', 'mera', 'meri', 'mere liye', 'main', 'मैं', 'मुझे', 'मेरे लिए', 'मेरा', 'मेरी'],
  dadi: ['dadi', 'daadi', 'grandma', 'grandmother', 'dadiji', 'दादी'],
  dada: ['dada', 'daada', 'grandpa', 'grandfather', 'dadaji', 'दादा'],
  nani: ['nani', 'naani', 'नानी'],
  nana: ['nana', 'naana', 'नाना'],
  papa: ['papa', 'father', 'dad', 'daddy', 'pitaji', 'pita', 'पापा', 'पिताजी'],
  mummy: ['mummy', 'mother', 'mom', 'mum', 'maa', 'mataji', 'मम्मी', 'माँ', 'मां'],
  son: ['son', 'beta', 'bete', 'बेटा', 'बेटे'],
  daughter: ['daughter', 'beti', 'बेटी'],
  brother: ['brother', 'bhai', 'bhaiya', 'भाई', 'भैया'],
  sister: ['sister', 'behen', 'behan', 'bahan', 'didi', 'बहन', 'दीदी'],
  wife: ['wife', 'patni', 'पत्नी'],
  husband: ['husband', 'pati', 'पति'],
  chacha: ['chacha', 'chachaji', 'चाचा'],
  chachi: ['chachi', 'चाची'],
  bua: ['bua', 'buaji', 'बुआ'],
  mama: ['mama', 'mamaji', 'मामा'],
  mami: ['mami', 'मामी'],
  bhabhi: ['bhabhi', 'भाभी'],
  devar: ['devar', 'देवर'],
  jethani: ['jethani', 'जेठानी'],
  bhanja: ['bhanja', 'भांजा'],
  bhateeja: ['bhateeja', 'bhatija', 'भतीजा'],
  bhateeji: ['bhateeji', 'bhatiji', 'भतीजी'],
};

/** Which relation key does this text mention, if any? ("meri bhabhi" is bhabhi, not "me".) */
export function relationFromText(text: string): string | undefined {
  const t = ` ${plain(text)} `;
  const entries = Object.entries(RELATIONS).sort(([a], [b]) => Number(a === 'self') - Number(b === 'self'));
  for (const [key, words] of entries) {
    for (const w of words) {
      if (/^[a-z ]+$/.test(w)) {
        if (new RegExp(`(^|[^a-z])${w}([^a-z]|$)`).test(t)) return key;
      } else if (t.includes(w)) {
        return key;
      }
    }
  }
  return undefined;
}

export const LANGUAGE_NAMES: Record<string, string> = {
  en: 'English',
  hi: 'Hindi',
  mr: 'Marathi',
  gu: 'Gujarati',
  ta: 'Tamil',
  te: 'Telugu',
  kn: 'Kannada',
  bn: 'Bengali',
  ml: 'Malayalam',
  pa: 'Punjabi',
  ur: 'Urdu',
};

export function languageFromText(text: string | undefined): string | undefined {
  const t = (text ?? '').toLowerCase();
  for (const [code, name] of Object.entries(LANGUAGE_NAMES)) {
    if (t.includes(name.toLowerCase())) return code;
  }
  return undefined;
}
