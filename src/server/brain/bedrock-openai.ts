// Open-weight models (openai.gpt-oss-120b) on Amazon Bedrock, through Bedrock's OpenAI-compatible endpoint
// (https://bedrock-mantle.{region}.api.aws/v1/chat/completions). Requests are signed with the IAM key
// (SigV4, service "bedrock-mantle"), the same key and permission (bedrock-mantle:CreateInference) as Claude.
// This is the Bedrock brain on accounts where Anthropic's models are "not available for this account".
import { Sha256 } from '@aws-crypto/sha256-js';
import { SignatureV4 } from '@smithy/signature-v4';
import { config } from '../config.js';
import { addUse, usedToday } from '../usage.js';
import { chatWith, LlmUnavailable, type LlmAnswer, type LlmMessage, type LlmTool, type Provider } from './llm.js';

const TIMEOUT_MS = 15_000;

export function bedrockOpenAiReady(): boolean {
  return config.bedrock.openaiModels.length > 0 && Boolean(config.aws.accessKeyId && config.aws.secretAccessKey);
}

let signer: SignatureV4 | undefined;

const bedrock: Provider = {
  get models() {
    return config.bedrock.openaiModels;
  },
  async send(body) {
    const { region, accessKeyId, secretAccessKey, sessionToken } = config.aws;
    signer ??= new SignatureV4({
      service: 'bedrock-mantle',
      region,
      sha256: Sha256,
      credentials: { accessKeyId: accessKeyId!, secretAccessKey: secretAccessKey!, ...(sessionToken ? { sessionToken } : {}) },
    });
    const host = `bedrock-mantle.${region}.api.aws`;
    const path = '/v1/chat/completions';
    const signed = await signer.sign({ method: 'POST', protocol: 'https:', hostname: host, path, headers: { host, 'content-type': 'application/json' }, body });
    return fetch(`https://${host}${path}`, { method: 'POST', headers: signed.headers as Record<string, string>, body, signal: AbortSignal.timeout(TIMEOUT_MS) });
  },
};

/** Sends one signed chat request (used by `npm run check:aws`). */
export const bedrockSend = (body: string) => bedrock.send(body);

/** One answer from gpt-oss on Bedrock, counted against the same daily Bedrock limit as Claude. */
export async function bedrockOpenAiChat(messages: LlmMessage[], tools: LlmTool[]): Promise<LlmAnswer> {
  if (usedToday().bedrockRequests >= config.bedrock.dailyLimit) throw new LlmUnavailable('the daily Bedrock limit is reached');
  const answer = await chatWith(bedrock, messages, tools);
  addUse('bedrockRequests', 1);
  return answer;
}
