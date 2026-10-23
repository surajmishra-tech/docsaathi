// A small client for AI models that speak the OpenAI "chat completions" format with tools.
// Groq uses this format. Models are tried in order: when one is busy (rate limit) or fails,
// the next one answers. If none can, LlmUnavailable is thrown and the rule-based brain takes over.
import { config } from '../config.js';

export interface LlmTool {
  name: string;
  description: string;
  parameters: Record<string, unknown>; // JSON Schema
}

export interface LlmToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface WireToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

export type LlmMessage =
  | { role: 'system' | 'user'; content: string }
  // `native`: the same answer in the provider's own format (Claude's content blocks), sent back to
  // that provider exactly as it came. Never sent to Groq.
  | { role: 'assistant'; content: string | null; tool_calls?: WireToolCall[]; native?: unknown[] }
  | { role: 'tool'; tool_call_id: string; content: string };

export interface LlmAnswer {
  text: string;
  toolCalls: LlmToolCall[];
  model: string;
  message: Extract<LlmMessage, { role: 'assistant' }>; // as it goes back into the conversation
}

export class LlmUnavailable extends Error {}

const TIMEOUT_MS = 15_000;
// A model that said "too many requests" rests until this time.
const restingUntil = new Map<string, number>();

export function llmReady(): boolean {
  return Boolean(config.groq.apiKey) && config.groq.models.length > 0;
}

const SHORT_WAIT_MS = 3500; // a pause this short is fine in a voice conversation

export async function chat(messages: LlmMessage[], tools: LlmTool[]): Promise<LlmAnswer> {
  if (!llmReady()) throw new LlmUnavailable('No AI key configured');
  let problems: string[] = [];
  for (let round = 0; round < 2; round++) {
    problems = [];
    for (const model of config.groq.models) {
      if ((restingUntil.get(model) ?? 0) > Date.now()) {
        problems.push(`${model}: resting after a rate limit`);
        continue;
      }
      try {
        return await ask(model, messages, tools);
      } catch (err) {
        problems.push(`${model}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    // Every model is resting. If one is free again in a moment, wait for it once.
    const soonest = Math.min(...config.groq.models.map((m) => restingUntil.get(m) ?? Infinity)) - Date.now();
    if (round > 0 || !(soonest > 0 && soonest <= SHORT_WAIT_MS)) break;
    await new Promise((r) => setTimeout(r, soonest + 100));
  }
  throw new LlmUnavailable(problems.join(' | '));
}

async function ask(model: string, messages: LlmMessage[], tools: LlmTool[]): Promise<LlmAnswer> {
  const body: Record<string, unknown> = {
    model,
    messages: messages.map((m) => (m.role === 'assistant' && m.native ? { role: m.role, content: m.content, ...(m.tool_calls ? { tool_calls: m.tool_calls } : {}) } : m)),
    temperature: 0.2,
    max_completion_tokens: 700,
    tools: tools.map((t) => ({ type: 'function', function: t })),
    tool_choice: 'auto',
  };
  // The gpt-oss models think before answering; "low" keeps a voice reply quick.
  if (model.includes('gpt-oss')) body.reasoning_effort = 'low';

  const res = await fetch(`${config.groq.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${config.groq.apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (res.status === 429) {
    const seconds = Math.min(Math.max(Number(res.headers.get('retry-after')) || 20, 2), 600);
    restingUntil.set(model, Date.now() + seconds * 1000);
    throw new Error(`rate limit, resting ${Math.round(seconds)}s`);
  }
  const json = (await res.json().catch(() => null)) as {
    choices?: Array<{ message?: { content?: string | null; tool_calls?: WireToolCall[] } }>;
    usage?: { prompt_tokens?: number; completion_tokens?: number; prompt_tokens_details?: { cached_tokens?: number } };
    error?: { message?: string };
  } | null;
  if (!res.ok || !json?.choices?.[0]?.message) throw new Error(`HTTP ${res.status} ${json?.error?.message ?? ''}`.trim().slice(0, 200));
  if (process.env.AI_DEBUG) {
    const u = json.usage;
    console.log(`[ai] ${model}: ${u?.prompt_tokens} tokens in (${u?.prompt_tokens_details?.cached_tokens ?? 0} cached), ${u?.completion_tokens} out; ${res.headers.get('x-ratelimit-remaining-tokens')} left this minute`);
  }

  const msg = json.choices[0].message;
  const text = (msg.content ?? '').replace(/<think>[\s\S]*?<\/think>/g, '').trim();
  const wire = (msg.tool_calls ?? []).filter((c) => c?.function?.name);
  const toolCalls = wire.map((c) => {
    let args: unknown;
    try {
      args = JSON.parse(c.function.arguments || '{}');
    } catch {
      throw new Error('the model wrote tool arguments that are not valid JSON');
    }
    return { id: c.id, name: c.function.name, arguments: (args && typeof args === 'object' ? args : {}) as Record<string, unknown> };
  });
  return {
    text,
    toolCalls,
    model,
    message: { role: 'assistant', content: text || null, ...(wire.length ? { tool_calls: wire.map((c) => ({ id: c.id, type: 'function' as const, function: c.function })) } : {}) },
  };
}
