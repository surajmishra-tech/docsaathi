// Test clinics for the local UHI network. Every name here is an EXAMPLE (not a real doctor).
// Clinics are placed around the family's home location, so "near me" works in any city.
import type { DatabaseSync } from 'node:sqlite';
import { config } from '../../config.js';
import { reverseGeocode } from '../../google.js';
import type { SpecialtyCode } from '../../words.js';
import type { WeeklySchedule } from './slots.js';

interface ClinicSeed {
  id: string;
  hspa: string;
  name: string;
  area: string; // a Pune area name (used when the home is in Pune and there is no Google key)
  dLatKm: number; // offset from home, km north
  dLngKm: number; // offset from home, km east
  phone: string;
}

interface DoctorSeed {
  id: string;
  clinic: string;
  name: string;
  gender: 'M' | 'F';
  specialty: SpecialtyCode;
  education: string;
  experience: number;
  languages: string;
  fee: number;
  slot: number;
  schedule: WeeklySchedule;
  instructions?: string;
}

const MON_SAT = ['1', '2', '3', '4', '5', '6'];
function days(dayList: string[], sessions: Array<[string, string]>): WeeklySchedule {
  return Object.fromEntries(dayList.map((d) => [d, sessions]));
}
const MORNING_EVENING = days(MON_SAT, [['10:00', '13:00'], ['17:00', '21:00']]);
const EVENING_ONLY = days(MON_SAT, [['17:30', '21:00']]);
const MORNING_ONLY = days(MON_SAT, [['09:00', '13:00']]);
const ALL_DAY = { ...days(MON_SAT, [['09:30', '13:30'], ['16:00', '20:00']]), '0': [['10:00', '13:00']] } as WeeklySchedule;

const A = 'citycare-test-hspa';
const B = 'healthfirst-test-hspa';

// Test phone numbers start with 0000 after the city code, which no real Indian number does.
const CLINICS: ClinicSeed[] = [
  { id: 'clinic-mehta-child', hspa: A, name: 'Mehta Child & Family Clinic (TEST)', area: 'Model Colony', dLatKm: 0.9, dLngKm: -0.8, phone: '+91 20 0000 0101' },
  { id: 'clinic-sharma-diabetes', hspa: A, name: 'Sharma Diabetes & Thyroid Care (TEST)', area: 'Deccan', dLatKm: -0.6, dLngKm: -1.4, phone: '+91 20 0000 0102' },
  { id: 'clinic-city-ortho', hspa: A, name: 'City Bone & Joint Clinic (TEST)', area: 'FC Road', dLatKm: 0.3, dLngKm: -0.5, phone: '+91 20 0000 0103' },
  { id: 'clinic-aarogya', hspa: A, name: 'Aarogya Family Clinic (TEST)', area: 'Shivajinagar', dLatKm: 0.4, dLngKm: 0.6, phone: '+91 20 0000 0104' },
  { id: 'clinic-lifeline', hspa: A, name: 'Lifeline Polyclinic (TEST)', area: 'Wakdewadi', dLatKm: 1.6, dLngKm: 0.9, phone: '+91 20 0000 0105' },
  { id: 'clinic-heartcare', hspa: A, name: 'HeartCare Centre (TEST)', area: 'Bund Garden', dLatKm: -0.3, dLngKm: 2.2, phone: '+91 20 0000 0106' },
  { id: 'clinic-mindspace', hspa: A, name: 'MindSpace Counselling & Psychiatry (TEST)', area: 'Kalyani Nagar', dLatKm: 1.1, dLngKm: 4.0, phone: '+91 20 0000 0107' },
  { id: 'clinic-pearl-dental', hspa: A, name: 'Pearl Dental Care (TEST)', area: 'JM Road', dLatKm: 0.1, dLngKm: -1.0, phone: '+91 20 0000 0108' },
  { id: 'clinic-sunrise', hspa: B, name: 'Sunrise Multispeciality Clinic (TEST)', area: 'Aundh', dLatKm: 3.2, dLngKm: -2.9, phone: '+91 20 0000 0201' },
  { id: 'clinic-little-steps', hspa: B, name: 'Little Steps Kids Clinic (TEST)', area: 'Kothrud', dLatKm: -1.9, dLngKm: -4.6, phone: '+91 20 0000 0202' },
  { id: 'clinic-smile', hspa: B, name: 'Smile Dental Studio (TEST)', area: 'Camp', dLatKm: -2.4, dLngKm: 1.9, phone: '+91 20 0000 0203' },
  { id: 'clinic-drishti', hspa: B, name: 'Drishti Eye Centre (TEST)', area: 'Koregaon Park', dLatKm: -0.9, dLngKm: 3.1, phone: '+91 20 0000 0204' },
  { id: 'clinic-skinglow', hspa: B, name: 'SkinGlow Dermatology (TEST)', area: 'Baner', dLatKm: 4.1, dLngKm: -4.4, phone: '+91 20 0000 0205' },
  { id: 'clinic-nova-ent', hspa: B, name: 'Nova ENT & Hearing Clinic (TEST)', area: 'Erandwane', dLatKm: -1.4, dLngKm: -2.2, phone: '+91 20 0000 0206' },
  { id: 'clinic-mother-care', hspa: B, name: "MotherCare Women's Clinic (TEST)", area: 'Sadashiv Peth', dLatKm: -1.7, dLngKm: -0.3, phone: '+91 20 0000 0207' },
  { id: 'clinic-vision-plus', hspa: B, name: 'Vision Plus Eye Clinic (TEST)', area: 'Pashan', dLatKm: 2.4, dLngKm: -5.2, phone: '+91 20 0000 0208' },
];

