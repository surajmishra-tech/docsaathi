import { addDays, addMinutes, istDate, istParts, startOfIstDay } from '../../time.js';

/** weekday (0 = Sunday) -> sessions like [["10:00","13:00"],["17:00","20:30"]] */
export type WeeklySchedule = Record<string, Array<[string, string]>>;

export interface Slot {
  start: Date;
  end: Date;
}

export interface TakenRange {
  start: Date;
  end: Date;
}

function hm(text: string): [number, number] {
  const [h, m] = text.split(':').map(Number);
  return [h, m];
}

/**
 * Free appointment slots for one doctor between `from` and `to`.
 * Slots must start at least `leadMinutes` after `now` so families have time to travel.
 */
export function freeSlots(opts: {
  schedule: WeeklySchedule;
  slotMinutes: number;
  from: Date;
  to: Date;
  taken: TakenRange[];
  now: Date;
  leadMinutes?: number;
  limit?: number;
}): Slot[] {
  const { schedule, slotMinutes, from, to, taken, now } = opts;
  const lead = opts.leadMinutes ?? 15;
  const limit = opts.limit ?? 50;
  const earliest = addMinutes(now, lead);
  const out: Slot[] = [];
  for (let day = startOfIstDay(from); day < to && out.length < limit; day = addDays(day, 1)) {
    const p = istParts(day);
    const sessions = schedule[String(p.weekday)] ?? [];
    for (const [open, close] of sessions) {
      const [oh, om] = hm(open);
      const [ch, cm] = hm(close);
      const sessionEnd = istDate(p.year, p.month, p.day, ch, cm);
      for (let start = istDate(p.year, p.month, p.day, oh, om); addMinutes(start, slotMinutes) <= sessionEnd; start = addMinutes(start, slotMinutes)) {
        const end = addMinutes(start, slotMinutes);
        if (start < from || start >= to || start < earliest) continue;
        const clash = taken.some((t) => start < t.end && end > t.start);
        if (!clash) out.push({ start, end });
        if (out.length >= limit) break;
      }
      if (out.length >= limit) break;
    }
  }
  return out;
}
