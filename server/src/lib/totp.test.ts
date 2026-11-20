import { describe, expect, it } from 'vitest';
import {
  findRecoveryCode, generateRecoveryCodes, generateTotpSecret, hashRecoveryCode, otpauthUrl, qrSvg, RECOVERY_RE,
  stepOf, totpAt, verifyTotp,
} from './totp';

describe('TOTP (RFC 6238, SHA1, 6 digits, 30s)', () => {
  it('matches the RFC 6238 SHA1 test vectors', () => {
    const secret = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ'; // base32 of "12345678901234567890"
    expect(totpAt(secret, 59_000)).toBe('287082');
    expect(totpAt(secret, 1_111_111_109_000)).toBe('081804');
    expect(totpAt(secret, 1_234_567_890_000)).toBe('005924');
  });

  it('generates 160-bit base32 secrets', () => {
    const s = generateTotpSecret();
    expect(s).toMatch(/^[A-Z2-7]{32}$/);
    expect(generateTotpSecret()).not.toBe(s);
  });

  it('accepts the current step and +/-1, rejects +/-2, and reports the step', () => {
    const s = generateTotpSecret();
    const now = 1_700_000_000_000;
    const step = stepOf(now);
    expect(verifyTotp(s, totpAt(s, now), now)).toBe(step);
    expect(verifyTotp(s, totpAt(s, now - 30_000), now)).toBe(step - 1);
    expect(verifyTotp(s, totpAt(s, now + 30_000), now)).toBe(step + 1);
    expect(verifyTotp(s, totpAt(s, now - 60_000), now)).toBeNull();
    expect(verifyTotp(s, totpAt(s, now + 60_000), now)).toBeNull();
  });

  it('rejects malformed codes', () => {
    const s = generateTotpSecret();
    for (const c of ['', '12345', '1234567', 'abcdef', '12 345']) expect(verifyTotp(s, c, Date.now())).toBeNull();
  });

  it('builds a Reserve:<username> otpauth URL', () => {
    const raw = otpauthUrl('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ', 'drew');
    expect(raw.startsWith('otpauth://totp/Reserve:drew?')).toBe(true);
    const u = new URL(raw);
    expect(u.searchParams.get('issuer')).toBe('Reserve');
    expect(u.searchParams.get('algorithm')).toBe('SHA1');
    expect(u.searchParams.get('digits')).toBe('6');
    expect(u.searchParams.get('period')).toBe('30');
  });

  it('renders the QR as inline SVG markup', async () => {
    const svg = await qrSvg('otpauth://totp/Reserve:drew?secret=ABC');
    expect(svg).toContain('<svg');
    expect(svg).not.toMatch(/<script/i);
  });
});

describe('recovery codes', () => {
  it('makes 10 unique xxxx-xxxx codes', () => {
    const codes = generateRecoveryCodes();
    expect(codes).toHaveLength(10);
    expect(new Set(codes).size).toBe(10);
    for (const c of codes) expect(c).toMatch(RECOVERY_RE);
  });

  it('finds a code by its sha256 hash, case-insensitively, and nothing else', () => {
    const codes = generateRecoveryCodes();
    const hashes = codes.map(hashRecoveryCode);
    expect(hashes[0]).toMatch(/^[0-9a-f]{64}$/);
    expect(findRecoveryCode(hashes, codes[3])).toBe(3);
    expect(findRecoveryCode(hashes, ` ${codes[3].toUpperCase()} `)).toBe(3);
    expect(findRecoveryCode(hashes, 'zzzz-zzzz')).toBe(-1);
    expect(findRecoveryCode([], codes[0])).toBe(-1);
  });
});
