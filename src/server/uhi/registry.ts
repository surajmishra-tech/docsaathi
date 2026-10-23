// Network registry for the local test UHI network.
// On the real network this is the ABDM UHI registry; here we keep subscribers + their
// signing keys in data/uhi-keys.json (created on first run, never committed).
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { config } from '../config.js';
import { exportPrivateKeyPem, generateSigningKey, importSigningKey, type SigningKey } from './signing.js';

export type SubscriberType = 'EUA' | 'HSPA' | 'GATEWAY';

export interface Subscriber {
  subscriber_id: string;
  type: SubscriberType;
  subscriber_url: string;
  domain: string;
  city: string;
  country: string;
  ukId: string; // key id
  signing_public_key: string;
  status: 'SUBSCRIBED';
}

export const TEST_GATEWAY_ID = 'docsaathi-test-gateway';
export const TEST_HSPA_IDS = ['citycare-test-hspa', 'healthfirst-test-hspa'] as const;
export const UHI_CITY = process.env.UHI_CITY ?? 'std:020'; // Pune STD code

interface StoredKeys {
  [subscriberId: string]: { keyId: string; privatePem: string };
}

const keys = new Map<string, SigningKey>();
const subscribers = new Map<string, Subscriber>();
let loaded = false;

function keysFile(): string {
  return join(config.dataDir, 'uhi-keys.json');
}

function loadOrCreateKeys(ids: string[]): void {
  const inMemory = config.dbFile === ':memory:';
  let stored: StoredKeys = {};
  if (!inMemory && existsSync(keysFile())) stored = JSON.parse(readFileSync(keysFile(), 'utf8')) as StoredKeys;
  let changed = false;
  for (const id of ids) {
    const saved = stored[id];
    if (saved) {
      keys.set(id, importSigningKey(id, saved.keyId, saved.privatePem));
    } else {
      const key = generateSigningKey(id, 'k1');
      keys.set(id, key);
      stored[id] = { keyId: key.keyId, privatePem: exportPrivateKeyPem(key) };
      changed = true;
    }
  }
  if (changed && !inMemory) {
    mkdirSync(config.dataDir, { recursive: true });
    writeFileSync(keysFile(), JSON.stringify(stored, null, 2));
  }
}

/** Base URL other participants use to reach us (callbacks). */
export function publicBaseUrl(): string {
  return config.uhi.callbackBaseUrl ?? config.baseUrl;
}

export function ensureRegistry(): void {
  if (loaded) return;
  const euaId = config.uhi.subscriberId;
  loadOrCreateKeys([euaId, TEST_GATEWAY_ID, ...TEST_HSPA_IDS]);
  const base = publicBaseUrl();
  const add = (id: string, type: SubscriberType, url: string) => {
    const key = keys.get(id)!;
    subscribers.set(id, {
      subscriber_id: id,
      type,
      subscriber_url: url,
      domain: 'nic2004:85111',
      city: UHI_CITY,
      country: 'IND',
      ukId: key.keyId,
      signing_public_key: key.publicKeyB64,
      status: 'SUBSCRIBED',
    });
  };
  add(euaId, 'EUA', `${base}/uhi/eua`);
  add(TEST_GATEWAY_ID, 'GATEWAY', `${base}/uhi/gateway`);
  for (const id of TEST_HSPA_IDS) add(id, 'HSPA', `${base}/uhi/hspa/${id}`);
  loaded = true;
}

export function signingKey(subscriberId: string): SigningKey {
  ensureRegistry();
  const key = keys.get(subscriberId);
  if (!key) throw new Error(`No signing key for ${subscriberId}`);
  return key;
}

export function lookupPublicKey(subscriberId: string, keyId: string): string | undefined {
  ensureRegistry();
  const sub = subscribers.get(subscriberId);
  return sub && sub.ukId === keyId ? sub.signing_public_key : undefined;
}

export function lookupSubscribers(filter: Partial<Pick<Subscriber, 'subscriber_id' | 'type' | 'city'>> = {}): Subscriber[] {
  ensureRegistry();
  return [...subscribers.values()].filter(
    (s) =>
      (!filter.subscriber_id || s.subscriber_id === filter.subscriber_id) &&
      (!filter.type || s.type === filter.type) &&
      (!filter.city || s.city === filter.city),
  );
}

export function gatewayUrl(): string {
  ensureRegistry();
  return config.uhi.gatewayUrl ?? subscribers.get(TEST_GATEWAY_ID)!.subscriber_url;
}
