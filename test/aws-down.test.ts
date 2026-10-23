// When AWS cannot be reached or says no, answers must not wait for it: Bedrock and Polly rest a few
// minutes, and meanwhile Groq / the rules and the browser voice answer at once.
// Pretend servers on this computer: "Bedrock" drops every connection, "Polly" says access denied.
import { existsSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const usageFile = join(tmpdir(), `docsaathi-usage-${process.pid}-${Math.random().toString(36).slice(2)}.json`);
let bedrockServer: Server;
let pollyServer: Server;
let bedrockCalls = 0;
let pollyCalls = 0;
let claude: typeof import('../src/server/brain/claude.js');
let llm: typeof import('../src/server/brain/llm.js');
let voice: typeof import('../src/server/voice.js');

const listen = async (server: Server) => {
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
};

beforeAll(async () => {
  bedrockServer = createServer((req) => {
    bedrockCalls++;
    req.socket.destroy(); // like a network that blocks AWS
  });
  pollyServer = createServer((req, res) => {
    pollyCalls++;
    req.resume();
    res.statusCode = 403;
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('x-amzn-ErrorType', 'AccessDeniedException');
    res.end(JSON.stringify({ message: 'User is not authorized to perform: polly:SynthesizeSpeech' }));
  });
  Object.assign(process.env, {
    DOCSAATHI_SKIP_ENV_FILE: '1',
    DOCSAATHI_USAGE_FILE: usageFile,
    ANTHROPIC_BEDROCK_MANTLE_BASE_URL: await listen(bedrockServer),
    AWS_ENDPOINT_URL_POLLY: await listen(pollyServer),
    AWS_REGION: 'ap-south-1',
    AWS_ACCESS_KEY_ID: 'AKIATESTTESTTEST',
    AWS_SECRET_ACCESS_KEY: 'test-secret',
    AWS_BEARER_TOKEN_BEDROCK: '',
    BEDROCK_MODELS: 'anthropic.claude-haiku-5-5,anthropic.claude-haiku-4-5',
    VOICE: 'polly',
    POLLY_REGION: 'ap-south-1',
  });
  claude = await import('../src/server/brain/claude.js');
  llm = await import('../src/server/brain/llm.js');
  voice = await import('../src/server/voice.js');
});

afterAll(async () => {
  if (existsSync(usageFile)) rmSync(usageFile);
  await new Promise<void>((ok) => bedrockServer.close(() => ok()));
  await new Promise<void>((ok) => pollyServer.close(() => ok()));
});

const history = [
  { role: 'system' as const, content: 'You are Alexa.' },
  { role: 'user' as const, content: 'Papa ke daant mein dard hai' },
];

describe('Bedrock cannot be reached', () => {
  it('gives up after one try (the next model is behind the same blocked address)', async () => {
    await expect(claude.claudeChat(history, [])).rejects.toBeInstanceOf(llm.LlmUnavailable);
    expect(bedrockCalls).toBe(1);
  });

  it('then rests, so the next answers go to Groq or the rules without waiting', async () => {
    const started = Date.now();
    await expect(claude.claudeChat(history, [])).rejects.toThrow(/resting/);
    expect(Date.now() - started).toBeLessThan(50);
    expect(bedrockCalls).toBe(1);
    expect(claude.bedrockRequestsToday()).toBe(1);
  });
});

describe('Polly says no', () => {
  it('the browser voice speaks, and Polly rests instead of being asked for every answer', async () => {
    await expect(voice.speech(`Namaste ${Date.now()}`, 'hi')).rejects.toBeInstanceOf(voice.VoiceUnavailable);
    const asked = pollyCalls;
    expect(asked).toBeGreaterThan(0);
    await expect(voice.speech(`Another answer ${Date.now()}`, 'en')).rejects.toThrow(/resting/);
    expect(pollyCalls).toBe(asked);
    expect(voice.pollyCharsToday()).toBe(0); // nothing spoken, nothing counted
  });
});
