// Today's use of the paid Amazon services: Bedrock requests and Polly characters. The counts are kept
// in data/aws-usage.json, so the daily limits that protect the AWS bill (BEDROCK_DAILY_LIMIT,
// POLLY_DAILY_CHARS) still hold after a restart, and across two DocSaathi processes at once (the app
// and an accuracy run, say). The day changes at midnight UTC, which is 5:30 AM in India.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { config } from './config.js';

export interface DayUse {
  day: string;
  bedrockRequests: number;
  pollyChars: number;
}

const today = () => new Date().toISOString().slice(0, 10);
let memory: DayUse = { day: '', bedrockRequests: 0, pollyChars: 0 };

/** Today's counts (zero on a new day). Read from the file each time: another process may have counted too. */
export function usedToday(): DayUse {
  const day = today();
  try {
    const saved = JSON.parse(readFileSync(config.usageFile, 'utf8')) as Partial<DayUse>;
    if (saved.day === day) memory = { day, bedrockRequests: Number(saved.bedrockRequests) || 0, pollyChars: Number(saved.pollyChars) || 0 };
  } catch {
    // No file yet, or it could not be read: the counts in memory still hold.
  }
  if (memory.day !== day) memory = { day, bedrockRequests: 0, pollyChars: 0 };
  return { ...memory };
}

export function addUse(kind: 'bedrockRequests' | 'pollyChars', amount: number): void {
  const now = usedToday();
  now[kind] += amount;
  memory = now;
  try {
    mkdirSync(dirname(config.usageFile), { recursive: true });
    writeFileSync(config.usageFile, JSON.stringify(now));
  } catch {
    // Could not save: the limit still holds until DocSaathi restarts.
  }
}
