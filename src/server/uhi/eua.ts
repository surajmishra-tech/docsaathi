// DocSaathi as a UHI End User Application (EUA): sends signed requests and collects the
// providers' asynchronous callbacks (on_search, on_select, on_init, on_confirm, ...).
import { Router, type Response } from 'express';
import { config } from '../config.js';
import { SPECIALTIES, type SpecialtyCode } from '../words.js';
import { gatewayUrl, publicBaseUrl, signingKey, UHI_CITY } from './registry.js';
import { postSigned, readSigned, type RawBodyRequest } from './transport.js';
import {
  ACK,
  TAG,
  UHI_CORE_VERSION,
  UHI_COUNTRY,
  UHI_DOMAIN,
  type Catalog,
  type Intent,
  type Order,
  type UhiAction,
  type UhiContext,
  type UhiError,
  type UhiRequest,
} from './types.js';

interface Pending {
  responses: UhiRequest[];
  onMessage: () => void;
}

const pending = new Map<string, Pending>();

export class UhiDomainError extends Error {
  constructor(readonly uhiError: UhiError) {
    super(uhiError.message ?? uhiError.code);
  }
}

export class UhiTimeoutError extends Error {}

function euaUri(): string {
  return `${publicBaseUrl()}/uhi/eua`;
}

function context(action: UhiAction, transactionId: string, provider?: { id: string; uri: string }): UhiContext {
  return {
    domain: UHI_DOMAIN,
    country: UHI_COUNTRY,
    city: UHI_CITY,
    action,
    core_version: UHI_CORE_VERSION,
    consumer_id: config.uhi.subscriberId,
    consumer_uri: euaUri(),
    ...(provider ? { provider_id: provider.id, provider_uri: provider.uri } : {}),
    transaction_id: transactionId,
    message_id: crypto.randomUUID(),
    timestamp: new Date().toISOString(),
    ttl: 'PT30S',
  };
}

// News a provider sends on its own, not as the answer to a request: for example a clinic's desk
// accepting a booking, or saying it cannot take it (an unsolicited on_status).
type ProviderNews = (body: UhiRequest) => void;
let providerNews: ProviderNews | undefined;

export function onProviderNews(handler: ProviderNews): void {
  providerNews = handler;
}

/** Routes that receive the providers' callbacks. */
export function euaCallbackRouter(): Router {
  const router = Router();
  router.post('/:action', (req: RawBodyRequest, res: Response) => {
    const signed = readSigned(req, res);
    if (!signed) return;
    res.json(ACK);
    const waiter = pending.get(signed.body.context.message_id);
    if (waiter) {
      waiter.responses.push(signed.body);
      waiter.onMessage();
    } else if (req.params.action === 'on_status' || req.params.action === 'on_cancel') {
      try {
        providerNews?.(signed.body);
      } catch (err) {
        console.error('[uhi] could not apply provider news:', err instanceof Error ? err.message : err);
      }
    }
  });
  return router;
}

/** Send one request and wait for its callback(s). */
async function exchange(
  action: UhiAction,
  url: string,
  ctx: UhiContext,
  message: unknown,
  wait: { quietMs: number; maxMs: number; single: boolean },
): Promise<UhiRequest[]> {
  const entry: Pending = { responses: [], onMessage: () => {} };
  pending.set(ctx.message_id, entry);
  try {
    const done = new Promise<void>((resolve) => {
      let quiet: NodeJS.Timeout | undefined;
      const max = setTimeout(resolve, wait.maxMs);
      entry.onMessage = () => {
        if (wait.single) {
          clearTimeout(max);
          resolve();
          return;
        }
        clearTimeout(quiet);
        quiet = setTimeout(() => {
          clearTimeout(max);
          resolve();
        }, wait.quietMs);
      };
    });
    await postSigned(url, { context: ctx, message }, signingKey(config.uhi.subscriberId));
    await done;
    if (wait.single && entry.responses.length === 0) {
      throw new UhiTimeoutError(`The clinic network did not answer ${action} in time. Please try again.`);
    }
    return entry.responses;
  } finally {
    pending.delete(ctx.message_id);
  }
}

