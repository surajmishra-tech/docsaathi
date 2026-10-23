import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

// Load .env once (Node's built-in loader, no dotenv needed). Real env vars win.
const envFile = resolve(process.cwd(), '.env');
if (existsSync(envFile) && !process.env.DOCSAATHI_SKIP_ENV_FILE) {
  process.loadEnvFile(envFile);
}

function num(name: string, fallback: number): number {
  const raw = process.env[name];
  const value = raw ? Number(raw) : NaN;
  return Number.isFinite(value) ? value : fallback;
}

const port = num('PORT', 3000);

export const config = {
  port,
  sandboxPort: num('SANDBOX_PORT', 3001),
  baseUrl: `http://127.0.0.1:${port}`,
  dbFile: process.env.DOCSAATHI_DB ?? resolve(process.cwd(), 'data', 'docsaathi.db'),
  dataDir: resolve(process.cwd(), 'data'),
  // Today's use of the paid Amazon services, for the daily limits (tests point this at a temporary file).
  usageFile: process.env.DOCSAATHI_USAGE_FILE || resolve(process.cwd(), 'data', 'aws-usage.json'),
  home: {
    address: process.env.HOME_ADDRESS ?? 'Shivajinagar, Pune, Maharashtra',
    lat: num('HOME_LAT', 18.5308),
    lng: num('HOME_LNG', 73.8475),
  },
  googleMapsKey: process.env.GOOGLE_MAPS_API_KEY?.trim() || undefined,
  // Extra hostnames allowed to reach the server (e.g. an ngrok address for testing on a phone).
  publicHosts: (process.env.PUBLIC_HOSTS ?? '')
    .split(',')
    .map((h) => h.trim().replace(/^https?:\/\//, '').replace(/\/.*$/, ''))
    .filter(Boolean),
  // The address Alexa+ reaches DocSaathi at (https://...). It is the OAuth issuer and the MCP resource
  // ("<PUBLIC_URL>/mcp", which must match the add-on manifest). Empty = the address of each request.
  publicUrl: process.env.PUBLIC_URL?.trim().replace(/\/+$/, '') || undefined,
  // true = only OAuth tokens open /mcp: the demo family token stops working (use for any public server).
  requireAuth: process.env.REQUIRE_AUTH === 'true',
  // Account linking (OAuth 2.1, see oauth.ts). The Alexa+ add-on's client is registered here, not
  // dynamically (Alexa+ does not support dynamic client registration).
  alexa: {
    clientId: process.env.ALEXA_CLIENT_ID?.trim() || 'docsaathi-alexa',
    clientSecret: process.env.ALEXA_CLIENT_SECRET?.trim() || undefined, // empty = made once, kept in data/
    // Alexa's redirect URIs for this add-on (Alexa+ Developer Hub / `alexa-ai configure-account-linking`).
    redirectUris: (process.env.ALEXA_REDIRECT_URIS ?? '')
      .split(',')
      .map((u) => u.trim())
      .filter(Boolean),
  },
  // The demo family's PIN for linking (with Papa's test mobile number, 00000 11111).
  familyLinkPin: process.env.FAMILY_LINK_PIN?.trim() || '1234',
  uhi: {
    // Empty gateway URL = use the local test network that ships with DocSaathi.
    gatewayUrl: process.env.UHI_GATEWAY_URL?.trim() || undefined,
    subscriberId: process.env.UHI_SUBSCRIBER_ID?.trim() || 'docsaathi-eua',
    callbackBaseUrl: process.env.UHI_CALLBACK_BASE_URL?.trim() || undefined,
  },
  // Who understands what the family says: 'demo' = built-in rules (no key needed),
  // 'groq' = an AI model on Groq, 'bedrock' = Amazon Bedrock.
  brain: (process.env.BRAIN ?? 'demo').trim().toLowerCase() as 'demo' | 'groq' | 'bedrock',
  groq: {
    apiKey: process.env.GROQ_API_KEY?.trim() || undefined,
    baseUrl: process.env.GROQ_BASE_URL?.trim() || 'https://api.groq.com/openai/v1',
    // Tried in this order: the next model takes over when one is busy (rate limit) or fails.
    models: (process.env.GROQ_MODELS?.trim() || 'openai/gpt-oss-120b,qwen/qwen3.8-27b')
      .split(',')
      .map((m) => m.trim())
      .filter(Boolean),
  },
  // Amazon Web Services: one IAM access key works for both Bedrock (the brain) and Polly (the voice).
  // A Bedrock API key (AWS_BEARER_TOKEN_BEDROCK) also works for the brain, but not for Polly.
  aws: {
    region: process.env.AWS_REGION?.trim() || 'ap-south-1',
    accessKeyId: process.env.AWS_ACCESS_KEY_ID?.trim() || undefined,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY?.trim() || undefined,
    sessionToken: process.env.AWS_SESSION_TOKEN?.trim() || undefined,
    bedrockApiKey: process.env.AWS_BEARER_TOKEN_BEDROCK?.trim() || undefined,
  },
  // BRAIN=bedrock: Claude on Amazon Bedrock. Models are tried in this order; when one cannot answer
  // (no access yet, busy, an error) the next one does, then Groq (if it has a key), then the rules.
  bedrock: {
    models: (process.env.BEDROCK_MODELS?.trim() || process.env.BEDROCK_MODEL_ID?.trim() || 'anthropic.claude-haiku-5-5,anthropic.claude-haiku-4-5')
      .split(',')
      .map((m) => m.trim())
      .filter(Boolean),
    // How hard the model thinks: low = quickest replies, right for a voice assistant.
    effort: (process.env.BEDROCK_EFFORT?.trim() || 'low') as 'low' | 'medium' | 'high',
    // off = no thinking step (fastest). adaptive = the model decides when to think (slower, sometimes smarter).
    thinking: process.env.BEDROCK_THINKING?.trim() === 'adaptive' ? ('adaptive' as const) : ('off' as const),
    // Safety for the AWS bill: after this many AI requests in a day, Groq or the rules answer instead.
    dailyLimit: num('BEDROCK_DAILY_LIMIT', 500),
  },
  // Alexa's voice. browser = the computer's own voices (free). polly = Amazon Polly (natural voice; needs an IAM key).
  voice: {
    engine: (process.env.VOICE?.trim().toLowerCase() === 'polly' ? 'polly' : 'browser') as 'browser' | 'polly',
    pollyVoice: process.env.POLLY_VOICE?.trim() || 'Kajal', // speaks Indian English and Hindi
    pollyEngine: process.env.POLLY_ENGINE?.trim() || 'neural',
    pollyRegion: process.env.POLLY_REGION?.trim() || process.env.AWS_REGION?.trim() || 'ap-south-1',
    // Safety for the AWS bill: after this many new characters in a day, the browser voice speaks instead.
    dailyChars: num('POLLY_DAILY_CHARS', 60_000),
  },
};

export type Config = typeof config;
