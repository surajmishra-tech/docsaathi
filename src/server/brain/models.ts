// Which AI model understands the family: Amazon Bedrock (BRAIN=bedrock) or Groq (BRAIN=groq).
// With BRAIN=bedrock the order is Claude, then gpt-oss on Bedrock (bedrock-openai.ts), then Groq (if it
// has a key). The rule brain stays the last safety net (ai.ts), so Alexa always answers.
import { config } from '../config.js';
import { bedrockOpenAiChat, bedrockOpenAiReady } from './bedrock-openai.js';
import { claudeChat, claudeReady, modelName } from './claude.js';
import { chat as groqChat, llmReady, LlmUnavailable, type LlmAnswer, type LlmMessage, type LlmTool } from './llm.js';

/** Is an AI model available for the chosen BRAIN? Otherwise the built-in rules do the understanding. */
export function aiReady(): boolean {
  if (config.brain === 'groq') return llmReady();
  if (config.brain === 'bedrock') return claudeReady() || bedrockOpenAiReady() || llmReady();
  return false;
}

/** Shown in the simulator's status bar and in the server's start-up lines. */
export function aiLabel(): string {
  const groq = `Groq AI (${config.groq.models[0]?.split('/').pop() ?? 'no model'})`;
  if (config.brain === 'bedrock') {
    if (claudeReady()) return `Amazon Bedrock (${modelName(config.bedrock.models[0])})${llmReady() ? ' + Groq backup' : ''}`;
    if (bedrockOpenAiReady()) return `Amazon Bedrock (${config.bedrock.openaiModels[0].replace(/^openai\./, '')})${llmReady() ? ' + Groq backup' : ''}`;
    return llmReady() ? `${groq}, Bedrock has no AWS key yet` : 'demo rules';
  }
  return config.brain === 'groq' && llmReady() ? groq : 'demo rules';
}

export async function chat(messages: LlmMessage[], tools: LlmTool[]): Promise<LlmAnswer> {
  if (config.brain === 'bedrock' && claudeReady()) {
    try {
      return await claudeChat(messages, tools);
    } catch (err) {
      if (!(err instanceof LlmUnavailable) || !(bedrockOpenAiReady() || llmReady())) throw err;
      console.warn(`[ai] Claude on Bedrock could not answer, the next model does: ${err.message}`);
    }
  }
  if (config.brain === 'bedrock' && bedrockOpenAiReady()) {
    try {
      return await bedrockOpenAiChat(messages, tools);
    } catch (err) {
      if (!(err instanceof LlmUnavailable) || !llmReady()) throw err;
      console.warn(`[ai] gpt-oss on Bedrock could not answer, Groq does: ${err.message}`);
    }
  }
  return groqChat(messages, tools);
}
