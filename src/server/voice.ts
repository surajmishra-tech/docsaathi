// Alexa's voice from Amazon Polly (VOICE=polly). The "Kajal" voice speaks Indian English and Hindi.
// The simulator page asks for each answer as an MP3; when Polly is off or fails, the page speaks with
// the browser's own voice instead. Answers already spoken once are kept (data/voice-cache), so a
// repeat costs nothing, and a daily character limit keeps the AWS bill near zero.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PollyClient, SynthesizeSpeechCommand, type Engine, type LanguageCode, type VoiceId } from '@aws-sdk/client-polly';
import { NodeHttpHandler } from '@smithy/node-http-handler';
import { config } from './config.js';
import { addUse, usedToday } from './usage.js';

const MAX_CHARS = 1500; // Alexa's answers are short; a long one is cut here
const REST_MS = 5 * 60_000; // after a failure, the browser voice speaks for a while (answers never wait for Polly)
let client: PollyClient | undefined;
let lastProblem = '';
let restingUntil = 0;

export class VoiceUnavailable extends Error {}

/** Polly needs an IAM access key (a Bedrock API key does not work for Polly). */
export function pollyReady(): boolean {
  return config.voice.engine === 'polly' && Boolean(config.aws.accessKeyId && config.aws.secretAccessKey);
}

export function voiceLabel(): string {
  if (config.voice.engine !== 'polly') return 'browser voice';
  if (!pollyReady()) return 'browser voice (VOICE=polly needs an IAM access key)';
  return `Amazon Polly (${config.voice.pollyVoice})`;
}

/**
 * The Polly client. It uses plain HTTP/1.1: the library's default is HTTP/2 (for a streaming feature
 * DocSaathi does not use), and HTTP/1.1 gets through more networks and proxies.
 */
export function pollyClient(): PollyClient {
  client ??= new PollyClient({
    region: config.voice.pollyRegion,
    credentials: {
      accessKeyId: config.aws.accessKeyId ?? '',
      secretAccessKey: config.aws.secretAccessKey ?? '',
      ...(config.aws.sessionToken ? { sessionToken: config.aws.sessionToken } : {}),
    },
    requestHandler: new NodeHttpHandler({ connectionTimeout: 4000, requestTimeout: 10_000 }),
    maxAttempts: 2,
  });
  return client;
}

export function pollyCharsToday(): number {
  return usedToday().pollyChars;
}

/** The answer as an MP3 in Polly's voice. VoiceUnavailable means: let the browser voice speak it. */
export async function speech(text: string, lang: 'en' | 'hi'): Promise<Buffer> {
  if (!pollyReady()) throw new VoiceUnavailable('Polly is off');
  const said = text.replace(/\s+/g, ' ').trim().slice(0, MAX_CHARS);
  if (!said) throw new VoiceUnavailable('nothing to say');
  const { pollyVoice, pollyEngine } = config.voice;
  const languageCode = lang === 'hi' ? 'hi-IN' : 'en-IN';
  const dir = resolve(config.dataDir, 'voice-cache');
  const file = resolve(dir, `${createHash('sha1').update(`${pollyVoice}|${pollyEngine}|${languageCode}|${said}`).digest('hex')}.mp3`);
  if (existsSync(file)) return readFileSync(file);

  if (restingUntil > Date.now()) throw new VoiceUnavailable(`Polly is resting after: ${lastProblem}`);
  if (usedToday().pollyChars + said.length > config.voice.dailyChars) {
    throw new VoiceUnavailable(`today's Polly limit of ${config.voice.dailyChars} characters is used up (POLLY_DAILY_CHARS)`);
  }

  try {
    const out = await pollyClient().send(
      new SynthesizeSpeechCommand({
        Text: said,
        TextType: 'text',
        VoiceId: pollyVoice as VoiceId,
        Engine: pollyEngine as Engine,
        LanguageCode: languageCode as LanguageCode, // Kajal is bilingual: this picks Hindi or Indian English
        OutputFormat: 'mp3',
      }),
    );
    const bytes = await out.AudioStream?.transformToByteArray();
    if (!bytes?.length) throw new Error('Polly sent no audio');
    addUse('pollyChars', said.length); // Polly bills the characters it spoke
    const audio = Buffer.from(bytes);
    mkdirSync(dir, { recursive: true });
    writeFileSync(file, audio);
    return audio;
  } catch (err) {
    // A network or key problem does not fix itself in a second, so Polly rests: until then each
    // answer gets the browser voice at once instead of waiting for Polly to fail again.
    restingUntil = Date.now() + REST_MS;
    const problem = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    if (problem !== lastProblem) {
      lastProblem = problem;
      console.warn(`[voice] Polly could not speak, the browser voice does for ${REST_MS / 60_000} minutes: ${problem}`);
    }
    throw new VoiceUnavailable(problem);
  }
}
