// Test UHI gateway: multicasts a family's search to every provider on the network and
// relays each provider's on_search back to the family's app. Bodies are forwarded
// byte-for-byte so the original sender's signature stays valid; the gateway adds its
// own signature in X-Gateway-Authorization (as the ABDM gateway does).
import { Router, type Response } from 'express';
import { lookupSubscribers, signingKey, TEST_GATEWAY_ID } from '../registry.js';
import { createAuthHeader } from '../signing.js';
import { afterAck, readSigned, type RawBodyRequest } from '../transport.js';
import { ACK, type UhiRequest } from '../types.js';

async function forwardRaw(url: string, rawBody: string, originalAuth: string): Promise<void> {
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: originalAuth,
      'X-Gateway-Authorization': createAuthHeader(signingKey(TEST_GATEWAY_ID), rawBody),
    },
    body: rawBody,
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`forward to ${url} failed: HTTP ${res.status} ${(await res.text()).slice(0, 160)}`);
}

export function testGatewayRouter(): Router {
  const router = Router();

  router.post('/search', (req: RawBodyRequest, res: Response) => {
    const signed = readSigned(req, res);
    if (!signed) return;
    const raw = req.rawBody!.toString('utf8');
    const auth = req.header('authorization')!;
    res.json(ACK);
    for (const hspa of lookupSubscribers({ type: 'HSPA' })) {
      afterAck(`gateway -> ${hspa.subscriber_id} search`, () => forwardRaw(`${hspa.subscriber_url}/search`, raw, auth));
    }
  });

  router.post('/on_search', (req: RawBodyRequest, res: Response) => {
    const signed = readSigned<unknown>(req, res);
    if (!signed) return;
    const { context } = signed.body as UhiRequest;
    const raw = req.rawBody!.toString('utf8');
    const auth = req.header('authorization')!;
    res.json(ACK);
    afterAck(`gateway -> ${context.consumer_id} on_search`, () => forwardRaw(`${context.consumer_uri}/on_search`, raw, auth));
  });

  return router;
}

/** Network registry lookup, shaped like the ABDM UHI registry's /lookup. */
export function testRegistryRouter(): Router {
  const router = Router();
  router.post('/lookup', (req, res) => {
    const { subscriber_id, type } = (req.body ?? {}) as { subscriber_id?: string; type?: string };
    const t = type?.toUpperCase();
    res.json(
      lookupSubscribers({
        subscriber_id,
        type: t === 'EUA' || t === 'HSPA' || t === 'GATEWAY' ? t : undefined,
      }),
    );
  });
  return router;
}