// ---------------------------------------------------------------------------
// What the rest of DocSaathi works with

export interface OfferSlot {
  fulfillmentId: string;
  itemId: string;
  start: string; // ISO +05:30
  end: string;
}

export interface DoctorOffer {
  networkName: string;
  providerId: string; // UHI subscriber id of the provider app
  providerUri: string;
  transactionId: string;
  clinic: { id: string; name: string; address: string; lat?: number; lng?: number; phone?: string };
  doctor: {
    id: string;
    name: string;
    gender?: string;
    education?: string;
    experienceYears?: number;
    languages: string[];
    specialtyCode: string;
    specialtyName: string;
  };
  fee: number;
  testData: boolean;
  slots: OfferSlot[];
}

export interface SearchParams {
  specialty?: SpecialtyCode;
  from: Date;
  to: Date;
  doctorName?: string;
  doctorId?: string;
  gender?: 'M' | 'F';
  language?: string;
  maxFee?: number;
  slotsPerDoctor?: number;
}

export function offersFromCatalog(ctx: UhiContext, catalog: Catalog | undefined): DoctorOffer[] {
  const offers = new Map<string, DoctorOffer>();
  for (const provider of catalog?.providers ?? []) {
    const loc = provider.locations?.[0];
    const [lat, lng] = (loc?.gps ?? '').split(',').map(Number);
    const itemsByFulfillment = new Map((provider.items ?? []).map((i) => [i.fulfillment_id, i]));
    for (const f of provider.fulfillments ?? []) {
      const agent = f.agent;
      const item = itemsByFulfillment.get(f.id);
      if (!agent?.id || !f.id || !item || !f.start?.time?.timestamp) continue;
      const key = `${ctx.provider_id}|${provider.id}|${agent.id}`;
      let offer = offers.get(key);
      if (!offer) {
        const code = item.category_id ?? provider.categories?.[0]?.id ?? 'GENERAL_MEDICINE';
        offer = {
          networkName: catalog?.descriptor?.name ?? ctx.provider_id ?? 'UHI provider',
          providerId: ctx.provider_id!,
          providerUri: ctx.provider_uri!,
          transactionId: ctx.transaction_id,
          clinic: {
            id: provider.id,
            name: provider.descriptor?.name ?? loc?.descriptor?.name ?? 'Clinic',
            address: loc?.address ?? '',
            lat: Number.isFinite(lat) ? lat : undefined,
            lng: Number.isFinite(lng) ? lng : undefined,
            phone: provider.tags?.[TAG.clinicPhone],
          },
          doctor: {
            id: agent.id,
            name: agent.name,
            gender: agent.gender,
            education: agent.tags?.[TAG.education],
            experienceYears: agent.tags?.[TAG.experience] ? Number(agent.tags[TAG.experience]) : undefined,
            languages: (agent.tags?.[TAG.languages] ?? '').split(/[,\s]+/).filter(Boolean),
            specialtyCode: code,
            specialtyName: SPECIALTIES[code as SpecialtyCode]?.name ?? provider.categories?.find((c) => c.id === code)?.descriptor?.name ?? code,
          },
          fee: Number(item.price?.value ?? 0),
          testData: provider.tags?.[TAG.testData] === 'true',
          slots: [],
        };
        offers.set(key, offer);
      }
      offer.slots.push({ fulfillmentId: f.id, itemId: item.id, start: f.start.time.timestamp, end: f.end?.time?.timestamp ?? f.start.time.timestamp });
    }
  }
  for (const offer of offers.values()) offer.slots.sort((a, b) => a.start.localeCompare(b.start));
  return [...offers.values()];
}

