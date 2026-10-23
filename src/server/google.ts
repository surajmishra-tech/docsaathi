// Google Maps Platform (legacy web services that the configured key allows):
//   Geocoding API, Places API Text Search + Place Details, Distance Matrix API.
// Every call is optional: without a key (or on any error) DocSaathi falls back to offline estimates.
// Places results are shown with "Google Maps" attribution and are cached only in memory, briefly.
import { config } from './config.js';

export interface LatLng {
  lat: number;
  lng: number;
}

const CACHE_MS = 10 * 60_000;
const cache = new Map<string, { at: number; value: unknown }>();

async function getJson<T>(url: string): Promise<T | null> {
  const hit = cache.get(url);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.value as T;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(6000) });
    if (!res.ok) return null;
    const json = (await res.json()) as T & { status?: string; error_message?: string };
    if (json.status && json.status !== 'OK' && json.status !== 'ZERO_RESULTS') {
      console.warn(`[google] ${json.status}: ${json.error_message ?? ''}`.trim());
      return null;
    }
    cache.set(url, { at: Date.now(), value: json });
    return json;
  } catch (err) {
    console.warn('[google] request failed:', err instanceof Error ? err.message : err);
    return null;
  }
}

function key(): string | undefined {
  return config.googleMapsKey;
}

export function googleEnabled(): boolean {
  return Boolean(key());
}

export async function geocode(address: string): Promise<LatLng | null> {
  const k = key();
  if (!k) return null;
  const url = `https://maps.googleapis.com/maps/api/geocode/json?region=in&address=${encodeURIComponent(address)}&key=${k}`;
  const json = await getJson<{ results?: Array<{ geometry: { location: LatLng } }> }>(url);
  return json?.results?.[0]?.geometry.location ?? null;
}

export interface Place {
  location: LatLng;
  label: string; // short and speakable: "Rohini, Delhi"
}

interface GeocodeResult {
  formatted_address: string;
  types?: string[];
  geometry: { location: LatLng };
  address_components?: Array<{ long_name: string; types: string[] }>;
}

// Results that are an area or an address (not a shop or an office that happens to share the words).
const AREA_TYPES = ['locality', 'sublocality', 'neighborhood', 'administrative_area_level_2', 'administrative_area_level_3', 'postal_code', 'colloquial_area', 'route', 'street_address', 'premise', 'subpremise'];

function placeLabel(r: GeocodeResult): string {
  const part = (...types: string[]) => r.address_components?.find((c) => types.some((t) => c.types.includes(t)))?.long_name;
  const area = part('sublocality_level_1', 'sublocality', 'neighborhood');
  const city = part('locality', 'administrative_area_level_3', 'administrative_area_level_2');
  const label = [...new Set([area, city].filter(Boolean))].join(', ');
  return label || r.formatted_address.split(',').slice(0, 2).join(',').trim();
}

/** A place someone named ("Rohini, Delhi") -> where it is, with a short label. India only. */
export async function geocodePlace(address: string): Promise<Place | null> {
  const k = key();
  if (!k) return null;
  const url = `https://maps.googleapis.com/maps/api/geocode/json?region=in&components=country:IN&address=${encodeURIComponent(address)}&key=${k}`;
  const json = await getJson<{ results?: GeocodeResult[] }>(url);
  const hit = json?.results?.find((r) => (r.types ?? []).some((t) => AREA_TYPES.some((a) => t.startsWith(a))));
  return hit ? { location: hit.geometry.location, label: placeLabel(hit) } : null;
}

/** Coordinates (from the device) -> a short label like "Rohini, Delhi". */
export async function reverseGeocode(at: LatLng): Promise<string | null> {
  const k = key();
  if (!k) return null;
  // Rounded to about 100 m: enough for "near you", and repeat lookups reuse the cache.
  const url = `https://maps.googleapis.com/maps/api/geocode/json?latlng=${at.lat.toFixed(3)},${at.lng.toFixed(3)}&key=${k}`;
  const json = await getJson<{ results?: GeocodeResult[] }>(url);
  const results = json?.results ?? [];
  const hit = results.find((r) => r.address_components?.some((c) => c.types.includes('locality'))) ?? results[0];
  return hit ? placeLabel(hit) : null;
}

export interface NearbyClinic {
  placeId: string;
  name: string;
  address: string;
  location: LatLng;
  rating?: number;
  ratingCount?: number;
  openNow?: boolean;
  phone?: string;
  mapsUrl?: string;
}

/** Real clinics near home from Google Maps. These are "call to book" (not on UHI yet). */
export async function nearbyClinics(query: string, near: LatLng, limit = 3): Promise<NearbyClinic[]> {
  const k = key();
  if (!k) return [];
  const url =
    `https://maps.googleapis.com/maps/api/place/textsearch/json?region=in&query=${encodeURIComponent(query)}` +
    `&location=${near.lat},${near.lng}&radius=5000&key=${k}`;
  const json = await getJson<{
    results?: Array<{
      place_id: string;
      name: string;
      formatted_address: string;
      geometry: { location: LatLng };
      rating?: number;
      user_ratings_total?: number;
      opening_hours?: { open_now?: boolean };
      business_status?: string;
    }>;
  }>(url);
  const results = (json?.results ?? []).filter((r) => r.business_status !== 'CLOSED_PERMANENTLY').slice(0, limit);
  const clinics = results.map((r) => ({
    placeId: r.place_id,
    name: r.name,
    address: r.formatted_address,
    location: r.geometry.location,
    rating: r.rating,
    ratingCount: r.user_ratings_total,
    openNow: r.opening_hours?.open_now,
  }));
  // Phone numbers come from Place Details (one call per clinic, only for the few we show).
  await Promise.all(
    clinics.map(async (c: NearbyClinic) => {
      const d = await getJson<{ result?: { formatted_phone_number?: string; international_phone_number?: string; url?: string } }>(
        `https://maps.googleapis.com/maps/api/place/details/json?place_id=${c.placeId}&fields=formatted_phone_number,international_phone_number,url&key=${k}`,
      );
      c.phone = d?.result?.international_phone_number ?? d?.result?.formatted_phone_number;
      c.mapsUrl = d?.result?.url;
    }),
  );
  return clinics;
}

