// All times in DocSaathi are India Standard Time (UTC+05:30, no daylight saving).
const IST_OFFSET_MIN = 330;
const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

// Demo clock: the demo can "jump forward" (e.g. 3 months) to show follow-up reminders.
let offsetMs = 0;
export const clock = {
  now(): Date {
    return new Date(Date.now() + offsetMs);
  },
  jump(ms: number): void {
    offsetMs += ms;
  },
  reset(): void {
    offsetMs = 0;
  },
  get offsetMs(): number {
    return offsetMs;
  },
};

export interface IstParts {
  year: number;
  month: number; // 1-12
  day: number;
  hour: number;
  minute: number;
  weekday: number; // 0 = Sunday
}

export function istParts(date: Date): IstParts {
  const shifted = new Date(date.getTime() + IST_OFFSET_MIN * MINUTE);
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
    hour: shifted.getUTCHours(),
    minute: shifted.getUTCMinutes(),
    weekday: shifted.getUTCDay(),
  };
}

/** Build a Date from an IST calendar date + wall-clock time. */
export function istDate(year: number, month: number, day: number, hour = 0, minute = 0): Date {
  return new Date(Date.UTC(year, month - 1, day, hour, minute) - IST_OFFSET_MIN * MINUTE);
}

const pad = (n: number) => String(n).padStart(2, '0');

/** ISO 8601 with the +05:30 offset, e.g. 2026-10-02T18:30:00+05:30 */
export function toIstIso(date: Date): string {
  const p = istParts(date);
  return `${p.year}-${pad(p.month)}-${pad(p.day)}T${pad(p.hour)}:${pad(p.minute)}:00+05:30`;
}

/** YYYY-MM-DD in IST */
export function istDay(date: Date): string {
  const p = istParts(date);
  return `${p.year}-${pad(p.month)}-${pad(p.day)}`;
}

export function startOfIstDay(date: Date): Date {
  const p = istParts(date);
  return istDate(p.year, p.month, p.day);
}

export function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * DAY);
}

