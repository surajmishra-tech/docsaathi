import { describe, expect, it } from 'vitest';
import { config } from '../src/server/config.js';
import { hashPin, isOurResource, pinMatches, pkceMatches } from '../src/server/oauth.js';

describe('PKCE (S256)', () => {
  it('matches the example in RFC 7636, appendix B', () => {
    expect(pkceMatches('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk', 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM')).toBe(true);
  });
  it('refuses another verifier', () => {
    expect(pkceMatches('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXX', 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM')).toBe(false);
  });
  it('refuses a verifier that is too short or has other characters', () => {
    expect(pkceMatches('short', 'anything')).toBe(false);
    expect(pkceMatches('a'.repeat(42) + '!', 'anything')).toBe(false);
  });
});

describe('family PIN', () => {
  it('is kept as a salted scrypt hash, never the PIN itself', () => {
    const stored = hashPin('1234');
    expect(stored).toMatch(/^scrypt\$/);
    expect(stored).not.toContain('1234');
    expect(hashPin('1234')).not.toBe(stored); // a new salt each time
  });
  it('checks the right PIN and refuses others', () => {
    const stored = hashPin('4321');
    expect(pinMatches('4321', stored)).toBe(true);
    expect(pinMatches('4322', stored)).toBe(false);
    expect(pinMatches('4321', null)).toBe(false);
    expect(pinMatches('4321', 'plain-text')).toBe(false);
  });
});

describe('resource indicator (RFC 8707)', () => {
  it("accepts DocSaathi's own MCP address", () => {
    expect(isOurResource(`http://localhost:${config.port}/mcp`)).toBe(true);
    expect(isOurResource(`http://127.0.0.1:${config.port}/mcp/`)).toBe(true);
  });
  it('refuses other servers, other paths and junk', () => {
    expect(isOurResource('https://evil.example/mcp')).toBe(false);
    expect(isOurResource(`http://localhost:${config.port}/oauth/token`)).toBe(false);
    expect(isOurResource(`http://localhost:${config.port + 1}/mcp`)).toBe(false);
    expect(isOurResource(`http://localhost:${config.port}/mcp?x=1`)).toBe(false);
    expect(isOurResource('not a url')).toBe(false);
  });
});
