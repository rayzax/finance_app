import { randomBytes } from 'node:crypto';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import type { NextFunction, Request, Response } from 'express';
import { getConfig } from './config';
import { deriveKey } from './keys';
import type { AuthUser, StoredUser, UserStore } from './users';
import { toAuthUser } from './users';

export const COOKIE_NAME = 'reserve_session';
export const PENDING_COOKIE_NAME = 'reserve_pending';
export const SESSION_MAX_AGE_S = 30 * 24 * 60 * 60;
export const PENDING_MAX_AGE_S = 5 * 60;
export const USER_CACHE_TTL_MS = 30_000;
export const BCRYPT_COST = 12;
export const MAX_PASSWORD_BYTES = 72; // bcrypt ignores everything past 72 bytes

export type PendingStage = 'mfa' | 'enroll' | 'change_password';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: AuthUser;
    }
  }
}

// ---- tokens -------------------------------------------------------------------------------------------------
// A session and a pending (password-only) token are signed with different keys derived from SESSION_SECRET and
// carry a distinct typ and audience, so one can never be accepted as the other even if a check is ever dropped.
const ISSUER = 'reserve';
const KINDS = {
  session: { typ: 'session', aud: 'reserve:session' },
  pending: { typ: 'pending', aud: 'reserve:pending' },
} as const;

const keyFor = (kind: keyof typeof KINDS, secret: string) =>
  deriveKey(`jwt/${KINDS[kind].typ}`, secret);

export function createSessionToken(userId: string, sessionVersion: number, secret: string = getConfig().sessionSecret): string {
  return jwt.sign({ sv: sessionVersion, typ: KINDS.session.typ }, keyFor('session', secret), {
    algorithm: 'HS256', expiresIn: SESSION_MAX_AGE_S, subject: userId, jwtid: randomBytes(9).toString('base64url'), audience: KINDS.session.aud, issuer: ISSUER,
  });
}

export function createPendingToken(
  userId: string, stage: PendingStage, sessionVersion: number,
  secret: string = getConfig().sessionSecret, ttlS = PENDING_MAX_AGE_S,
): string {
  return jwt.sign({ sv: sessionVersion, stage, typ: KINDS.pending.typ }, keyFor('pending', secret), {
    algorithm: 'HS256', expiresIn: ttlS, subject: userId, jwtid: randomBytes(9).toString('base64url'), audience: KINDS.pending.aud, issuer: ISSUER,
  });
}

function verify(kind: keyof typeof KINDS, token: string | undefined, secret: string) {
  if (!token || !secret) return null;
  try {
    const p = jwt.verify(token, keyFor(kind, secret), {
      algorithms: ['HS256'], audience: KINDS[kind].aud, issuer: ISSUER,
    });
    if (typeof p !== 'object' || p.typ !== KINDS[kind].typ) return null;
    if (typeof p.sub !== 'string' || !p.sub || !Number.isInteger(p.sv)) return null;
    return p;
  } catch {
    return null;
  }
}

export function verifySessionToken(token: string | undefined, secret: string = getConfig().sessionSecret): { userId: string; sv: number } | null {
  const p = verify('session', token, secret);
  return p ? { userId: p.sub as string, sv: p.sv as number } : null;
}

export function verifyPendingToken(token: string | undefined, secret: string = getConfig().sessionSecret): { userId: string; sv: number; stage: PendingStage } | null {
  const p = verify('pending', token, secret);
  if (!p || (p.stage !== 'mfa' && p.stage !== 'enroll' && p.stage !== 'change_password')) return null;
  return { userId: p.sub as string, sv: p.sv as number, stage: p.stage };
}

// ---- cookies ------------------------------------------------------------------------------------------------
export function cookieOptions() {
  return {
    httpOnly: true,
    secure: getConfig().isProduction,
    sameSite: 'strict' as const,
    path: '/',
  };
}

export function setSessionCookie(res: Response, user: Pick<StoredUser, 'id' | 'sessionVersion'>): void {
  res.cookie(COOKIE_NAME, createSessionToken(user.id, user.sessionVersion), { ...cookieOptions(), maxAge: SESSION_MAX_AGE_S * 1000 });
}
export function setPendingCookie(res: Response, user: Pick<StoredUser, 'id' | 'sessionVersion'>, stage: PendingStage): string {
  const token = createPendingToken(user.id, stage, user.sessionVersion);
  res.cookie(PENDING_COOKIE_NAME, token, { ...cookieOptions(), maxAge: PENDING_MAX_AGE_S * 1000 });
  return token;
}
export function clearSessionCookie(res: Response): void {
  res.clearCookie(COOKIE_NAME, cookieOptions());
}
export function clearPendingCookie(res: Response): void {
  res.clearCookie(PENDING_COOKIE_NAME, cookieOptions());
}

