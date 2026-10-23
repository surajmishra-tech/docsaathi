import { linkRequired } from '../alexaLink.js';
import type { Notice } from '../booking.js';
import { setSpeaker, speakerOf, type Household } from '../family.js';
import { SPECIALTIES } from '../words.js';
import { aiRespond, rememberAnnouncement, resetAi } from './ai.js';
import { demoRespond, resetConversation as resetRules, stateOf, type BrainReply } from './demo.js';
import { hasHindi, L, noticeSpeech } from './hindi.js';
import { aiLabel, aiReady } from './models.js';

export type { BrainReply };

/** Is an AI model doing the understanding (BRAIN=bedrock or groq, with a key)? Otherwise the built-in rules do. */
export function aiBrain(): boolean {
  return aiReady();
}

/** Shown in the simulator's status bar. */
export function brainLabel(): string {
  return aiLabel();
}

export function resetConversation(householdId: string): void {
  resetRules(householdId);
  resetAi(householdId);
}

/**
 * One conversational turn: what the family said -> what Alexa says (+ the MCP tool call behind it).
 * With an AI key, a model understands the words and picks the tools; the rule brain is the
 * no-key mode and the safety net. The AI model is Claude on Amazon Bedrock (BRAIN=bedrock) or Groq (BRAIN=groq).
 */
export async function respond(household: Household, text: string): Promise<BrainReply> {
  // After a quiet while it may be someone else talking: forget who it was (never assume).
  const last = lastTurnAt.get(household.id);
  if (last !== undefined && Date.now() - last > SPEAKER_IDLE_MS) setSpeaker(household.id, null);
  lastTurnAt.set(household.id, Date.now());

  let reply: BrainReply;
  try {
    reply = aiBrain() ? await aiRespond(household, text) : { ...(await demoRespond(household, text)), by: 'rules' };
  } catch (err) {
    if (!linkRequired(err)) throw err;
    // Like a real Alexa skill that needs account linking: say so, and the screen shows "Link account".
    resetConversation(household.id);
    reply = { speech: L(household, 'linkFirst'), kind: 'link-required', tool: null, by: 'rules' };
  }
  if (reply.end) setSpeaker(household.id, null); // "bye": the next person may be someone else
  // Which voice should read it: a Hindi one if the answer is in Hindi script.
  return { ...reply, lang: hasHindi(reply.speech) ? 'hi' : 'en', speaker: speakerOf(household.id)?.id ?? null };
}

// Who is talking is kept only during a conversation (see family.ts speakerOf).
const SPEAKER_IDLE_MS = 10 * 60_000;
const lastTurnAt = new Map<string, number>();

/** They picked who is talking on the screen: that starts (or continues) a conversation. */
export function noteSpeakerChosen(householdId: string): void {
  lastTurnAt.set(householdId, Date.now());
}

/**
 * News Alexa says by herself (a clinic accepted a booking, or cannot take it). Both brains remember
 * it, so "haan" right after "Shall I find another time?" finds a new doctor for the same person.
 */
export function announce(household: Household, notice: Notice): { speech: string; lang: 'en' | 'hi'; kind: string } {
  const speech = noticeSpeech(household, notice);
  if (notice.kind === 'clinic-rejected') {
    const state = stateOf(household.id);
    state.offer = `${notice.patient.split(' (')[0]} ke liye ${SPECIALTIES[notice.specialty]?.plain ?? 'doctor'}`;
    state.lastKind = 'notice';
  }
  rememberAnnouncement(household.id, speech);
  return { speech, lang: hasHindi(speech) ? 'hi' : 'en', kind: notice.kind };
}
