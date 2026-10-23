// The Bedrock brain against a pretend Bedrock server on this computer (no AWS account needed):
// what is sent, and how "no access", the next model and the daily limit work.
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const usageFile = join(tmpdir(), `docsaathi-usage-${process.pid}-${Math.random().toString(36).slice(2)}.json`);
type Seen = { model: string; body: Record<string, unknown>; headers: Record<string, string | string[] | undefined> };
const seen: Seen[] = [];
let server: Server;
let claude: typeof import('../src/server/brain/claude.js');
let llm: typeof import('../src/server/brain/llm.js');

beforeAll(async () => {
  server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const body = JSON.parse(raw) as Record<string, unknown>;
      const model = String(body.model);
      seen.push({ model, body, headers: req.headers });
      res.setHeader('Content-Type', 'application/json');
      if (model === 'anthropic.claude-haiku-5-5') {
        res.statusCode = 403;
        res.end(JSON.stringify({ type: 'error', error: { type: 'permission_error', message: "You don't have access to the model with the specified model ID." } }));
        return;
      }
      res.end(
        JSON.stringify({
          id: 'msg_test',
          type: 'message',
          role: 'assistant',
          model,
          stop_reason: 'tool_use',
          stop_sequence: null,
          usage: { input_tokens: 120, output_tokens: 20 },
          content: [{ type: 'tool_use', id: 'toolu_01', name: 'find_doctors', input: { need: 'dentist', patient: 'Papa' } }],
        }),
      );
    });
  });
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
  Object.assign(process.env, {
    DOCSAATHI_SKIP_ENV_FILE: '1',
    DOCSAATHI_USAGE_FILE: usageFile,
    ANTHROPIC_BEDROCK_MANTLE_BASE_URL: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    AWS_REGION: 'us-east-1',
    AWS_BEARER_TOKEN_BEDROCK: 'test-bedrock-key',
    AWS_ACCESS_KEY_ID: '',
    AWS_SECRET_ACCESS_KEY: '',
    BEDROCK_MODELS: 'anthropic.claude-haiku-5-5,anthropic.claude-haiku-4-5',
    BEDROCK_DAILY_LIMIT: '4',
  });
  claude = await import('../src/server/brain/claude.js');
  llm = await import('../src/server/brain/llm.js');
});

afterAll(async () => {
  if (existsSync(usageFile)) rmSync(usageFile);
  await new Promise<void>((ok) => server.close(() => ok()));
});

const history = [
  { role: 'system' as const, content: 'You are Alexa.' },
  { role: 'user' as const, content: 'Papa ke daant mein dard hai' },
];
const tools = [{ name: 'find_doctors', description: 'Find doctors.', parameters: { type: 'object', properties: { need: { type: 'string' } }, required: ['need'] } }];

describe('Claude on Bedrock (pretend server)', () => {
  it('asks Haiku 5.5 first, and Haiku 4.5 answers when 5.5 has no access', async () => {
    expect(claude.claudeReady()).toBe(true);
    expect(claude.claudeAuth()).toBe('Bedrock API key');
    const answer = await claude.claudeChat(history, tools);
    expect(answer.model).toBe('Claude Haiku 4.5 (Bedrock)');
    expect(answer.toolCalls).toEqual([{ id: 'toolu_01', name: 'find_doctors', arguments: { need: 'dentist', patient: 'Papa' } }]);
    expect(seen.map((s) => s.model)).toEqual(['anthropic.claude-haiku-5-5', 'anthropic.claude-haiku-4-5']);
  });

  it('sends the right request: quick thinking settings, cached system prompt, tools', () => {
    const [first, second] = seen;
    expect(first.body.output_config).toEqual({ effort: 'low' });
    expect(first.body.thinking).toEqual({ type: 'disabled' });
    expect(first.body.system).toEqual([{ type: 'text', text: 'You are Alexa.', cache_control: { type: 'ephemeral' } }]);
    expect(first.body.messages).toEqual([{ role: 'user', content: [{ type: 'text', text: 'Papa ke daant mein dard hai' }] }]);
    expect(first.body.tools).toEqual([{ name: 'find_doctors', description: 'Find doctors.', input_schema: tools[0].parameters }]);
    expect('temperature' in first.body).toBe(false);
    // Claude Haiku 4.5 has no "effort" setting: not sent to it.
    expect('output_config' in second.body).toBe(false);
    // The Bedrock API key goes with every request.
    expect(JSON.stringify(first.headers)).toContain('test-bedrock-key');
  });

  it('lets a model without access rest, so the next turn goes straight to the one that works', async () => {
    seen.length = 0;
    await claude.claudeChat(history, tools);
    expect(seen.map((s) => s.model)).toEqual(['anthropic.claude-haiku-4-5']);
  });

  it('stops at the daily limit, so Groq or the rules answer instead', async () => {
    await claude.claudeChat(history, tools); // the 4th request of the day
    await expect(claude.claudeChat(history, tools)).rejects.toBeInstanceOf(llm.LlmUnavailable);
    await expect(claude.claudeChat(history, tools)).rejects.toThrow(/limit/);
    expect(claude.bedrockRequestsToday()).toBe(4);
    // The count is kept in a file, so restarting DocSaathi does not reset the limit.
    expect(JSON.parse(readFileSync(usageFile, 'utf8'))).toMatchObject({ day: new Date().toISOString().slice(0, 10), bedrockRequests: 4 });
  });
});