const FASTING = 'For a sugar test, come fasting (no food for 8 to 10 hours; water is fine). Bring your glucose diary and old reports.';
const doc = (id: string, clinic: string, name: string, gender: 'M' | 'F', specialty: SpecialtyCode, education: string, experience: number, languages: string, fee: number, slot: number, schedule: WeeklySchedule, instructions?: string): DoctorSeed => ({
  id: `test.${id}@hpr.abdm`,
  clinic,
  name,
  gender,
  specialty,
  education,
  experience,
  languages,
  fee,
  slot,
  schedule,
  instructions,
});

const DOCTORS: DoctorSeed[] = [
  // Child doctors
  doc('anjali.mehta', 'clinic-mehta-child', 'Dr. Anjali Mehta', 'F', 'PEDIATRICS', 'MBBS, MD (Pediatrics)', 14, 'en,hi,mr', 500, 15, MORNING_EVENING, "Bring the child's vaccination card and any old prescriptions."),
  doc('farhan.qureshi', 'clinic-little-steps', 'Dr. Farhan Qureshi', 'M', 'PEDIATRICS', 'MBBS, DCH', 9, 'en,hi,ur', 400, 15, EVENING_ONLY, "Bring the child's vaccination card."),
  doc('priya.nair', 'clinic-sunrise', 'Dr. Priya Nair', 'F', 'PEDIATRICS', 'MBBS, MD (Pediatrics)', 11, 'en,hi,ml', 600, 20, ALL_DAY),
  doc('rohit.bansal', 'clinic-lifeline', 'Dr. Rohit Bansal', 'M', 'PEDIATRICS', 'MBBS, MD (Pediatrics)', 17, 'en,hi,pa', 700, 15, MORNING_EVENING, "Bring the child's vaccination card."),
  doc('sneha.reddy', 'clinic-aarogya', 'Dr. Sneha Reddy', 'F', 'PEDIATRICS', 'MBBS, DCH', 7, 'en,hi,te', 450, 15, ALL_DAY),
  // Sugar doctors
  doc('rakesh.sharma', 'clinic-sharma-diabetes', 'Dr. Rakesh Sharma', 'M', 'DIABETOLOGY', 'MBBS, MD (Medicine), Diabetology', 22, 'en,hi', 700, 20, MORNING_ONLY, FASTING),
  doc('meenakshi.pillai', 'clinic-sunrise', 'Dr. Meenakshi Pillai', 'F', 'DIABETOLOGY', 'MBBS, MD, Fellowship in Diabetology', 14, 'en,hi,ta,ml', 800, 20, MORNING_EVENING, FASTING),
  doc('arvind.joshi', 'clinic-lifeline', 'Dr. Arvind Joshi', 'M', 'DIABETOLOGY', 'MBBS, MD (Medicine)', 11, 'en,hi,mr', 600, 20, EVENING_ONLY, 'Bring your glucose diary and old reports.'),
  // Family doctors
  doc('sunita.rao', 'clinic-sunrise', 'Dr. Sunita Rao', 'F', 'GENERAL_MEDICINE', 'MBBS, MD (Medicine)', 16, 'en,hi,kn', 500, 15, ALL_DAY),
  doc('amit.kulkarni', 'clinic-mehta-child', 'Dr. Amit Kulkarni', 'M', 'GENERAL_MEDICINE', 'MBBS', 8, 'en,hi,mr', 350, 15, MORNING_EVENING),
  doc('neha.gupta', 'clinic-aarogya', 'Dr. Neha Gupta', 'F', 'GENERAL_MEDICINE', 'MBBS, MD (Medicine)', 12, 'en,hi', 400, 15, MORNING_EVENING),
  doc('rajiv.khanna', 'clinic-lifeline', 'Dr. Rajiv Khanna', 'M', 'GENERAL_MEDICINE', 'MBBS, DNB (Family Medicine)', 20, 'en,hi,pa', 600, 15, ALL_DAY),
  doc('salim.ansari', 'clinic-aarogya', 'Dr. Salim Ansari', 'M', 'GENERAL_MEDICINE', 'MBBS', 6, 'en,hi,ur', 300, 15, EVENING_ONLY),
  doc('deepa.menon', 'clinic-lifeline', 'Dr. Deepa Menon', 'F', 'GENERAL_MEDICINE', 'MBBS, MD (Medicine)', 15, 'en,hi,ml,ta', 500, 20, MORNING_ONLY),
  // Bone and joint doctors
  doc('vikram.singh', 'clinic-city-ortho', 'Dr. Vikram Singh', 'M', 'ORTHOPEDICS', 'MBBS, MS (Ortho)', 18, 'en,hi,pa', 800, 20, MORNING_EVENING, 'Bring any X-ray or MRI reports.'),
  doc('pooja.desai', 'clinic-city-ortho', 'Dr. Pooja Desai', 'F', 'ORTHOPEDICS', 'MBBS, MS (Ortho)', 9, 'en,hi,gu,mr', 700, 20, EVENING_ONLY, 'Bring any X-ray or MRI reports.'),
  doc('harish.rao', 'clinic-lifeline', 'Dr. Harish Rao', 'M', 'ORTHOPEDICS', 'MBBS, DNB (Ortho)', 16, 'en,hi,kn,te', 900, 20, MORNING_EVENING, 'Bring any X-ray or MRI reports.'),
  // Teeth doctors
  doc('meera.iyer', 'clinic-smile', 'Dr. Meera Iyer', 'F', 'DENTISTRY', 'BDS, MDS', 12, 'en,hi,ta', 400, 30, MORNING_EVENING),
  doc('karan.arora', 'clinic-pearl-dental', 'Dr. Karan Arora', 'M', 'DENTISTRY', 'BDS', 8, 'en,hi,pa', 300, 30, MORNING_EVENING),
  doc('fatima.sheikh', 'clinic-pearl-dental', 'Dr. Fatima Sheikh', 'F', 'DENTISTRY', 'BDS, MDS (Orthodontics)', 11, 'en,hi,ur', 500, 30, EVENING_ONLY),
  doc('nikhil.patil', 'clinic-smile', 'Dr. Nikhil Patil', 'M', 'DENTISTRY', 'BDS', 5, 'en,hi,mr', 250, 30, ALL_DAY),
  // Eye doctors
  doc('arjun.das', 'clinic-drishti', 'Dr. Arjun Das', 'M', 'OPHTHALMOLOGY', 'MBBS, MS (Ophthalmology)', 15, 'en,hi,bn', 600, 20, MORNING_EVENING, 'Bring your current glasses. Eye drops may blur vision for a few hours, so do not drive back.'),
  doc('shalini.kapoor', 'clinic-vision-plus', 'Dr. Shalini Kapoor', 'F', 'OPHTHALMOLOGY', 'MBBS, MS (Ophthalmology)', 18, 'en,hi,pa', 700, 20, MORNING_EVENING, 'Bring your current glasses.'),
  doc('thomas.mathew', 'clinic-drishti', 'Dr. Thomas Mathew', 'M', 'OPHTHALMOLOGY', 'MBBS, DO', 10, 'en,hi,ml', 500, 20, EVENING_ONLY, 'Bring your current glasses.'),
  // Women's doctors
  doc('kavita.joshi', 'clinic-sunrise', 'Dr. Kavita Joshi', 'F', 'GYNECOLOGY', 'MBBS, MS (OBG)', 19, 'en,hi,mr,gu', 700, 20, ALL_DAY),
  doc('shabnam.khan', 'clinic-mother-care', 'Dr. Shabnam Khan', 'F', 'GYNECOLOGY', 'MBBS, MS (OBG)', 16, 'en,hi,ur', 800, 20, MORNING_EVENING),
  doc('asha.kulkarni', 'clinic-mother-care', 'Dr. Asha Kulkarni', 'F', 'GYNECOLOGY', 'MBBS, DGO', 22, 'en,hi,mr', 600, 20, MORNING_ONLY),
  // Skin doctors
  doc('imran.shaikh', 'clinic-sunrise', 'Dr. Imran Shaikh', 'M', 'DERMATOLOGY', 'MBBS, MD (Dermatology)', 10, 'en,hi,ur', 600, 15, EVENING_ONLY),
  doc('ritu.agarwal', 'clinic-skinglow', 'Dr. Ritu Agarwal', 'F', 'DERMATOLOGY', 'MBBS, MD (Dermatology)', 12, 'en,hi', 700, 15, MORNING_EVENING),
  doc('ananya.bose', 'clinic-aarogya', 'Dr. Ananya Bose', 'F', 'DERMATOLOGY', 'MBBS, DDVL', 6, 'en,hi,bn', 500, 15, ALL_DAY),
  doc('varun.saxena', 'clinic-skinglow', 'Dr. Varun Saxena', 'M', 'DERMATOLOGY', 'MBBS, MD (Dermatology)', 15, 'en,hi', 800, 15, EVENING_ONLY),
  // Ear, nose and throat doctors
  doc('neel.deshpande', 'clinic-city-ortho', 'Dr. Neel Deshpande', 'M', 'ENT', 'MBBS, MS (ENT)', 13, 'en,hi,mr', 550, 15, EVENING_ONLY),
  doc('lakshmi.narayanan', 'clinic-nova-ent', 'Dr. Lakshmi Narayanan', 'F', 'ENT', 'MBBS, MS (ENT)', 14, 'en,hi,ta', 600, 15, MORNING_EVENING),
  doc('gurpreet.sandhu', 'clinic-nova-ent', 'Dr. Gurpreet Sandhu', 'M', 'ENT', 'MBBS, DLO', 9, 'en,hi,pa', 450, 15, ALL_DAY),
  // Heart doctors
  doc('rohan.bhatia', 'clinic-sunrise', 'Dr. Rohan Bhatia', 'M', 'CARDIOLOGY', 'MBBS, MD, DM (Cardiology)', 20, 'en,hi', 1000, 20, MORNING_ONLY),
  doc('kavya.shetty', 'clinic-heartcare', 'Dr. Kavya Shetty', 'F', 'CARDIOLOGY', 'MBBS, MD, DM (Cardiology)', 13, 'en,hi,kn', 1200, 20, MORNING_EVENING, 'Bring your old ECG, echo and blood reports, and the medicines you take.'),
  doc('sanjay.malhotra', 'clinic-heartcare', 'Dr. Sanjay Malhotra', 'M', 'CARDIOLOGY', 'MBBS, MD, DM (Cardiology)', 25, 'en,hi,pa', 1500, 20, MORNING_ONLY, 'Bring your old ECG, echo and blood reports, and the medicines you take.'),
  // Mind and mood doctors
  doc('aditi.rao', 'clinic-mindspace', 'Dr. Aditi Rao', 'F', 'PSYCHIATRY', 'MBBS, MD (Psychiatry)', 10, 'en,hi,kn', 1000, 30, EVENING_ONLY),
  doc('manish.tiwari', 'clinic-mindspace', 'Dr. Manish Tiwari', 'M', 'PSYCHIATRY', 'MBBS, DPM', 18, 'en,hi', 900, 30, MORNING_EVENING),
];

