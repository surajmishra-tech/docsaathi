// A typed subset of the UHI core protocol (NHA-ABDM/UHI specification/core.yml, core_version 0.7.1).
// Field names follow the spec exactly so this can talk to a real UHI gateway later.

export const UHI_CORE_VERSION = '0.7.1';
export const UHI_DOMAIN = 'nic2004:85111'; // health services domain used on the UHI network
export const UHI_COUNTRY = 'IND';

export type UhiAction =
  | 'search' | 'select' | 'init' | 'confirm' | 'status' | 'cancel'
  | 'on_search' | 'on_select' | 'on_init' | 'on_confirm' | 'on_status' | 'on_cancel';

export interface UhiContext {
  domain: string;
  country: string;
  city: string; // e.g. "std:020" (Pune)
  action: UhiAction;
  core_version: string;
  consumer_id: string;
  consumer_uri: string;
  provider_id?: string;
  provider_uri?: string;
  transaction_id: string;
  message_id: string;
  timestamp: string;
  ttl?: string;
}

export interface Descriptor {
  name?: string;
  code?: string;
  short_desc?: string;
  long_desc?: string;
  images?: string[];
}

export type Tags = Record<string, string>;

export interface UhiTime {
  label?: string;
  timestamp?: string;
  duration?: string;
  range?: { start?: string; end?: string };
}

export interface Person {
  id?: string;
  name: string;
  gender?: string;
  image?: string;
  tags?: Tags;
}

export interface Agent extends Person {
  phone?: string;
  email?: string;
}

export interface Fulfillment {
  id?: string;
  type?: string; // "PhysicalConsultation" | "Teleconsultation"
  provider_id?: string;
  state?: { descriptor?: Descriptor; updated_at?: string };
  agent?: Agent;
  customer?: { person?: Person; contact?: { phone?: string; email?: string } };
  start?: { time?: UhiTime; instructions?: Descriptor };
  end?: { time?: UhiTime; instructions?: Descriptor };
  tags?: Tags;
}

export interface Price {
  currency: string;
  value: string;
}

export interface Item {
  id: string;
  descriptor?: Descriptor;
  price?: Price;
  category_id?: string;
  fulfillment_id?: string;
  tags?: Tags;
}

export interface Category {
  id: string;
  parent_category_id?: string | null;
  descriptor?: Descriptor;
}

export interface UhiLocation {
  id: string;
  descriptor?: Descriptor;
  gps?: string; // "lat,lng"
  address?: string;
  city?: { name?: string; code?: string };
  country?: { name?: string; code?: string };
}

export interface Provider {
  id: string;
  descriptor?: Descriptor;
  categories?: Category[];
  fulfillments?: Fulfillment[];
  items?: Item[];
  locations?: UhiLocation[];
  tags?: Tags;
}

export interface Catalog {
  descriptor?: Descriptor;
  providers?: Provider[];
}

export interface Quotation {
  price: Price;
  breakup?: Array<{ title: string; price: Price }>;
  ttl?: string;
}

export interface Billing {
  name: string;
  phone: string;
  email?: string;
}

export interface Payment {
  type?: 'ON-ORDER' | 'PRE-FULFILLMENT' | 'ON-FULFILLMENT' | 'POST-FULFILLMENT';
  status?: 'PAID' | 'NOT-PAID';
  params?: { amount?: string; currency: string; transaction_id?: string };
}

export interface Order {
  id?: string;
  state?: string; // "INITIALIZED" | "CONFIRMED" | "CANCELLED" | "COMPLETED"
  provider?: { id: string; descriptor?: Descriptor; locations?: UhiLocation[] };
  items?: Array<{ id: string; descriptor?: Descriptor; price?: Price }>;
  billing?: Billing;
  fulfillment?: Fulfillment;
  quote?: Quotation;
  payment?: Payment;
  created_at?: string;
  updated_at?: string;
}

export interface Intent {
  descriptor?: Descriptor;
  provider?: { id?: string; descriptor?: Descriptor };
  fulfillment?: Fulfillment;
  category?: { descriptor?: Descriptor };
  item?: { descriptor?: Descriptor };
  tags?: Tags;
}

export interface UhiError {
  type: 'CONTEXT-ERROR' | 'CORE-ERROR' | 'DOMAIN-ERROR' | 'POLICY-ERROR' | 'JSON-SCHEMA-ERROR';
  code: string;
  message?: string;
}

export interface UhiRequest<M = unknown> {
  context: UhiContext;
  message: M;
  error?: UhiError;
}

export interface AckResponse {
  message: { ack: { status: 'ACK' | 'NACK' } };
  error?: UhiError;
}

export const ACK: AckResponse = { message: { ack: { status: 'ACK' } } };

export function nack(error: UhiError): AckResponse {
  return { message: { ack: { status: 'NACK' } }, error };
}

// Tags DocSaathi reads (ABDM uses "@abdm/gov.in/..." keys for doctor details).
export const TAG = {
  experience: '@abdm/gov.in/experience',
  languages: '@abdm/gov.in/languages',
  education: '@abdm/gov.in/education',
  hprId: '@abdm/gov.in/hpr_id',
  testData: '@docsaathi/test_data',
  clinicPhone: '@docsaathi/clinic_phone',
} as const;
