import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import type { NextFunction, Request, Response } from 'express';
import { getConfig } from './config';

export const COOKIE_NAME = 'reserve_session';
export const SESSION_MAX_AGE_S = 30 * 24 * 60 * 60;

export function createSessionToken(secret: string = getConfig().sessionSecret): string {
  return jwt.sign({ sub: 'owner' }, secret, { algorithm: 'HS256', expiresIn: SESSION_MAX_AGE_S });
}

export function verifySessionToken(token: string | undefined, secret: string = getConfig().sessionSecret): boolean {
  if (!token || !secret) return false;
  try {
    const p = jwt.verify(token, secret, { algorithms: ['HS256'] });
    return typeof p === 'object' && p.sub === 'owner';
  } catch {
    return false;
  }
}

export function cookieOptions() {
  return {
    httpOnly: true,
    secure: getConfig().isProduction,
    sameSite: 'strict' as const,
    path: '/',
  };
}

export function setSessionCookie(res: Response): void {
  res.cookie(COOKIE_NAME, createSessionToken(), { ...cookieOptions(), maxAge: SESSION_MAX_AGE_S * 1000 });
}
export function clearSessionCookie(res: Response): void {
  res.clearCookie(COOKIE_NAME, cookieOptions());
}

// Valid-format hash used so a missing/invalid configured hash still costs a bcrypt round.
const DUMMY_HASH = bcrypt.hashSync('reserve-dummy', 12);

/** bcrypt compare (constant-time w.r.t. the password). Never throws. */
export async function checkPassword(password: string, hash: string = getConfig().appPasswordHash): Promise<boolean> {
  try {
    const ok = await bcrypt.compare(password, hash || DUMMY_HASH);
    return Boolean(hash) && ok;
  } catch {
    await bcrypt.compare(password, DUMMY_HASH);
    return false;
  }
}

export function requireSession(req: Request, res: Response, next: NextFunction): void {
  if (!verifySessionToken(req.cookies?.[COOKIE_NAME])) {
    res.status(401).json({ error: 'Not authenticated' });
    return;
  }
  next();
}

const STATE_CHANGING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
export function requireCsrfHeader(req: Request, res: Response, next: NextFunction): void {
  if (STATE_CHANGING.has(req.method) && req.get('X-Requested-With') !== 'reserve') {
    res.status(403).json({ error: 'Missing X-Requested-With header' });
    return;
  }
  next();
}