const KM_PER_DEG_LAT = 110.574;
function kmPerDegLng(lat: number): number {
  return 111.32 * Math.cos((lat * Math.PI) / 180);
}

// The area names above are Pune areas. In any other city the test clinics get plain road names
// (or, with a Google Maps key, the real name of the area at that spot: see nameClinicAreas).
const PLAIN_AREAS = ['Main Market', 'Station Road', 'College Road', 'Ring Road', 'Lake Road', 'Temple Road', 'Park Road', 'Market Road'];
const UNNAMED = ' (test address)';

/**
 * Put the test clinics around a home location (adds them, or moves them when the family's
 * location changes), so "near me" works in any city.
 */
export function placeTestClinics(d: DatabaseSync, home: { lat: number; lng: number }, city: string): void {
  const upsert = d.prepare(
    `INSERT INTO hspa_clinics (id, hspa_id, name, address, lat, lng, phone) VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET name = excluded.name, address = excluded.address, lat = excluded.lat, lng = excluded.lng`,
  );
  const inPune = /pune/i.test(city);
  CLINICS.forEach((c, i) => {
    upsert.run(
      c.id,
      c.hspa,
      c.name,
      `${inPune ? c.area : PLAIN_AREAS[i % PLAIN_AREAS.length]}, ${city}${UNNAMED}`,
      home.lat + c.dLatKm / KM_PER_DEG_LAT,
      home.lng + c.dLngKm / kmPerDegLng(home.lat),
      c.phone,
    );
  });
}

