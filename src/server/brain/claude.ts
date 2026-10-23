// Claude on Amazon Bedrock, through Anthropic's official SDK. The client talks to Bedrock's "Mantle"
// endpoint (https://bedrock-mantle.{region}.api.aws/anthropic), which serves Anthropic's Messages API.
// It does the same job for the AI brain (ai.ts) that llm.ts does for Groq: one model answer, with
// DocSaathi's tools.
//
// Models are tried in order (BEDROCK_MODELS). When one cannot answer - access not granted yet, busy,
// an error - the next one does. If none can, LlmUnavailable is thrown and Groq or the rule brain
// answers. A daily request limit keeps the AWS bill near zero.
import Anthropic from '@anthropic-ai/sdk';
import { AnthropicBedrockMantle } from '@anthropic-ai/bedrock-sdk';
import { config } from '../config.js';
import { addUse, usedToday } from '../usage.js';
import { LlmUnavailable, type LlmAnswer, type LlmMessage, type LlmTool } from './llm.js';

const TIMEOUT_MS = 15_000;
const LONG_REST_MS = 30 * 60_000; // no access to a model, or not in this region: try it again later
const NETWORK_REST_MS = 3 * 60_000; // Bedrock could not be reached: Groq or the rules answer at once meanwhile

let client: AnthropicBedrockMantle | undefined;
const restingUntil = new Map<string, number>();
// Optional request fields a model turned out not to accept ("effort" on Claude Haiku 4.5, for example).
const notAccepted = new Map<string, Set<'effort' | 'thinking'>>();
const warned = new Set<string>();

/** Bedrock has credentials: an IAM access key (preferred; also works for Polly) or a Bedrock API key. */
export function claudeReady(): boolean {
  const { accessKeyId, secretAccessKey, bedrockApiKey } = config.aws;
  return config.bedrock.models.length > 0 && Boolean((accessKeyId && secretAccessKey) || bedrockApiKey);
}

export function claudeAuth(): string {
  const { accessKeyId, secretAccessKey, bedrockApiKey } = config.aws;
  if (accessKeyId && secretAccessKey) return 'IAM access key';
  return bedrockApiKey ? 'Bedrock API key' : 'none';
}

/** "anthropic.claude-haiku-5-5" -> "Claude Haiku 5.5". */
export function modelName(id: string): string {
  const m = id.replace(/^anthropic\./, '').match(/^claude-([a-z]+)-(\d+)(?:-(\d))?$/);
  return m ? `Claude ${m[1][0].toUpperCase()}${m[1].slice(1)} ${m[2]}${m[3] ? `.${m[3]}` : ''}` : id;
}

function bedrock(): AnthropicBedrockMantle {
  if (client) return client;
  const { region, accessKeyId, secretAccessKey, sessionToken, bedrockApiKey } = config.aws;
  const common = { awsRegion: region, timeout: TIMEOUT_MS, maxRetries: 0 }; // a busy model: the next one answers at once
  client =
    accessKeyId && secretAccessKey
      ? new AnthropicBedrockMantle({ ...common, awsAccessKey: accessKeyId, awsSecretAccessKey: secretAccessKey, awsSessionToken: sessionToken ?? null })
      : new AnthropicBedrockMantle({ ...common, apiKey: bedrockApiKey });
  return client;
}

/** Tool ids must be letters, digits, _ or - (ids made by other providers are cleaned the same way on both sides). */
const toolId = (id: string) => id.replace(/[^a-zA-Z0-9_-]/g, '_');

