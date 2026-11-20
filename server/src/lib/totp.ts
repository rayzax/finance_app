import { createHmac, randomInt, timingSafeEqual } from 'node:crypto';
import * as OTPAuth from 'otpauth';
import QRCode from 'qrcode';
import { getConfig } from './config';
import { deriveKey } from './keys';

export const TOTP_ISSUER = 'Reserve';
export const TOTP_PERIOD_S = 30;
export const RECOVERY_CODE_COUNT = 10;

function totp(secretBase32: string, label = 'user') {
  return new OTPAuth.TOTP({
    issuer: TOTP_ISSUER,
    label,
    algorithm: 'SHA1',
    digits: 6,
    period: TOTP_PERIOD_S,
    secret: OTPAuth.Secret.fromBase32(secretBase32),
  });
}

/** 160-bit random secret, base32 (RFC 4648, no padding). */
export function generateTotpSecret(): string {
  return new OTPAuth.Secret({ size: 20 }).base32;
}

/** otpauth://totp/Reserve:<username>?issuer=Reserve&secret=... */
export function otpauthUrl(secretBase32: string, username: string): string {
  return totp(secretBase32, username).toString();
}

export async function qrSvg(text: string): Promise<string> {
  const svg = await QRCode.toString(text, {
    type: 'svg',
    errorCorrectionLevel: 'M',
    margin: 1,
    color: { dark: '#0C1411', light: '#EFE8D8' },
  });
  // The web inlines this markup. It is generated from our own data, but never ship anything that could carry script.
  if (!svg.startsWith('<svg') && !svg.startsWith('<?xml')) throw new Error('unexpected QR output');
  if (/<script|on\w+\s*=|javascript:/i.test(svg)) throw new Error('unexpected QR output');
  return svg;
}

export const stepOf = (ms: number) => Math.floor(ms / 1000 / TOTP_PERIOD_S);

/**
 * Verify a 6-digit code within +/-1 step. Returns the matching time step (for replay protection) or null.
 * The caller must also require `step > totpLastStep` and persist it atomically.
 */
export function verifyTotp(secretBase32: string, code: string, nowMs: number): number | null {
  if (!/^\d{6}$/.test(code)) return null;
  const delta = totp(secretBase32).validate({ token: code, timestamp: nowMs, window: 1 });
  return delta === null ? null : stepOf(nowMs) + delta;
}

/** Test/e2e helper: the code for a given moment. */
export function totpAt(secretBase32: string, nowMs: number): string {
  return totp(secretBase32).generate({ timestamp: nowMs });
}

// ---- recovery codes: xxxx-xxxx over a 31-symbol alphabet without look-alikes (~39.6 bits each) ----
const ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789'; // 31 symbols (no i, l, o, 0, 1)
export const RECOVERY_RE = /^[a-z0-9]{4}-[a-z0-9]{4}$/;

export function generateRecoveryCode(): string {
  const pick = () => ALPHABET[randomInt(ALPHABET.length)];
  return Array.from({ length: 4 }, pick).join('') + '-' + Array.from({ length: 4 }, pick).join('');
}

export function generateRecoveryCodes(n = RECOVERY_CODE_COUNT): string[] {
  const set = new Set<string>();
  while (set.size < n) set.add(generateRecoveryCode());
  return [...set];
}

export const normalizeRecoveryCode = (c: string) => c.trim().toLowerCase();
/** HMAC-SHA256 (hex) under a key derived from SESSION_SECRET: a leaked users collection can't be brute-forced offline. */
export const hashRecoveryCodeWith = (secret: string, c: string) =>
  createHmac('sha256', deriveKey('recovery-codes', secret)).update(normalizeRecoveryCode(c)).digest('hex');
export const hashRecoveryCode = (c: string) => hashRecoveryCodeWith(getConfig().sessionSecret, c);

/** Index of the matching hash, comparing against every stored hash in constant time (no early exit). */
export function findRecoveryCode(hashes: string[], code: string): number {
  const candidate = Buffer.from(hashRecoveryCode(code), 'hex');
  let found = -1;
  hashes.forEach((h, i) => {
    const b = Buffer.from(h, 'hex');
    if (b.length === candidate.length && timingSafeEqual(b, candidate) && found === -1) found = i;
  });
  return found;
}
