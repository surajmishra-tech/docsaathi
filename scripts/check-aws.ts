// Checks the Amazon setup in plain words: the keys in .env, each Claude model on Bedrock (one real
// question with a tool call), and the Polly voice (one short sentence, saved as data/polly-check.mp3).
// Usage: npm run check:aws   (a few tiny requests: well under one US cent)
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import Anthropic from '@anthropic-ai/sdk';
import { DescribeVoicesCommand, SynthesizeSpeechCommand, type Engine, type VoiceId } from '@aws-sdk/client-polly';
import { config } from '../src/server/config.js';
import { askModel, modelName } from '../src/server/brain/claude.js';
import { bedrockSend } from '../src/server/brain/bedrock-openai.js';
import { chatWith, type LlmTool } from '../src/server/brain/llm.js';
import { pollyClient } from '../src/server/voice.js';

const good = (text: string) => console.log(`  ✅ ${text}`);
const bad = (text: string) => console.log(`  ❌ ${text}`);
const tip = (text: string) => console.log(`     -> ${text}`);
const NETWORK_TIP = 'Network problem. If your home internet blocks some AWS servers, connect the PC to your phone hotspot and run this again.';

let brainOk = false;
let voiceOk = false;
const { region, accessKeyId, secretAccessKey, bedrockApiKey } = config.aws;
const iam = Boolean(accessKeyId && secretAccessKey);

console.log('\nDocSaathi - Amazon check\n');
console.log(`Region: ${region}${config.voice.pollyRegion !== region ? ` (Polly: ${config.voice.pollyRegion})` : ''}\n`);

// 1. Keys ------------------------------------------------------------------------------------------
console.log('1. Keys in .env');
if (iam) good('IAM access key found (works for Bedrock and Polly)');
else if (bedrockApiKey) {
  good('Bedrock API key found (works for the brain only)');
  tip('For the Polly voice, also add an IAM access key (AWS_ACCESS_KEY_ID + AWS_SECRET_ACCESS_KEY).');
} else {
  bad('No AWS key found.');
  tip('Paste AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY into .env (see docs/AWS_SETUP.md), then run this again.');
  process.exit(1);
}

// 2. Bedrock ---------------------------------------------------------------------------------------
console.log('\n2. Amazon Bedrock (the brain)');
const findDoctors: LlmTool = {
  name: 'find_doctors',
  description: 'Find doctors with free times for a problem or a kind of doctor.',
  parameters: { type: 'object', properties: { need: { type: 'string' }, patient: { type: 'string' } }, required: ['need'] },
};
for (const model of config.bedrock.models) {
  const name = modelName(model);
  const started = Date.now();
  try {
    const answer = await askModel(
      model,
      [
        { role: 'system', content: 'You are Alexa helping an Indian family book doctors. When they need a doctor, call find_doctors.' },
        { role: 'user', content: 'Papa ke daant mein bahut dard hai, dentist dhoondo' },
      ],
      [findDoctors],
    );
    const ms = Date.now() - started;
    const call = answer.toolCalls[0];
    if (call?.name === 'find_doctors') good(`${name}: works (${ms} ms). It called find_doctors(${JSON.stringify(call.arguments)})`);
    else good(`${name}: answers (${ms} ms), but did not call the tool this time: "${answer.text.slice(0, 90)}"`);
    brainOk = true;
  } catch (err) {
    if (err instanceof Anthropic.AuthenticationError) {
      bad(`${name}: AWS did not accept the key.`);
      tip('Copy the key again from the AWS console (no spaces), save .env, run this again.');
    } else if (err instanceof Anthropic.PermissionDeniedError) {
      bad(`${name}: no access yet.`);
      tip('AWS console > Amazon Bedrock > Model access: request access to this Anthropic model (it can take a few minutes).');
      tip('Also check the IAM user has permission bedrock-mantle:CreateInference (see docs/AWS_SETUP.md).');
    } else if (err instanceof Anthropic.NotFoundError) {
      bad(`${name}: not available in ${region}.`);
      tip('Try AWS_REGION=us-east-1 in .env.');
    } else if (err instanceof Anthropic.RateLimitError) {
      bad(`${name}: AWS says "too many requests" (new accounts start with low limits). Wait a minute and try again.`);
    } else if (err instanceof Anthropic.APIConnectionError) {
      bad(`${name}: could not reach Bedrock.`);
      tip(NETWORK_TIP);
    } else {
      bad(`${name}: ${err instanceof Error ? err.message.slice(0, 200) : String(err)}`);
    }
  }
}
// Open-weight models on Bedrock's OpenAI-compatible endpoint (the brain when Claude is not open to the account)
for (const model of config.bedrock.openaiModels) {
  const started = Date.now();
  try {
    const answer = await chatWith(
      { models: [model], send: (body) => bedrockSend(body) },
      [
        { role: 'system', content: 'You are Alexa helping an Indian family book doctors. When they need a doctor, call find_doctors.' },
        { role: 'user', content: 'Papa ke daant mein bahut dard hai, dentist dhoondo' },
      ],
      [findDoctors],
    );
    const call = answer.toolCalls[0];
    const ms = Date.now() - started;
    if (call?.name === 'find_doctors') good(`${model} on Bedrock: works (${ms} ms). It called find_doctors(${JSON.stringify(call.arguments)})`);
    else good(`${model} on Bedrock: answers (${ms} ms), but did not call the tool this time: "${answer.text.slice(0, 90)}"`);
    brainOk = true;
  } catch (err) {
    bad(`${model} on Bedrock: ${err instanceof Error ? err.message.slice(0, 220) : String(err)}`);
  }
}
if (brainOk) tip('At least one model works, so BRAIN=bedrock is ready. (Models that failed are skipped automatically.)');

