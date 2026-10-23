// Which AI model understands the family: Claude on Amazon Bedrock (BRAIN=bedrock) or Groq (BRAIN=groq).
// With BRAIN=bedrock, Groq (if it has a key) answers when Bedrock cannot. The rule brain stays the
// last safety net (ai.ts), so Alexa always answers.
import { config } from '../config.js';
import { claudeChat, claudeReady, modelName } from './claude.js';
import { chat as groqChat, llmReady, LlmUnavailable, type LlmAnswer, type LlmMessage, type LlmTool } from './llm.js';

/** Is an AI model available for the chosen BRAIN? Otherwise the built-in rules do the understanding. */
export function aiReady(): boolean {
  if (config.brain === 'groq') return llmReady();
  if (config.brain === 'bedrock') return claudeReady() || llmReady();
  return false;
}

/** Shown in the simulator's status bar and in the server's start-up lines. */
export function aiLabel(): string {
  const groq = `Groq AI (${config.groq.models[0]?.split('/').pop() ?? 'no model'})`;
  if (config.brain === 'bedrock') {
    if (claudeReady()) return `Amazon Bedrock (${modelName(config.bedrock.models[0])})${llmReady() ? ' + Groq backup' : ''}`;
    return llmReady() ? `${groq}, Bedrock has no AWS key yet` : 'demo rules';
  }
  return config.brain === 'groq' && llmReady() ? groq : 'demo rules';
}

export async function chat(messages: LlmMessage[], tools: LlmTool[]): Promise<LlmAnswer> {
  if (config.brain === 'bedrock' && claudeReady()) {
    try {
      return await claudeChat(messages, tools);
    } catch (err) {
      if (!(err instanceof LlmUnavailable) || !llmReady()) throw err;
      console.warn(`[ai] Bedrock could not answer, Groq does: ${err.message}`);
    }
  }
  return groqChat(messages, tools);
}
