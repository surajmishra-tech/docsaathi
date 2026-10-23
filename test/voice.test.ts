// Alexa's Polly voice against a pretend Polly server on this computer (no AWS account needed).
import { existsSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const usageFile = join(tmpdir(), `docsaathi-usage-${process.pid}-${Math.random().toString(36).slice(2)}.json`);
const calls: Array<Record<string, unknown>> = [];
let server: Server;
let voice: typeof import('../src/server/voice.js');
const TEXT = `Namaste, test ${Date.now()}`; // unique, so the cache starts empty

beforeAll(async () => {
  server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      calls.push(JSON.parse(raw) as Record<string, unknown>);
      res.setHeader('Content-Type', 'audio/mpeg');
      res.end(Buffer.from('ID3-pretend-mp3'));
    });
  });
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
  Object.assign(process.env, {
    DOCSAATHI_SKIP_ENV_FILE: '1',
    DOCSAATHI_USAGE_FILE: usageFile,
    AWS_ENDPOINT_URL_POLLY: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    AWS_ACCESS_KEY_ID: 'AKIATESTTESTTEST',
    AWS_SECRET_ACCESS_KEY: 'test-secret',
    VOICE: 'polly',
    POLLY_REGION: 'ap-south-1',
    POLLY_DAILY_CHARS: String(TEXT.length + 10),
  });
  voice = await import('../src/server/voice.js');
});

afterAll(async () => {
  const file = resolve('data', 'voice-cache', `${createHash('sha1').update(`Kajal|neural|hi-IN|${TEXT}`).digest('hex')}.mp3`);
  if (existsSync(file)) rmSync(file);
  if (existsSync(usageFile)) rmSync(usageFile);
  await new Promise<void>((ok) => server.close(() => ok()));
});

describe('Polly voice (pretend server)', () => {
  it('asks Polly for Kajal, neural, in Hindi, as MP3', async () => {
    expect(voice.voiceLabel()).toBe('Amazon Polly (Kajal)');
    const audio = await voice.speech(TEXT, 'hi');
    expect(audio.toString()).toBe('ID3-pretend-mp3');
    expect(calls[0]).toMatchObject({ Text: TEXT, VoiceId: 'Kajal', Engine: 'neural', LanguageCode: 'hi-IN', OutputFormat: 'mp3', TextType: 'text' });
  });

  it('says the same answer again from the cache, at no cost', async () => {
    await voice.speech(TEXT, 'hi');
    expect(calls).toHaveLength(1);
  });

  it('stops at the daily character limit (the browser voice speaks instead)', async () => {
    await expect(voice.speech('A different answer that is new', 'en')).rejects.toBeInstanceOf(voice.VoiceUnavailable);
    expect(calls).toHaveLength(1);
  });
});