// 3. Polly -----------------------------------------------------------------------------------------
console.log('\n3. Amazon Polly (the voice)');
if (!iam) {
  bad('Skipped: Polly needs an IAM access key.');
} else {
  const polly = pollyClient();
  try {
    // Kajal's first language is Indian English and Hindi is her second, so ask for bilingual voices too.
    const { Voices = [] } = await polly.send(new DescribeVoicesCommand({ LanguageCode: 'hi-IN', IncludeAdditionalLanguageCodes: true }));
    const kajal = Voices.find((v) => v.Id === config.voice.pollyVoice);
    if (!kajal) {
      bad(`The voice "${config.voice.pollyVoice}" is not offered in ${config.voice.pollyRegion}. Hindi voices there: ${Voices.map((v) => v.Id).join(', ') || 'none'}.`);
      tip('Try POLLY_REGION=us-east-1 in .env.');
    } else if (!kajal.SupportedEngines?.includes(config.voice.pollyEngine as Engine)) {
      bad(`${kajal.Id} has no "${config.voice.pollyEngine}" engine here (it has: ${kajal.SupportedEngines?.join(', ')}).`);
      tip(`Set POLLY_ENGINE=${kajal.SupportedEngines?.[0] ?? 'standard'} in .env.`);
    } else {
      const out = await polly.send(
        new SynthesizeSpeechCommand({
          Text: 'नमस्ते! मैं Alexa हूँ। Dr. Mehta कल सुबह दस बजे आपको देख सकते हैं।',
          TextType: 'text',
          VoiceId: config.voice.pollyVoice as VoiceId,
          Engine: config.voice.pollyEngine as Engine,
          LanguageCode: 'hi-IN',
          OutputFormat: 'mp3',
        }),
      );
      const bytes = await out.AudioStream?.transformToByteArray();
      if (!bytes?.length) throw new Error('Polly sent no audio');
      const file = resolve(config.dataDir, 'polly-check.mp3');
      writeFileSync(file, bytes);
      good(`${kajal.Id} speaks Hindi (${Math.round(bytes.length / 1024)} KB). Play it: ${file}`);
      voiceOk = true;
    }
  } catch (err) {
    const name = err instanceof Error ? err.name : '';
    if (/AccessDenied|UnrecognizedClient|InvalidSignature|SignatureDoesNotMatch/i.test(name)) {
      bad(`Polly did not accept the key (${name}).`);
      tip('Give the IAM user the permissions polly:SynthesizeSpeech and polly:DescribeVoices (see docs/AWS_SETUP.md).');
    } else if (/ENOTFOUND|ETIMEDOUT|ECONNRESET|TimeoutError|NetworkingError/i.test(`${name} ${err instanceof Error ? err.message : ''}`)) {
      bad('Could not reach Polly.');
      tip(NETWORK_TIP);
    } else {
      bad(`Polly: ${err instanceof Error ? `${name}: ${err.message.slice(0, 200)}` : String(err)}`);
    }
  }
}

// 4. What to do next -----------------------------------------------------------------------------
console.log('\nNext');
if (brainOk) tip(`In .env set BRAIN=bedrock${config.brain === 'bedrock' ? ' (already set)' : ''}.`);
if (voiceOk) tip(`In .env set VOICE=polly${config.voice.engine === 'polly' ? ' (already set)' : ''}.`);
if (brainOk || voiceOk) tip('Then restart DocSaathi (npm start) and open http://localhost:3000/alexa - the status bar shows Brain and Voice.');
if (brainOk) tip('Optional: npm run eval:bedrock  (33 test sentences, a few US cents; accuracy report in docs/eval-bedrock.md)');
console.log('');
process.exit(brainOk || voiceOk ? 0 : 1);
