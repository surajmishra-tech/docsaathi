import { describe, expect, it } from 'vitest';
import { createAuthHeader, generateSigningKey, verifyAuthHeader } from '../src/server/uhi/signing.js';

describe('UHI message signatures (ed25519 + BLAKE-512 digest)', () => {
  const key = generateSigningKey('docsaathi-eua', 'k1');
  const lookup = (id: string, kid: string) => (id === 'docsaathi-eua' && kid === 'k1' ? key.publicKeyB64 : undefined);
  const body = JSON.stringify({ context: { action: 'search' }, message: { intent: {} } });
  const now = 1_790_000_000;

  it('accepts a correctly signed body', () => {
    const header = createAuthHeader(key, body, now);
    expect(verifyAuthHeader(header, body, lookup, now)).toMatchObject({ ok: true, subscriberId: 'docsaathi-eua' });
  });

  it('rejects a changed body', () => {
    const header = createAuthHeader(key, body, now);
    expect(verifyAuthHeader(header, body.replace('search', 'confirm'), lookup, now).ok).toBe(false);
  });

  it('rejects an expired signature', () => {
    const header = createAuthHeader(key, body, now, 60);
    expect(verifyAuthHeader(header, body, lookup, now + 600)).toMatchObject({ ok: false, reason: 'signature expired' });
  });

  it('rejects an unknown sender', () => {
    const other = generateSigningKey('someone-else', 'k1');
    expect(verifyAuthHeader(createAuthHeader(other, body, now), body, lookup, now).ok).toBe(false);
  });

  it('accepts the Beckn "Signature keyId=..." header form too', () => {
    const fields = JSON.parse(createAuthHeader(key, body, now)) as Record<string, string>;
    const beckn = `Signature ${Object.entries(fields).map(([k, v]) => `${k}="${v}"`).join(',')}`;
    expect(verifyAuthHeader(beckn, body, lookup, now).ok).toBe(true);
  });
});