export function addMinutes(date: Date, minutes: number): Date {
  return new Date(date.getTime() + minutes * MINUTE);
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "6:30 PM" */
export function formatTime(date: Date): string {
  const p = istParts(date);
  const h12 = p.hour % 12 === 0 ? 12 : p.hour % 12;
  return `${h12}:${pad(p.minute)} ${p.hour < 12 ? 'AM' : 'PM'}`;
}

/** "Thu 1 Oct" */
export function formatDay(date: Date): string {
  const p = istParts(date);
  return `${WEEKDAYS[p.weekday]} ${p.day} ${MONTHS[p.month - 1]}`;
}

/** "today", "tomorrow" or "Thu 1 Oct", relative to the demo clock. */
export function relativeDay(date: Date, now = clock.now()): string {
  const diff = Math.round((startOfIstDay(date).getTime() - startOfIstDay(now).getTime()) / DAY);
  if (diff === 0) return 'today';
  if (diff === 1) return 'tomorrow';
  return formatDay(date);
}

/** "today at 6:30 PM" */
export function speakableWhen(date: Date, now = clock.now()): string {
  return `${relativeDay(date, now)} at ${formatTime(date)}`;
}

// Speech recognition in Hindi (hi-IN) returns Devanagari. Map time words and digits to the
// romanised forms the parsers below understand. Whole words only: "कल" (tomorrow) must not be
// changed inside "तकलीफ" (trouble). (A regex word boundary does not work for Devanagari, so its letters are named.)
const hiWord = (word: string) => new RegExp(`(?<![\u0900-\u097F])(?:${word})(?![\u0900-\u097F])`, 'g');
const DEVANAGARI: Array<[RegExp, string]> = [
  [hiWord('परसों'), ' parso '],
  [hiWord('आज'), ' aaj '],
  [hiWord('कल'), ' kal '],
  [hiWord('सुबह'), ' subah '],
  [hiWord('दोपहर'), ' dopahar '],
  [hiWord('शाम'), ' shaam '],
  [hiWord('रात'), ' raat '],
  [hiWord('बजे'), ' baje '],
  [hiWord('साढ़े'), ' saadhe '],
  [hiWord('महीन[ेा]|महीनों'), ' mahine '],
  [hiWord('हफ्त[ेा]|हफ़्त[ेा]|हफ्तों'), ' hafte '],
  [hiWord('दिन|दिनों'), ' din '],
  [hiWord('साल|सालों'), ' saal '],
];
const DEVANAGARI_DIGITS = '०१२३४५६७८९';

// Spoken clock numbers ("saat baje", "सात बजे"). Only changed right before "baje", so the
// English word "do" and the Hindi "do" (two) in other places stay as they are.
const CLOCK_WORDS: Array<[string, number]> = [
  ['ek|एक', 1],
  ['do|दो', 2],
  ['teen|तीन', 3],
  ['chaar|char|चार', 4],
  ['paanch|panch|पांच|पाँच', 5],
  ['chhah|chhe|cheh|che|छह|छः|छे', 6],
  ['saat|सात', 7],
  ['aath|आठ', 8],
  ['nau|नौ', 9],
  ['das|दस', 10],
  ['gyarah|gyaarah|ग्यारह', 11],
  ['barah|baarah|बारह', 12],
];

export function normalizeIndic(text: string): string {
  let out = text.replace(/[०-९]/g, (d) => String(DEVANAGARI_DIGITS.indexOf(d)));
  for (const [re, word] of DEVANAGARI) out = out.replace(re, word);
  for (const [words, n] of CLOCK_WORDS) out = out.replace(new RegExp(`(^|[\\s,])(?:${words})\\s+baje`, 'gi'), `$1${n} baje`);
  // "saadhe 6 baje" = 6:30, "sawa 6" = 6:15, "paune 7" = 6:45
  out = out
    .replace(/\b(?:saadhe|sadhe|sade)\s+(\d{1,2})\b/gi, '$1:30')
    .replace(/\b(?:sawa|sava)\s+(\d{1,2})\b/gi, '$1:15')
    .replace(/\b(?:paune|pone)\s+(\d{1,2})\b/gi, (_m, n: string) => `${Number(n) - 1 || 12}:45`);
  return out;
}

export interface TimeWindow {
  from: Date;
  to: Date;
  label: string;
}

// Whole words only: "sun" must not match "Dr. Sunita", nor "mon" match "month".
const WEEKDAY_WORDS = [
  'sun|sunday|ravivar|raviwar|itwar|itvaar',
  'mon|monday|somvar|somwar',
  'tue|tues|tuesday|mangalvar|mangalwar',
  'wed|wednesday|budhvar|budhwar',
  'thu|thur|thurs|thursday|guruvar|guruwar',
  'fri|friday|shukravar|shukrawar',
  'sat|saturday|shanivar|shaniwar',
];
/** A day someone said: "kal", "tomorrow", "Saturday", "shanivar". */
export const DAY_WORD = new RegExp(`\\b(day after tomorrow|today|tonight|tomorrow|tmrw|aaj|kal|parso|parson|${WEEKDAY_WORDS.join('|')})\\b`, 'i');
/** A part of the day someone said: "subah", "evening". */
export const PART_WORD = /\b(morning|subah|savere|afternoon|dopahar|dopeher|evening|shaam|sham|tonight|raat|night)\b/i;

const PART_OF_DAY: Record<string, [number, number]> = {
  morning: [6, 12],
  afternoon: [12, 16],
  evening: [16, 21],
  night: [19, 23],
};

/**
 * Turn everyday words ("tonight", "kal subah", "tomorrow evening", "2026-10-05")
 * into a search window. Defaults to "the next 3 days".
 */
export function parseWhen(text: string | undefined, now = clock.now()): TimeWindow {
  const t = normalizeIndic(text ?? '').toLowerCase().trim();
  const today = startOfIstDay(now);
  let day: Date | undefined;
  let dayLabel = '';

  const iso = t.match(/(\d{4})-(\d{2})-(\d{2})/);
  if (iso) {
    day = istDate(Number(iso[1]), Number(iso[2]), Number(iso[3]));
    dayLabel = formatDay(day);
  } else if (/\b(day after tomorrow|parso|parson)\b/.test(t)) {
    day = addDays(today, 2);
    dayLabel = 'day after tomorrow';
  } else if (/\b(tomorrow|kal|tmrw)\b/.test(t)) {
    day = addDays(today, 1);
    dayLabel = 'tomorrow';
  } else if (/\b(today|aaj|tonight|abhi|now)\b/.test(t)) {
    day = today;
    dayLabel = 'today';
  } else {
    const wd = WEEKDAY_WORDS.findIndex((w) => new RegExp(`\\b(${w})\\b`).test(t));
    if (wd >= 0) {
      const delta = (wd - istParts(now).weekday + 7) % 7 || 7;
      day = addDays(today, delta);
      dayLabel = formatDay(day);
    }
  }

  let part: string | undefined;
  if (/\b(tonight|raat)\b/.test(t)) part = 'evening';
  else if (/\b(morning|subah|savere)\b/.test(t)) part = 'morning';
  else if (/\b(afternoon|dopahar|dopeher)\b/.test(t)) part = 'afternoon';
  else if (/\b(evening|shaam|sham)\b/.test(t)) part = 'evening';
  else if (/\bnight\b/.test(t)) part = 'night';

  if (!day && part) {
    day = today;
    dayLabel = 'today';
  }
  if (!day) {
    return { from: now, to: addDays(today, 3), label: 'in the next 3 days' };
  }
  let from = day;
  let to = addDays(day, 1);
  if (part) {
    const [h1, h2] = PART_OF_DAY[part];
    from = addMinutes(day, h1 * 60);
    to = addMinutes(day, h2 * 60);
  }
  if (from < now) from = now;
  const label = part ? `${dayLabel} ${part === 'evening' && /tonight/.test(t) ? '(tonight)' : part}`.trim() : dayLabel;
  return { from, to, label };
}

/** Parse "6:30 PM", "18:30", "6.30 pm", "saadhe chhe" is out of scope. Returns minutes after midnight. */
export function parseClockTime(text: string): number | undefined {
  const t = normalizeIndic(text).toLowerCase().replace(/\s+/g, ' ').trim();
  const m = t.match(/(\d{1,2})(?:[:.](\d{2}))?\s*(am|pm|baje)?/);
  if (!m) return undefined;
  let h = Number(m[1]);
  const min = m[2] ? Number(m[2]) : 0;
  const suffix = m[3];
  if (h > 23 || min > 59) return undefined;
  if (suffix === 'pm' && h < 12) h += 12;
  if (suffix === 'am' && h === 12) h = 0;
  if (!suffix || suffix === 'baje') {
    // No AM/PM: use the part of the day if they said one ("subah 7 baje", "shaam 8 baje")...
    if (/\b(morning|subah|savere)\b/.test(t)) {
      if (h === 12) h = 0;
    } else if (/\b(evening|shaam|sham|raat|night|tonight)\b/.test(t)) {
      if (h < 12) h += 12;
    } else if (/\b(afternoon|dopahar|dopeher)\b/.test(t)) {
      if (h <= 6) h += 12;
    } else if (h >= 1 && h <= 7) {
      // ...else guess like a clinic would: 1-7 is evening, 8-11 is morning.
      h += 12;
    }
  }
  return h * 60 + min;
}

export function minutesOfDay(date: Date): number {
  const p = istParts(date);
  return p.hour * 60 + p.minute;
}

/** "3 months", "2 weeks", "10 days", "teen mahine" (numbers only) -> days */
export function parseDurationDays(text: string): number | undefined {
  const t = normalizeIndic(text).toLowerCase();
  const m = t.match(/(\d+)\s*(day|din|week|hafte|hafta|month|mahine|mahina|year|saal)/);
  if (!m) return undefined;
  const n = Number(m[1]);
  const unit = m[2];
  if (unit.startsWith('day') || unit === 'din') return n;
  if (unit.startsWith('week') || unit.startsWith('haft')) return n * 7;
  if (unit.startsWith('month') || unit.startsWith('mahin')) return n * 30;
  return n * 365;
}
