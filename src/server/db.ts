import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { config } from './config.js';
import { clock } from './time.js';

let instance: DatabaseSync | undefined;

/** The one database connection. Tests set DOCSAATHI_DB=:memory:. */
export function db(): DatabaseSync {
  if (!instance) {
    const file = config.dbFile;
    if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true });
    instance = new DatabaseSync(file);
    instance.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
    migrate(instance);
  }
  return instance;
}

export function closeDb(): void {
  instance?.close();
  instance = undefined;
}

function migrate(d: DatabaseSync): void {
  d.exec(`
    -- ===== DocSaathi (the family's assistant, a UHI "End User Application") =====
    CREATE TABLE IF NOT EXISTS households (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      token TEXT NOT NULL UNIQUE,
      home_address TEXT NOT NULL,
      home_lat REAL NOT NULL,
      home_lng REAL NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS members (
      id TEXT PRIMARY KEY,
      household_id TEXT NOT NULL REFERENCES households(id),
      name TEXT NOT NULL,
      relation TEXT NOT NULL,          -- key from words.RELATIONS, e.g. 'dadi'
      age INTEGER,
      gender TEXT,                     -- 'M' | 'F' | other text
      phone TEXT,
      alt_names TEXT,                  -- other spellings, e.g. Devanagari 'आरव' for Aarav (comma separated)
      notify INTEGER NOT NULL DEFAULT 0, -- 1 = gets a message when someone is booked
      speaker INTEGER NOT NULL DEFAULT 0, -- 1 = the person talking to Alexa ("me"); Alexa+ recognises voices
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS appointments (
      id TEXT PRIMARY KEY,
      household_id TEXT NOT NULL REFERENCES households(id),
      member_id TEXT NOT NULL REFERENCES members(id),
      transaction_id TEXT NOT NULL,
      order_id TEXT NOT NULL,
      provider_id TEXT NOT NULL,
      provider_uri TEXT NOT NULL,
      doctor_id TEXT NOT NULL,
      doctor_name TEXT NOT NULL,
      specialty TEXT NOT NULL,
      clinic_name TEXT NOT NULL,
      clinic_address TEXT NOT NULL,
      clinic_lat REAL,
      clinic_lng REAL,
      clinic_phone TEXT,
      start_at TEXT NOT NULL,          -- ISO with +05:30
      end_at TEXT NOT NULL,
      fee INTEGER NOT NULL,
      instructions TEXT,
      status TEXT NOT NULL,            -- 'confirmed' | 'cancelled'
      test_data INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS holds (
      id TEXT PRIMARY KEY,
      household_id TEXT NOT NULL REFERENCES households(id),
      member_id TEXT NOT NULL REFERENCES members(id),
      transaction_id TEXT NOT NULL,
      provider_id TEXT NOT NULL,
      provider_uri TEXT NOT NULL,
      order_json TEXT NOT NULL,        -- the UHI order from on_init
      summary_json TEXT NOT NULL,      -- what we show and say on the confirm card
      replaces_appointment_id TEXT,
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS follow_ups (
      id TEXT PRIMARY KEY,
      household_id TEXT NOT NULL REFERENCES households(id),
      member_id TEXT NOT NULL REFERENCES members(id),
      doctor_id TEXT,
      doctor_name TEXT,
      specialty TEXT,
      due_on TEXT NOT NULL,            -- YYYY-MM-DD
      note TEXT,
      status TEXT NOT NULL,            -- 'open' | 'booked' | 'dismissed'
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS last_results (
      household_id TEXT PRIMARY KEY REFERENCES households(id),
      results_json TEXT NOT NULL,      -- last doctor search, so "the first one" / "Dr. Mehta" works
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS family_messages (
      id TEXT PRIMARY KEY,
      household_id TEXT NOT NULL REFERENCES households(id),
      to_member_id TEXT REFERENCES members(id),
      to_label TEXT NOT NULL,
      body TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    -- ===== Test UHI network: health service providers (clinics) =====
    CREATE TABLE IF NOT EXISTS hspa_clinics (
      id TEXT PRIMARY KEY,
      hspa_id TEXT NOT NULL,
      name TEXT NOT NULL,
      address TEXT NOT NULL,
      lat REAL NOT NULL,
      lng REAL NOT NULL,
      phone TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS hspa_doctors (
      id TEXT PRIMARY KEY,             -- HPR-style id
      hspa_id TEXT NOT NULL,
      clinic_id TEXT NOT NULL REFERENCES hspa_clinics(id),
      name TEXT NOT NULL,
      gender TEXT NOT NULL,
      specialty TEXT NOT NULL,
      education TEXT NOT NULL,
      experience_years INTEGER NOT NULL,
      languages TEXT NOT NULL,         -- comma separated codes: 'en,hi,mr'
      fee INTEGER NOT NULL,
      slot_minutes INTEGER NOT NULL,
      schedule_json TEXT NOT NULL,     -- { "1": [["10:00","13:00"],["17:00","20:30"]], ... } weekday -> sessions
      instructions TEXT
    );
    CREATE TABLE IF NOT EXISTS hspa_bookings (
      id TEXT PRIMARY KEY,             -- UHI order id
      hspa_id TEXT NOT NULL,
      doctor_id TEXT NOT NULL REFERENCES hspa_doctors(id),
      transaction_id TEXT NOT NULL,
      patient_name TEXT NOT NULL,
      patient_phone TEXT,
      start_at TEXT NOT NULL,
      end_at TEXT NOT NULL,
      status TEXT NOT NULL,            -- 'held' | 'confirmed' | 'cancelled'
      hold_expires_at TEXT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_hspa_bookings_doctor ON hspa_bookings(doctor_id, start_at);

    -- News for the family that Alexa says by herself (the clinic accepted or could not take a booking).
    CREATE TABLE IF NOT EXISTS notices (
      id TEXT PRIMARY KEY,
      household_id TEXT NOT NULL REFERENCES households(id),
      kind TEXT NOT NULL,              -- 'clinic-accepted' | 'clinic-rejected'
      appointment_id TEXT NOT NULL REFERENCES appointments(id),
      note TEXT,
      delivered INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    );

    -- ===== Account linking (OAuth 2.1, see oauth.ts). Only SHA-256 hashes of codes and tokens are kept.
    -- Times are real epoch milliseconds (not the demo clock, which can jump months ahead).
    CREATE TABLE IF NOT EXISTS oauth_codes (
      code_hash TEXT PRIMARY KEY,
      grant_id TEXT NOT NULL,          -- one linking = one grant; its tokens are revoked together
      client_id TEXT NOT NULL,
      household_id TEXT NOT NULL REFERENCES households(id),
      redirect_uri TEXT NOT NULL,
      code_challenge TEXT NOT NULL,    -- PKCE, S256
      scope TEXT NOT NULL,
      resource TEXT,                   -- RFC 8707: the MCP server the tokens are for
      expires_at INTEGER NOT NULL,
      used INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS oauth_tokens (
      token_hash TEXT PRIMARY KEY,
      kind TEXT NOT NULL,              -- 'access' | 'refresh'
      grant_id TEXT NOT NULL,
      client_id TEXT NOT NULL,
      household_id TEXT REFERENCES households(id), -- NULL = a service token (client credentials)
      scope TEXT NOT NULL,
      resource TEXT,
      expires_at INTEGER NOT NULL,
      revoked INTEGER NOT NULL DEFAULT 0,
      used INTEGER NOT NULL DEFAULT 0, -- a refresh token is used once (rotation); a second use revokes the grant
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_oauth_tokens_grant ON oauth_tokens(grant_id);

    -- ===== The family's health record (records.ts): visits to doctors outside DocSaathi, and the
    -- medicines doctors wrote. A record of what the doctor said, never a suggestion.
    CREATE TABLE IF NOT EXISTS doctor_visits (
      id TEXT PRIMARY KEY,
      household_id TEXT NOT NULL REFERENCES households(id),
      member_id TEXT NOT NULL REFERENCES members(id),
      doctor_name TEXT NOT NULL,
      specialty TEXT,
      clinic TEXT,
      visited_on TEXT NOT NULL,        -- YYYY-MM-DD
      notes TEXT,
      added_by TEXT,                   -- member who was talking when it was added
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS medicines (
      id TEXT PRIMARY KEY,
      household_id TEXT NOT NULL REFERENCES households(id),
      member_id TEXT NOT NULL REFERENCES members(id),
      name TEXT NOT NULL,              -- as the doctor wrote it
      how_to_take TEXT,                -- e.g. "1 tablet morning and night, after food"
      days INTEGER,                    -- how many days (NULL = ongoing)
      doctor_name TEXT,
      started_on TEXT NOT NULL,        -- YYYY-MM-DD
      notes TEXT,
      added_by TEXT,
      created_at TEXT NOT NULL
    );

    -- The simulator's Alexa side: the tokens this simulated Echo got by linking (Alexa keeps these
    -- in its own cloud for a real Echo).
    CREATE TABLE IF NOT EXISTS alexa_links (
      device_id TEXT PRIMARY KEY,
      household_id TEXT NOT NULL REFERENCES households(id),
      access_token TEXT NOT NULL,
      refresh_token TEXT NOT NULL,
      scope TEXT NOT NULL,
      expires_at INTEGER NOT NULL,
      linked_at INTEGER NOT NULL
    );
  `);
  // Upgrades for databases created by an earlier version of DocSaathi.
  ensureColumn(d, 'members', 'alt_names', 'TEXT');
  ensureColumn(d, 'members', 'speaker', 'INTEGER NOT NULL DEFAULT 0');
  // Where the home location came from: 'default' (the demo address), 'device' (the browser's location) or 'spoken'.
  ensureColumn(d, 'households', 'home_source', "TEXT NOT NULL DEFAULT 'default'");
  // The language Alexa answers in: 'en' or 'hi' ("Hindi mein bolo" / "speak in English").
  ensureColumn(d, 'households', 'reply_lang', "TEXT NOT NULL DEFAULT 'en'");
  // The clinic's own answer to a booking: 'new' (not looked at yet), 'accepted' or 'rejected' (+ why).
  // Kept on the clinic's side (hspa_bookings, with who to tell) and on the family's side (appointments).
  ensureColumn(d, 'hspa_bookings', 'clinic_state', "TEXT NOT NULL DEFAULT 'new'");
  ensureColumn(d, 'hspa_bookings', 'clinic_note', 'TEXT');
  ensureColumn(d, 'hspa_bookings', 'context_json', 'TEXT');
  ensureColumn(d, 'appointments', 'clinic_state', "TEXT NOT NULL DEFAULT 'new'");
  ensureColumn(d, 'appointments', 'clinic_note', 'TEXT');
  // The family PIN for account linking (scrypt hash; never the PIN itself).
  ensureColumn(d, 'households', 'link_pin_hash', 'TEXT');
}

function ensureColumn(d: DatabaseSync, table: string, column: string, definition: string): void {
  const columns = d.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (!columns.some((c) => c.name === column)) d.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

export function newId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`;
}

/** Current time on the demo clock (which can be jumped forward for the follow-up demo). */
export function nowIso(): string {
  return clock.now().toISOString();
}
