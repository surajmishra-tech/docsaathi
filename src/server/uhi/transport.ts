import type { Request, Response } from 'express';
import { lookupPublicKey } from './registry.js';
import { createAuthHeader, verifyAuthHeader, type SigningKey } from './signing.js';
import { nack, type AckResponse, type UhiRequest } from './types.js';

export interface RawBodyRequest extends Request {
  rawBody?: Buffer;
}

export class UhiHttpError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
  }
}

/** POST a signed UHI message. `extraHeaders` lets the gateway add X-Gateway-Authorization. */
export async function postSigned(
  url: string,
  payload: UhiRequest,
  key: SigningKey,
  extraHeaders: Record<string, string> = {},
): Promise<AckResponse> {
  const body = JSON.stringify(payload);
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: createAuthHeader(key, body),
      ...extraHeaders,
    },
    body,
    signal: AbortSignal.timeout(8000),
  });
  const text = await res.text();
  let parsed: AckResponse | undefined;
  try {
    parsed = JSON.parse(text) as AckResponse;
  } catch {
    // not JSON
  }
  if (!res.ok || !parsed?.message?.ack) {
    throw new UhiHttpError(`UHI ${payload.context.action} to ${url} failed: HTTP ${res.status} ${text.slice(0, 200)}`, res.status);
  }
  if (parsed.message.ack.status !== 'ACK') {
    throw new UhiHttpError(`UHI ${payload.context.action} NACK: ${parsed.error?.message ?? parsed.error?.code ?? 'unknown'}`);
  }
  return parsed;
}

/**
 * Verify the sender's signature on an incoming UHI request. On failure this answers
 * 401 + NACK and returns null; on success returns the parsed body and signer id.
 */
export function readSigned<M>(req: RawBodyRequest, res: Response): { body: UhiRequest<M>; signer: string } | null {
  const raw = req.rawBody ?? Buffer.from(JSON.stringify(req.body ?? {}));
  const result = verifyAuthHeader(req.header('authorization'), raw, lookupPublicKey);
  if (!result.ok) {
    res.status(401).json(nack({ type: 'POLICY-ERROR', code: '10001', message: `Signature check failed: ${result.reason}` }));
    return null;
  }
  const body = req.body as UhiRequest<M>;
  if (!body?.context?.action || !body.context.transaction_id || !body.context.message_id) {
    res.status(400).json(nack({ type: 'CONTEXT-ERROR', code: '20001', message: 'Missing context fields' }));
    return null;
  }
  return { body, signer: result.subscriberId! };
}

/** Run background work after the ACK has been sent, logging (not throwing) failures. */
export function afterAck(label: string, work: () => Promise<void>): void {
  setImmediate(() => {
    work().catch((err: unknown) => {
      console.error(`[uhi] ${label} failed:`, err instanceof Error ? err.message : err);
    });
  });
}