/**
 * Give each test clinic the real name of the area it sits in ("Pitampura, Delhi"), from Google
 * Maps. The clinic itself is still test data (and is marked so on every screen); only the area
 * name is real, so the address matches the map. Without a Google key nothing changes.
 */
export async function nameClinicAreas(d: DatabaseSync): Promise<void> {
  const rows = d.prepare('SELECT id, lat, lng, address FROM hspa_clinics').all() as Array<{ id: string; lat: number; lng: number; address: string }>;
  const update = d.prepare('UPDATE hspa_clinics SET address = ? WHERE id = ?');
  await Promise.all(
    rows
      .filter((r) => r.address.endsWith(UNNAMED))
      .map(async (r) => {
        const area = await reverseGeocode({ lat: r.lat, lng: r.lng });
        if (area) update.run(area, r.id);
      }),
  );
}

/** Add the test clinics and doctors (new ones too, when a newer version of DocSaathi brings more). */
export function seedTestNetwork(d: DatabaseSync, home: { lat: number; lng: number } = config.home, city = cityOf(config.home.address)): void {
  const known = new Set((d.prepare('SELECT id FROM hspa_clinics').all() as Array<{ id: string }>).map((r) => r.id));
  if (CLINICS.some((c) => !known.has(c.id))) placeTestClinics(d, home, city);

  const clinicHspa = new Map(CLINICS.map((c) => [c.id, c.hspa]));
  const upsert = d.prepare(
    `INSERT INTO hspa_doctors (id, hspa_id, clinic_id, name, gender, specialty, education, experience_years, languages, fee, slot_minutes, schedule_json, instructions)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET hspa_id = excluded.hspa_id, clinic_id = excluded.clinic_id, name = excluded.name, gender = excluded.gender,
       specialty = excluded.specialty, education = excluded.education, experience_years = excluded.experience_years, languages = excluded.languages,
       fee = excluded.fee, slot_minutes = excluded.slot_minutes, schedule_json = excluded.schedule_json, instructions = excluded.instructions`,
  );
  for (const x of DOCTORS) {
    upsert.run(x.id, clinicHspa.get(x.clinic)!, x.clinic, x.name, x.gender, x.specialty, x.education, x.experience, x.languages, x.fee, x.slot, JSON.stringify(x.schedule), x.instructions ?? null);
  }
}

/** "Rohini, Delhi" -> "Delhi"; "Shivajinagar, Pune, Maharashtra" -> "Pune". */
export function cityOf(address: string): string {
  const parts = address.split(',').map((p) => p.trim()).filter(Boolean);
  return (parts.length >= 3 ? parts[parts.length - 2] : parts[parts.length - 1]) || 'Pune';
}
