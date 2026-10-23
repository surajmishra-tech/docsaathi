import { describe, expect, it } from 'vitest';
import { freeSlots } from '../src/server/uhi/testnet/slots.js';
import { formatTime, istDate, istParts, normalizeIndic, parseClockTime, parseDurationDays, parseWhen, toIstIso } from '../src/server/time.js';

// Wed 30 Sep 2026, 11:00 AM IST
const NOW = istDate(2026, 9, 30, 11, 0);

describe('time words (IST)', () => {
  it('"aaj shaam" = today 4 PM to 9 PM', () => {
    const w = parseWhen('aaj shaam', NOW);
    expect(toIstIso(w.from)).toBe('2026-09-30T16:00:00+05:30');
    expect(toIstIso(w.to)).toBe('2026-09-30T21:00:00+05:30');
  });

  it('Hindi time words are changed only as whole words', () => {
    expect(normalizeIndic('कल सुबह').replace(/\s+/g, ' ').trim()).toBe('kal subah');
    // "कल" (tomorrow) sits inside "तकलीफ" (trouble): that word must stay as it is.
    expect(normalizeIndic('सांस लेने में बहुत तकलीफ है')).toContain('तकलीफ');
  });

  it('"kal subah" = tomorrow morning', () => {
    const w = parseWhen('kal subah', NOW);
    expect(toIstIso(w.from)).toBe('2026-10-01T06:00:00+05:30');
    expect(toIstIso(w.to)).toBe('2026-10-01T12:00:00+05:30');
  });

  it('a window that already started begins now', () => {
    expect(parseWhen('today', NOW).from.getTime()).toBe(NOW.getTime());
  });

  it('no words = the next 3 days', () => {
    expect(parseWhen(undefined, NOW).label).toBe('in the next 3 days');
  });

  it.each([
    ['6:30 wala', 18 * 60 + 30],
    ['6.30 pm', 18 * 60 + 30],
    ['10 AM', 10 * 60],
    ['18:30', 18 * 60 + 30],
    ['10', 10 * 60],
  ])('clock time %s', (text, minutes) => {
    expect(parseClockTime(text)).toBe(minutes);
  });

  it.each([
    ['3 months', 90],
    ['2 weeks', 14],
    ['10 din', 10],
  ])('duration %s', (text, days) => {
    expect(parseDurationDays(text)).toBe(days);
  });

  it('formats IST times for speech', () => {
    expect(formatTime(istDate(2026, 10, 1, 18, 30))).toBe('6:30 PM');
    expect(istParts(istDate(2026, 10, 1, 0, 15)).hour).toBe(0);
  });
});

describe('free slots', () => {
  const schedule = { '3': [['10:00', '11:00'] as [string, string]], '4': [['10:00', '11:00'] as [string, string]] }; // Wed, Thu

  it('respects sessions, travel lead time and taken times', () => {
    const slots = freeSlots({
      schedule,
      slotMinutes: 15,
      from: istDate(2026, 9, 30),
      to: istDate(2026, 10, 2),
      taken: [{ start: istDate(2026, 10, 1, 10, 15), end: istDate(2026, 10, 1, 10, 30) }],
      now: istDate(2026, 9, 30, 10, 20), // Wed 10:20: slots before 10:35 are too soon
    });
    expect(slots.map((s) => toIstIso(s.start))).toEqual([
      '2026-09-30T10:45:00+05:30',
      '2026-10-01T10:00:00+05:30',
      // 10:15 Thu is taken
      '2026-10-01T10:30:00+05:30',
      '2026-10-01T10:45:00+05:30',
    ]);
  });
});
