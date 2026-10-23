import { describe, expect, it } from 'vitest';
import { checkEmergency, relationFromText, resolveSpecialty } from '../src/server/words.js';

describe('everyday words -> kind of doctor', () => {
  it.each([
    ['Aarav ko bukhaar hai, bachchon ka doctor chahiye', 'PEDIATRICS'],
    ['bacche ka doctor', 'PEDIATRICS'],
    ['sugar wale doctor', 'DIABETOLOGY'],
    ['haddi ka doctor, ghutne mein dard', 'ORTHOPEDICS'],
    ['daant mein dard', 'DENTISTRY'],
    ['aankh ka doctor', 'OPHTHALMOLOGY'],
    ['skin rash', 'DERMATOLOGY'],
    ['naak kaan gala', 'ENT'],
    ['ladies doctor', 'GYNECOLOGY'],
    ['heart doctor', 'CARDIOLOGY'],
    ['बच्चों का डॉक्टर', 'PEDIATRICS'],
    ['शुगर की जांच', 'DIABETOLOGY'],
  ])('%s -> %s', (text, code) => {
    expect(resolveSpecialty(text).code).toBe(code);
  });

  it('a general word for a child means a child doctor', () => {
    expect(resolveSpecialty('fever', 7)).toMatchObject({ code: 'PEDIATRICS', reason: 'child-general' });
    expect(resolveSpecialty('fever', 45).code).toBe('GENERAL_MEDICINE');
  });

  it('does not match words hidden inside other words', () => {
    expect(resolveSpecialty('kidney stone').code).not.toBe('PEDIATRICS');
    expect(resolveSpecialty('after an accident').code).not.toBe('DENTISTRY');
    expect(resolveSpecialty('near the dukaan').code).not.toBe('ENT');
    expect(resolveSpecialty('kitchen burn').code).not.toBe('DERMATOLOGY');
    expect(resolveSpecialty('pankha').code).not.toBe('OPHTHALMOLOGY');
  });
});

describe('emergencies are never booked', () => {
  it.each([
    'Papa ke seene mein dard hai',
    'chest pain',
    'Dadi behosh ho gayi',
    "can't breathe",
    'saans nahi aa rahi',
    'पापा के सीने में तेज़ दर्द है',
    'दादी को सांस लेने में बहुत तकलीफ हो रही है',
    'Mummy ko daura pad raha hai',
    'He has fits',
    "Dadi's face is drooping on one side",
    'Dadi fell down and isn’t waking up',
    'Aarav ne galti se dawai ki puri sheeshi pee li',
    'Dadi ki saans phool rahi hai',
  ])('%s', (text) => {
    expect(checkEmergency(text)?.kind).toBe('medical');
  });

  it('self-harm gets the Tele-MANAS helpline', () => {
    const r = checkEmergency('I want to end my life');
    expect(r?.kind).toBe('mental-health');
    expect(r?.speech).toContain('14416');
    expect(checkEmergency('I don’t want to live anymore')?.kind).toBe('mental-health');
  });

  it('ordinary requests are not emergencies', () => {
    expect(checkEmergency('bachchon ka doctor, bukhaar')).toBeNull();
    expect(checkEmergency('Papa needs a routine heart check-up next week')).toBeNull();
    expect(checkEmergency('Papa ke dil ki dhadkan kabhi kabhi tez ho jaati hai')).toBeNull();
  });
});

describe('family words', () => {
  it.each([
    ['Dadi ke liye', 'dadi'],
    ['for grandma', 'dadi'],
    ['Papa ka appointment', 'papa'],
    ['mere liye', 'self'],
    ['meri bhabhi', 'bhabhi'],
    ['दादी', 'dadi'],
  ])('%s -> %s', (text, key) => {
    expect(relationFromText(text)).toBe(key);
  });
});