// ---------------------------------------------------------------------------
// Maps to look at: a picture with pins (and the driving route), made by Google Static Maps.

/** The driving route between two points (Google Directions), as an encoded line; null if unknown. */
export async function routeLine(from: LatLng, to: LatLng): Promise<string | null> {
  const k = key();
  if (!k) return null;
  const url = `https://maps.googleapis.com/maps/api/directions/json?mode=driving&origin=${from.lat},${from.lng}&destination=${to.lat},${to.lng}&key=${k}`;
  const json = await getJson<{ routes?: Array<{ overview_polyline?: { points?: string } }> }>(url);
  return json?.routes?.[0]?.overview_polyline?.points ?? null;
}

export interface MapPin extends LatLng {
  label?: string; // one letter or digit shown on the pin
}

/**
 * A map picture (JPEG, base64): the home as a blue "H" pin and up to 6 red pins. With `withRoute`,
 * the driving route from home to the first pin is drawn. Null without a key or when Google says no.
 */
export async function mapImage(home: LatLng, pins: MapPin[], withRoute: boolean): Promise<string | null> {
  const k = key();
  if (!k || pins.length === 0) return null;
  const at = (p: LatLng) => `${p.lat.toFixed(6)},${p.lng.toFixed(6)}`;
  const parts = ['size=560x320', 'scale=2', 'format=jpg-baseline', `markers=${encodeURIComponent(`color:0x1a73e8|label:H|${at(home)}`)}`];
  for (const p of pins.slice(0, 6)) {
    const label = /^[A-Z0-9]$/.test(p.label ?? '') ? `|label:${p.label}` : '';
    parts.push(`markers=${encodeURIComponent(`color:0xd93025${label}|${at(p)}`)}`);
  }
  if (withRoute) {
    const line = await routeLine(home, pins[0]);
    if (line) parts.push(`path=${encodeURIComponent(`weight:5|color:0x1a73e8cc|enc:${line}`)}`);
  }
  const url = `https://maps.googleapis.com/maps/api/staticmap?${parts.join('&')}&key=${k}`;
  const hit = cache.get(url);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.value as string;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!res.ok || !(res.headers.get('content-type') ?? '').startsWith('image/')) {
      console.warn(`[google] map picture: HTTP ${res.status}`);
      return null;
    }
    const image = Buffer.from(await res.arrayBuffer()).toString('base64');
    // Pictures are big: keep the cache small by dropping the oldest entries.
    if (cache.size > 300) for (const old of [...cache.keys()].slice(0, 100)) cache.delete(old);
    cache.set(url, { at: Date.now(), value: image });
    return image;
  } catch (err) {
    console.warn('[google] map picture failed:', err instanceof Error ? err.message : err);
    return null;
  }
}

export interface Travel {
  minutes: number;
  km: number;
  source: 'google' | 'estimate';
}

/** Straight-line distance in km. */
export function haversineKm(a: LatLng, b: LatLng): number {
  const R = 6371;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

/** Offline estimate for Indian city roads: 1.35x the straight line at ~20 km/h, plus 5 minutes to get going. */
export function estimateTravel(from: LatLng, to: LatLng): Travel {
  const km = haversineKm(from, to) * 1.35;
  return { km: Math.round(km * 10) / 10, minutes: Math.max(5, Math.round((km / 20) * 60 + 5)), source: 'estimate' };
}

/** Driving time from home to each destination (Google Distance Matrix with live traffic when available). */
export async function travelTimes(from: LatLng, destinations: LatLng[]): Promise<Travel[]> {
  const fallback = destinations.map((d) => estimateTravel(from, d));
  const k = key();
  if (!k || destinations.length === 0) return fallback;
  const url =
    `https://maps.googleapis.com/maps/api/distancematrix/json?mode=driving&departure_time=now` +
    `&origins=${from.lat},${from.lng}&destinations=${destinations.map((d) => `${d.lat},${d.lng}`).join('|')}&key=${k}`;
  const json = await getJson<{
    rows?: Array<{ elements: Array<{ status: string; distance?: { value: number }; duration?: { value: number }; duration_in_traffic?: { value: number } }> }>;
  }>(url);
  const elements = json?.rows?.[0]?.elements;
  if (!elements) return fallback;
  return elements.map((e, i) =>
    e.status === 'OK' && e.duration
      ? {
          minutes: Math.max(1, Math.round((e.duration_in_traffic?.value ?? e.duration.value) / 60)),
          km: Math.round(((e.distance?.value ?? 0) / 1000) * 10) / 10,
          source: 'google' as const,
        }
      : fallback[i],
  );
}