// ---- passwords ----------------------------------------------------------------------------------------------
// Valid cost-12 hash of a throwaway string: unknown or disabled users still cost one real bcrypt compare.
const DUMMY_HASH = '$2b$12$9FzPqHfQfth2niNlEwe1B.gmvAWnszDdzXYdSMu3kznkEAuJNu5TW';

export const passwordTooLong = (pw: string) => Buffer.byteLength(pw, 'utf8') > MAX_PASSWORD_BYTES;

export function hashPassword(password: string, cost: number = BCRYPT_COST): Promise<string> {
  return bcrypt.hash(password, cost);
}

/** bcrypt compare. With no/invalid hash it still burns a compare and returns false. Never throws. */
export async function checkPassword(password: string, hash: string | undefined | null): Promise<boolean> {
  try {
    const ok = await bcrypt.compare(password, hash || DUMMY_HASH);
    return Boolean(hash) && ok;
  } catch {
    await bcrypt.compare(password, DUMMY_HASH).catch(() => false);
    return false;
  }
}

// ---- middleware ---------------------------------------------------------------------------------------------
const STATE_CHANGING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
export function requireCsrfHeader(req: Request, res: Response, next: NextFunction): void {
  if (STATE_CHANGING.has(req.method) && req.get('X-Requested-With') !== 'reserve') {
    res.status(403).json({ error: 'Missing X-Requested-With header' });
    return;
  }
  next();
}

/** Can this user hold a full session right now? (pending tokens are checked separately, without totpEnabled.) */
export function sessionValid(u: StoredUser | undefined, sv: number): u is StoredUser {
  return Boolean(u) && !u!.disabled && u!.sessionVersion === sv && u!.totpEnabled === true;
}

export interface AuthMiddleware {
  /** Loads the user (cached <=30s), rejects missing/disabled/revoked/no-MFA, sets req.user. */
  requireSession: (req: Request, res: Response, next: NextFunction) => Promise<void>;
  requireAdmin: (req: Request, res: Response, next: NextFunction) => void;
  /** Blocks everything but the password-change flow while mustChangePassword is set. */
  requirePasswordCurrent: (req: Request, res: Response, next: NextFunction) => Promise<void>;
  /** Cached read used by the middleware; pass fresh=true to bypass the cache. */
  getUser: (id: string, fresh?: boolean) => Promise<StoredUser | undefined>;
  /** Drop the cache entry after a write (other instances converge within USER_CACHE_TTL_MS). */
  invalidate: (id: string) => void;
}

export function createAuthMiddleware(store: UserStore, now: () => number = Date.now): AuthMiddleware {
  const cache = new Map<string, { at: number; user: StoredUser | undefined }>();

  const getUser = async (id: string, fresh = false) => {
    const hit = cache.get(id);
    if (!fresh && hit && now() - hit.at < USER_CACHE_TTL_MS) return hit.user;
    const user = await store.getById(id);
    cache.set(id, { at: now(), user });
    if (cache.size > 500) for (const [k, v] of cache) if (now() - v.at >= USER_CACHE_TTL_MS) cache.delete(k);
    return user;
  };

  const requireSession: AuthMiddleware['requireSession'] = async (req, res, next) => {
    const tok = verifySessionToken(req.cookies?.[COOKIE_NAME]);
    const user = tok ? await getUser(tok.userId) : undefined;
    if (!tok || !sessionValid(user, tok.sv)) {
      res.status(401).json({ error: 'Not authenticated' });
      return;
    }
    req.user = toAuthUser(user);
    res.locals.mustChangePassword = user.mustChangePassword;
    next();
  };

  const requireAdmin: AuthMiddleware['requireAdmin'] = (req, res, next) => {
    if (req.user?.role !== 'admin') {
      res.status(403).json({ error: 'Admin only' });
      return;
    }
    next();
  };

  const requirePasswordCurrent: AuthMiddleware['requirePasswordCurrent'] = async (_req, res, next) => {
    if (res.locals.mustChangePassword) {
      res.status(403).json({ error: 'password_change_required' });
      return;
    }
    next();
  };

  return { requireSession, requireAdmin, requirePasswordCurrent, getUser, invalidate: (id) => { cache.delete(id); } };
}