function parseArgs(json: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(json || '{}');
    return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/**
 * The conversation in Claude's format. Assistant answers that came from Claude go back exactly as
 * they came (`native`); answers from Groq are rebuilt from their text and tool calls. Tool results
 * become tool_result blocks, all results of one answer in one message.
 *
 * Thinking blocks (only with BEDROCK_THINKING=adaptive) are kept for the current turn only: the
 * brain shortens and rewrites older history, and a thinking block is only valid with the exact
 * conversation it was made in.
 */
export function toClaude(history: LlmMessage[], keepThinking: boolean): { system: string; messages: Anthropic.MessageParam[] } {
  const system: string[] = [];
  const messages: Anthropic.MessageParam[] = [];
  let turnStart = -1; // the last thing the person said
  history.forEach((m, i) => {
    if (m.role === 'user') turnStart = i;
  });

  const add = (role: 'user' | 'assistant', blocks: Anthropic.ContentBlockParam[]) => {
    const last = messages.at(-1);
    if (last && last.role === role && Array.isArray(last.content)) last.content.push(...blocks);
    else messages.push({ role, content: blocks });
  };

  history.forEach((m, i) => {
    if (m.role === 'tool') {
      add('user', [{ type: 'tool_result', tool_use_id: toolId(m.tool_call_id), content: m.content }]);
    } else if (m.role !== 'assistant') {
      if (m.role === 'system') system.push(m.content);
      else if (m.content.trim()) add('user', [{ type: 'text', text: m.content }]);
    } else {
      let blocks: Anthropic.ContentBlockParam[];
      if (m.native) {
        const thinkingOk = keepThinking && i > turnStart;
        blocks = (m.native as Anthropic.ContentBlockParam[]).filter((b) => thinkingOk || (b.type !== 'thinking' && b.type !== 'redacted_thinking'));
      } else {
        blocks = [
          ...(m.content ? [{ type: 'text' as const, text: m.content }] : []),
          ...(m.tool_calls ?? []).map((c) => ({ type: 'tool_use' as const, id: toolId(c.id), name: c.function.name, input: parseArgs(c.function.arguments) })),
        ];
      }
      if (blocks.length) add('assistant', blocks);
    }
  });
  // A conversation starts with something the person said.
  while (messages.length && messages[0].role !== 'user') messages.shift();
  return { system: system.join('\n\n'), messages };
}

/** Claude's answer in the shape the AI brain uses (the same shape Groq answers have). */
export function fromClaude(model: string, message: Anthropic.Message): LlmAnswer {
  const native: Anthropic.ContentBlockParam[] = [];
  const texts: string[] = [];
  const toolCalls: LlmAnswer['toolCalls'] = [];
  for (const block of message.content) {
    if (block.type === 'text') {
      texts.push(block.text);
      native.push({ type: 'text', text: block.text });
    } else if (block.type === 'tool_use') {
      const args = block.input && typeof block.input === 'object' ? (block.input as Record<string, unknown>) : {};
      toolCalls.push({ id: block.id, name: block.name, arguments: args });
      native.push({ type: 'tool_use', id: block.id, name: block.name, input: args });
    } else if (block.type === 'thinking') {
      native.push({ type: 'thinking', thinking: block.thinking, signature: block.signature });
    } else if (block.type === 'redacted_thinking') {
      native.push({ type: 'redacted_thinking', data: block.data });
    }
  }
  const text = texts.join(' ').trim();
  return {
    text,
    toolCalls,
    model: `${modelName(model)} (Bedrock)`,
    message: {
      role: 'assistant',
      content: text || null,
      ...(toolCalls.length ? { tool_calls: toolCalls.map((c) => ({ id: c.id, type: 'function' as const, function: { name: c.name, arguments: JSON.stringify(c.arguments) } })) } : {}),
      native,
    },
  };
}

function countRequest(): void {
  if (usedToday().bedrockRequests >= config.bedrock.dailyLimit) {
    throw new LlmUnavailable(`today's Bedrock limit of ${config.bedrock.dailyLimit} requests is used up (BEDROCK_DAILY_LIMIT)`);
  }
  addUse('bedrockRequests', 1);
}

export function bedrockRequestsToday(): number {
  return usedToday().bedrockRequests;
}

function warnOnce(key: string, text: string): void {
  if (warned.has(key)) return;
  warned.add(key);
  console.warn(`[bedrock] ${text}`);
}

/** One request to one model. Optional fields the model does not accept are dropped and it is asked again. */
export async function askModel(model: string, history: LlmMessage[], tools: LlmTool[]): Promise<LlmAnswer> {
  const skip = notAccepted.get(model) ?? new Set<'effort' | 'thinking'>(/claude-haiku-4-5|claude-3/.test(model) ? ['effort'] : []);
  notAccepted.set(model, skip);
  let keepThinking = config.bedrock.thinking === 'adaptive';
  for (let attempt = 0; attempt < 3; attempt++) {
    const { system, messages } = toClaude(history, keepThinking);
    const params: Anthropic.MessageCreateParamsNonStreaming = {
      model,
      max_tokens: config.bedrock.thinking === 'adaptive' ? 4096 : 1024, // spoken replies are short
      // The system prompt and the tools never change, so Bedrock can cache them (faster, cheaper).
      system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
      messages,
      tools: tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters as Anthropic.Tool.InputSchema })),
      tool_choice: { type: 'auto' },
    };
    if (!skip.has('effort')) params.output_config = { effort: config.bedrock.effort };
    if (!skip.has('thinking') && (config.bedrock.thinking === 'off' || !keepThinking)) params.thinking = { type: 'disabled' };

    countRequest();
    try {
      const reply = await bedrock().messages.create(params);
      if (process.env.AI_DEBUG) {
        const u = reply.usage;
        console.log(`[ai] ${model}: ${u.input_tokens} tokens in (+${u.cache_read_input_tokens ?? 0} cached), ${u.output_tokens} out, stop: ${reply.stop_reason}`);
      }
      if (reply.stop_reason === 'refusal') {
        throw new LlmUnavailable(`${modelName(model)} declined to answer (${reply.stop_details?.category ?? 'policy'})`);
      }
      const answer = fromClaude(model, reply);
      if (!answer.text && answer.toolCalls.length === 0) throw new LlmUnavailable(`${modelName(model)} gave an empty answer (${reply.stop_reason})`);
      return answer;
    } catch (err) {
      if (err instanceof Anthropic.BadRequestError) {
        const said = err.message;
        if (/output_config|effort/i.test(said) && !skip.has('effort')) {
          skip.add('effort');
          continue;
        }
        if (/thinking/i.test(said) && keepThinking) {
          keepThinking = false; // a thinking block no longer matches the conversation: ask again without
          continue;
        }
        if (/thinking/i.test(said) && !skip.has('thinking')) {
          skip.add('thinking');
          continue;
        }
      }
      throw err;
    }
  }
  throw new LlmUnavailable(`${modelName(model)} did not accept the request`);
}

