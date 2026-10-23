import { describe, expect, it } from 'vitest';
import type Anthropic from '@anthropic-ai/sdk';
import { fromClaude, modelName, toClaude } from '../src/server/brain/claude.js';
import type { LlmMessage } from '../src/server/brain/llm.js';

describe('Bedrock model names', () => {
  it.each([
    ['anthropic.claude-haiku-5-5', 'Claude Haiku 5.5'],
    ['anthropic.claude-haiku-4-5', 'Claude Haiku 4.5'],
    ['anthropic.claude-opus-5', 'Claude Opus 5'],
    ['something-else', 'something-else'],
  ])('%s -> %s', (id, name) => expect(modelName(id)).toBe(name));
});

describe('the conversation in Claude format', () => {
  const groqTurn: LlmMessage[] = [
    { role: 'system', content: 'You are Alexa.' },
    { role: 'assistant', content: 'stray answer before anything was said' },
    { role: 'user', content: 'Papa ke liye dentist' },
    {
      role: 'assistant',
      content: null,
      tool_calls: [
        { id: 'call.1', type: 'function', function: { name: 'find_doctors', arguments: '{"need":"dentist","patient":"Papa"}' } },
        { id: 'call_2', type: 'function', function: { name: 'family_members', arguments: 'not json' } },
      ],
    },
    { role: 'tool', tool_call_id: 'call.1', content: '[doctors] Done.' },
    { role: 'tool', tool_call_id: 'call_2', content: 'Skipped.' },
    { role: 'assistant', content: 'I found 3 dentists.' },
  ];

  it('keeps the system prompt apart and starts with what the person said', () => {
    const { system, messages } = toClaude(groqTurn, false);
    expect(system).toBe('You are Alexa.');
    expect(messages[0]).toEqual({ role: 'user', content: [{ type: 'text', text: 'Papa ke liye dentist' }] });
  });

  it('turns tool calls into tool_use blocks and puts all results in one message', () => {
    const { messages } = toClaude(groqTurn, false);
    expect(messages[1]).toEqual({
      role: 'assistant',
      content: [
        { type: 'tool_use', id: 'call_1', name: 'find_doctors', input: { need: 'dentist', patient: 'Papa' } },
        { type: 'tool_use', id: 'call_2', name: 'family_members', input: {} },
      ],
    });
    expect(messages[2]).toEqual({
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: 'call_1', content: '[doctors] Done.' },
        { type: 'tool_result', tool_use_id: 'call_2', content: 'Skipped.' },
      ],
    });
    expect(messages[3]).toEqual({ role: 'assistant', content: [{ type: 'text', text: 'I found 3 dentists.' }] });
    expect(messages).toHaveLength(4);
  });

  it("sends Claude's own answers back as they came, thinking only within the current turn", () => {
    const thinking = { type: 'thinking' as const, thinking: '', signature: 'sig' };
    const history: LlmMessage[] = [
      { role: 'user', content: 'earlier question' },
      { role: 'assistant', content: 'earlier answer', native: [thinking, { type: 'text', text: 'earlier answer' }] },
      { role: 'user', content: 'dentist for Papa' },
      { role: 'assistant', content: null, native: [thinking, { type: 'tool_use', id: 'toolu_1', name: 'find_doctors', input: { need: 'dentist' } }] },
      { role: 'tool', tool_call_id: 'toolu_1', content: 'Done.' },
    ];
    const kept = toClaude(history, true).messages;
    expect(kept[1].content).toEqual([{ type: 'text', text: 'earlier answer' }]); // older turn: no thinking
    expect((kept[3].content as Anthropic.ContentBlockParam[])[0]).toEqual(thinking); // current turn: kept
    const stripped = toClaude(history, false).messages;
    expect((stripped[3].content as Anthropic.ContentBlockParam[]).map((b) => b.type)).toEqual(['tool_use']);
  });
});

describe("Claude's answer in the brain's format", () => {
  it('collects text, tool calls and the original blocks', () => {
    const reply = {
      id: 'msg_1',
      type: 'message',
      role: 'assistant',
      model: 'anthropic.claude-haiku-5-5',
      stop_reason: 'tool_use',
      stop_sequence: null,
      stop_details: null,
      usage: { input_tokens: 10, output_tokens: 5 },
      content: [
        { type: 'text', text: 'Let me look.', citations: null },
        { type: 'tool_use', id: 'toolu_9', name: 'find_doctors', input: { need: 'dentist' } },
      ],
    } as unknown as Anthropic.Message;
    const answer = fromClaude('anthropic.claude-haiku-5-5', reply);
    expect(answer.text).toBe('Let me look.');
    expect(answer.model).toBe('Claude Haiku 5.5 (Bedrock)');
    expect(answer.toolCalls).toEqual([{ id: 'toolu_9', name: 'find_doctors', arguments: { need: 'dentist' } }]);
    expect(answer.message.tool_calls).toEqual([{ id: 'toolu_9', type: 'function', function: { name: 'find_doctors', arguments: '{"need":"dentist"}' } }]);
    expect(answer.message.native).toEqual([
      { type: 'text', text: 'Let me look.' },
      { type: 'tool_use', id: 'toolu_9', name: 'find_doctors', input: { need: 'dentist' } },
    ]);
  });
});