/** UHI search through the gateway; collects answers from every provider on the network. */
export async function searchDoctors(params: SearchParams): Promise<DoctorOffer[]> {
  const transactionId = crypto.randomUUID();
  const intent: Intent = {
    item: { descriptor: { name: 'Consultation', code: 'Consultation' } },
    fulfillment: {
      type: 'PhysicalConsultation',
      ...(params.doctorName || params.doctorId || params.gender || params.language
        ? {
            agent: {
              name: params.doctorName ?? '',
              ...(params.doctorId ? { id: params.doctorId } : {}),
              ...(params.gender ? { gender: params.gender } : {}),
              ...(params.language ? { tags: { [TAG.languages]: params.language } } : {}),
            },
          }
        : {}),
      start: { time: { timestamp: params.from.toISOString() } },
      end: { time: { timestamp: params.to.toISOString() } },
    },
    ...(params.specialty ? { category: { descriptor: { code: params.specialty, name: SPECIALTIES[params.specialty].name } } } : {}),
    tags: {
      ...(params.maxFee ? { '@docsaathi/max_fee': String(params.maxFee) } : {}),
      ...(params.slotsPerDoctor ? { '@docsaathi/slots_per_doctor': String(params.slotsPerDoctor) } : {}),
    },
  };
  const ctx = context('search', transactionId);
  const responses = await exchange('search', `${gatewayUrl()}/search`, ctx, { intent }, { quietMs: 350, maxMs: 2500, single: false });
  return responses.flatMap((r) => offersFromCatalog(r.context, (r.message as { catalog?: Catalog }).catalog));
}

async function orderCall(
  action: 'select' | 'init' | 'confirm' | 'status' | 'cancel',
  provider: { id: string; uri: string },
  transactionId: string,
  order: Order,
): Promise<Order> {
  const ctx = context(action, transactionId, provider);
  const [reply] = await exchange(action, `${provider.uri}/${action}`, ctx, { order }, { quietMs: 0, maxMs: 7000, single: true });
  if (reply.error) throw new UhiDomainError(reply.error);
  const result = (reply.message as { order?: Order }).order;
  if (!result) throw new UhiDomainError({ type: 'CORE-ERROR', code: '20004', message: 'Empty order in callback' });
  return result;
}

function draftOrder(offer: DoctorOffer, slot: OfferSlot, patient?: { name: string; gender?: string }, billing?: { name: string; phone: string }): Order {
  return {
    provider: { id: offer.clinic.id },
    items: [{ id: slot.itemId }],
    fulfillment: {
      id: slot.fulfillmentId,
      type: 'PhysicalConsultation',
      agent: { id: offer.doctor.id, name: offer.doctor.name },
      start: { time: { timestamp: slot.start } },
      end: { time: { timestamp: slot.end } },
      ...(patient ? { customer: { person: { name: patient.name, ...(patient.gender ? { gender: patient.gender } : {}) } } } : {}),
    },
    ...(billing ? { billing } : {}),
  };
}

const providerOf = (offer: DoctorOffer) => ({ id: offer.providerId, uri: offer.providerUri });

export function selectSlot(offer: DoctorOffer, slot: OfferSlot): Promise<Order> {
  return orderCall('select', providerOf(offer), offer.transactionId, draftOrder(offer, slot));
}

export function initOrder(offer: DoctorOffer, slot: OfferSlot, patient: { name: string; gender?: string }, billing: { name: string; phone: string }): Promise<Order> {
  return orderCall('init', providerOf(offer), offer.transactionId, draftOrder(offer, slot, patient, billing));
}

export function confirmOrder(provider: { id: string; uri: string }, transactionId: string, order: Order): Promise<Order> {
  return orderCall('confirm', provider, transactionId, order);
}

export function orderStatus(provider: { id: string; uri: string }, transactionId: string, orderId: string): Promise<Order> {
  return orderCall('status', provider, transactionId, { id: orderId });
}

/** Cancel is a DocSaathi extension (not in UHI core 0.7.1); the test providers support it. */
export function cancelOrder(provider: { id: string; uri: string }, transactionId: string, orderId: string): Promise<Order> {
  return orderCall('cancel', provider, transactionId, { id: orderId });
}