/** The AI brain's question to Bedrock: the first model that can answer does. */
export async function claudeChat(history: LlmMessage[], tools: LlmTool[]): Promise<LlmAnswer> {
  if (!claudeReady()) throw new LlmUnavailable('No AWS key configured for Bedrock');
  const problems: string[] = [];
  for (const model of config.bedrock.models) {
    if ((restingUntil.get(model) ?? 0) > Date.now()) {
      problems.push(`${model}: resting`);
      continue;
    }
    try {
      return await askModel(model, history, tools);
    } catch (err) {
      const name = modelName(model);
      if (err instanceof Anthropic.RateLimitError) {
        const seconds = Math.min(Math.max(Number(err.headers?.get('retry-after')) || 20, 2), 600);
        restingUntil.set(model, Date.now() + seconds * 1000);
        problems.push(`${model}: busy, resting ${seconds}s`);
      } else if (err instanceof Anthropic.AuthenticationError) {
        // A wrong key is wrong for every model.
        throw new LlmUnavailable(`AWS did not accept the key (check AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY or AWS_BEARER_TOKEN_BEDROCK): ${err.message}`);
      } else if (err instanceof Anthropic.PermissionDeniedError) {
        restingUntil.set(model, Date.now() + LONG_REST_MS);
        warnOnce(`403 ${model}`, `No access to ${name} yet (${err.message.slice(0, 160)}). Open the AWS console > Amazon Bedrock > Model access, or check the IAM permission bedrock-mantle:CreateInference. The next model answers meanwhile.`);
        problems.push(`${model}: no access`);
      } else if (err instanceof Anthropic.NotFoundError) {
        restingUntil.set(model, Date.now() + LONG_REST_MS);
        warnOnce(`404 ${model}`, `${name} is not available in ${config.aws.region} (${err.message.slice(0, 160)}). Try AWS_REGION=us-east-1. The next model answers meanwhile.`);
        problems.push(`${model}: not in ${config.aws.region}`);
      } else if (err instanceof LlmUnavailable) {
        if (/limit/.test(err.message)) throw err; // the daily limit is for all models
        problems.push(`${model}: ${err.message}`);
      } else if (err instanceof Anthropic.APIConnectionError) {
        // The network, not the model (every model is behind the same address): all of them rest a
        // little, so the next answers do not wait for a time-out again.
        const until = Date.now() + NETWORK_REST_MS;
        for (const m of config.bedrock.models) restingUntil.set(m, until);
        console.warn(`[bedrock] Could not reach Bedrock in ${config.aws.region} (${err.message}). Groq or the rules answer for the next ${NETWORK_REST_MS / 60_000} minutes.`);
        problems.push(`${model}: could not reach Bedrock`);
        break;
      } else if (err instanceof Anthropic.APIError) {
        problems.push(`${model}: HTTP ${err.status ?? 'error'} ${err.message.slice(0, 160)}`);
      } else {
        problems.push(`${model}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }
  throw new LlmUnavailable(problems.join(' | '));
}
