// Where the family is: "near me" should mean near THEM, in any Indian city.
// The location comes from the device (the simulator's location button) or from what they say
// ("I live in Rohini, Delhi"). The test clinics move with it, like a real network would have
// clinics in every city.
import { rememberHospitals, type Reply } from './booking.js';
import { db } from './db.js';
import { householdById, type Household } from './family.js';
import { geocodePlace, haversineKm, reverseGeocode, type LatLng } from './google.js';
import { cityOf, nameClinicAreas, placeTestClinics } from './uhi/testnet/seed.js';

// Works without a Google key: the big cities by name.
const CITIES: Array<[RegExp, string, number, number]> = [
  [/\b(new delhi|delhi|dilli)\b/, 'New Delhi', 28.6139, 77.209],
  [/\b(mumbai|bombay)\b/, 'Mumbai', 19.076, 72.8777],
  [/\b(pune|poona)\b/, 'Pune', 18.5204, 73.8567],
  [/\b(bengaluru|bangalore)\b/, 'Bengaluru', 12.9716, 77.5946],
  [/\bhyderabad\b/, 'Hyderabad', 17.385, 78.4867],
  [/\b(chennai|madras)\b/, 'Chennai', 13.0827, 80.2707],
  [/\b(kolkata|calcutta)\b/, 'Kolkata', 22.5726, 88.3639],
  [/\bahmedabad\b/, 'Ahmedabad', 23.0225, 72.5714],
  [/\bjaipur\b/, 'Jaipur', 26.9124, 75.7873],
  [/\blucknow\b/, 'Lucknow', 26.8467, 80.9462],
  [/\bnoida\b/, 'Noida', 28.5355, 77.391],
  [/\b(gurgaon|gurugram)\b/, 'Gurugram', 28.4595, 77.0266],
  [/\bghaziabad\b/, 'Ghaziabad', 28.6692, 77.4538],
  [/\bfaridabad\b/, 'Faridabad', 28.4089, 77.3178],
  [/\bchandigarh\b/, 'Chandigarh', 30.7333, 76.7794],
  [/\bpatna\b/, 'Patna', 25.5941, 85.1376],
  [/\bindore\b/, 'Indore', 22.7196, 75.8577],
  [/\bbhopal\b/, 'Bhopal', 23.2599, 77.4126],
  [/\bnagpur\b/, 'Nagpur', 21.1458, 79.0882],
  [/\bsurat\b/, 'Surat', 21.1702, 72.8311],
  [/\bkanpur\b/, 'Kanpur', 26.4499, 80.3319],
  [/\bvaranasi\b/, 'Varanasi', 25.3176, 82.9739],
];

/** UHI is India's network, so DocSaathi only looks for doctors in India. */
export function inIndia(at: LatLng): boolean {
  return at.lat >= 6 && at.lat <= 37.6 && at.lng >= 68 && at.lng <= 97.5;
}

export interface FoundPlace extends LatLng {
  label: string;
}

/** A place in words -> coordinates. Google first (any area), then the built-in city list. */
export async function findPlace(text: string): Promise<FoundPlace | null> {
  const t = text.trim();
  if (!t) return null;
  const hit = await geocodePlace(t);
  if (hit && inIndia(hit.location)) return { ...hit.location, label: hit.label };
  const city = CITIES.find(([re]) => re.test(t.toLowerCase()));
  return city ? { label: city[1], lat: city[2], lng: city[3] } : null;
}

function nearestCity(at: LatLng): string | undefined {
  const near = CITIES.map(([, name, lat, lng]) => ({ name, km: haversineKm(at, { lat, lng }) })).sort((a, b) => a.km - b.km)[0];
  return near && near.km < 60 ? near.name : undefined;
}

/** Move the family's home (and the test clinics around it). Returns the speakable place name. */
export async function setHome(householdId: string, at: LatLng, label: string | undefined, source: 'device' | 'spoken'): Promise<{ label: string; household: Household }> {
  const name = label ?? (await reverseGeocode(at)) ?? nearestCity(at) ?? 'your location';
  const d = db();
  d.prepare('UPDATE households SET home_address = ?, home_lat = ?, home_lng = ?, home_source = ? WHERE id = ?').run(name, at.lat, at.lng, source, householdId);
  // The old list has travel times from the old place.
  d.prepare('DELETE FROM last_results WHERE household_id = ?').run(householdId);
  placeTestClinics(d, at, name === 'your location' ? 'near you' : cityOf(name));
  await nameClinicAreas(d);
  const household = householdById(householdId)!;
  void rememberHospitals(household).catch(() => undefined); // the nearest real hospitals, ready for an emergency
  return { label: name, household };
}

/** "I live in Rohini, Delhi": what to say, and the new home for the screen. */
export async function changeLocation(householdId: string, place: string): Promise<Reply> {
  const found = await findPlace(place);
  if (!found) {
    return { speech: `I couldn't find "${place.trim()}" in India. Tell me your area and city, like "Rohini, Delhi".`, data: { kind: 'question' } };
  }
  const { label } = await setHome(householdId, found, found.label, 'spoken');
  return {
    speech: `Okay. From now on I'll look for doctors near ${label}.`,
    data: { kind: 'location', home: { label, lat: found.lat, lng: found.lng } },
  };
}
