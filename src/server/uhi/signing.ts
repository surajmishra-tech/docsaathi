// UHI message signing (same scheme as the ABDM UHI gateway):
//   digest  = "BLAKE-512=" + base64(blake2b-512(body))
//   signing string = "(created): <t>\n(expires): <t+ttl>\ndigest: <digest>"
//   signature = base64(ed25519.sign(signing string))
// The Authorization header carries these fields as JSON, e.g.
//   {"keyId":"docsaathi-eua|k1|ed25519","algorithm":"ed25519","created":"..","expires":"..","headers":"(created) (expires) digest","signature":".."}
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify, type KeyObject } from 'node:crypto';

export interface SigningKey {
  subscriberId: string;
  keyId: string;
  privateKey: KeyObject;
  publicKeyB64: string; // raw 32-byte ed25519 public key, base64 (how UHI registries store keys)
}

export interface AuthHeaderFields {
  keyId: string;
  algorithm: string;
  created: string;
  expires: string;
  headers: string;
  signature: string;
}

const SIGNED_HEADERS = '(created) (expires) digest';

export function generateSigningKey(subscriberId: string, keyId = 'k1'): SigningKey {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  return { subscriberId, keyId, privateKey, publicKeyB64: rawPublicKey(publicKey) };
}

/** Save/load keys as PEM so the same identity survives restarts. */
export function exportPrivateKeyPem(key: SigningKey): string {
  return key.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
}

export function importSigningKey(subscriberId: string, keyId: string, privatePem: string): SigningKey {
  const privateKey = createPrivateKey(privatePem);
  return { subscriberId, keyId, privateKey, publicKeyB64: rawPublicKey(createPublicKey(privateKey)) };
}

function rawPublicKey(publicKey: KeyObject): string {
  const jwk = publicKey.export({ format: 'jwk' }) as { x: string };
  return Buffer.from(jwk.x, 'base64url').toString('base64');
}

function publicKeyFromRaw(b64: string): KeyObject {
  return createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: Buffer.from(b64, 'base64').toString('base64url') }, format: 'jwk' });
}

export function digestOf(body: string | Buffer): string {
  return `BLAKE-512=${createHash('blake2b512').update(body).digest('base64')}`;
}

function signingString(created: string, expires: string, digest: string): string {
  return `(created): ${created}\n(expires): ${expires}\ndigest: ${digest}`;
}

export function createAuthHeader(key: SigningKey, body: string, nowSeconds = Math.floor(Date.now() / 1000), ttlSeconds = 60): string {
  const created = String(nowSeconds);
  const expires = String(nowSeconds + ttlSeconds);
  const signature = sign(null, Buffer.from(signingString(created, expires, digestOf(body))), key.privateKey).toString('base64');
  const fields: AuthHeaderFields = {
    keyId: `${key.subscriberId}|${key.keyId}|ed25519`,
    algorithm: 'ed25519',
    created,
    expires,
    headers: SIGNED_HEADERS,
    signature,
  };
  return JSON.stringify(fields);
}

/** Accepts the UHI JSON form and the Beckn `Signature keyId="..",...` form. */
export function parseAuthHeader(header: string | undefined): AuthHeaderFields | null {
  if (!header) return null;
  const text = header.trim();
  try {
    if (text.startsWith('{')) {
      const obj = JSON.parse(text) as Partial<AuthHeaderFields>;
      if (obj.keyId && obj.signature && obj.created && obj.expires) {
        return { algorithm: 'ed25519', headers: SIGNED_HEADERS, ...obj } as AuthHeaderFields;
      }
      return null;
    }
    const fields: Record<string, string> = {};
    for (const m of text.replace(/^Signature\s+/i, '').matchAll(/(\w+)="([^"]*)"/g)) fields[m[1]] = m[2];
    if (fields.keyId && fields.signature && fields.created && fields.expires) return fields as unknown as AuthHeaderFields;
  } catch {
    // fall through
  }
  return null;
}

export type PublicKeyLookup = (subscriberId: string, keyId: string) => string | undefined;

export interface VerifyResult {
  ok: boolean;
  subscriberId?: string;
  reason?: string;
}

export function verifyAuthHeader(
  header: string | undefined,
  body: string | Buffer,
  lookup: PublicKeyLookup,
  nowSeconds = Math.floor(Date.now() / 1000),
  clockSkewSeconds = 30,
): VerifyResult {
  const fields = parseAuthHeader(header);
  if (!fields) return { ok: false, reason: 'missing or malformed Authorization header' };
  const [subscriberId, keyId, algorithm] = fields.keyId.split('|');
  if (!subscriberId || !keyId || (algorithm ?? fields.algorithm) !== 'ed25519') {
    return { ok: false, reason: 'unsupported keyId or algorithm' };
  }
  const created = Number(fields.created);
  const expires = Number(fields.expires);
  if (!Number.isFinite(created) || !Number.isFinite(expires)) return { ok: false, reason: 'bad created/expires' };
  if (created > nowSeconds + clockSkewSeconds) return { ok: false, reason: 'signature created in the future' };
  if (expires < nowSeconds - clockSkewSeconds) return { ok: false, reason: 'signature expired' };
  const publicKeyB64 = lookup(subscriberId, keyId);
  if (!publicKeyB64) return { ok: false, reason: `unknown subscriber ${subscriberId}` };
  const valid = verify(
    null,
    Buffer.from(signingString(fields.created, fields.expires, digestOf(body))),
    publicKeyFromRaw(publicKeyB64),
    Buffer.from(fields.signature, 'base64'),
  );
  return valid ? { ok: true, subscriberId } : { ok: false, subscriberId, reason: 'signature does not match' };
}
