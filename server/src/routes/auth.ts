import { createHash } from 'node:crypto';
import { Router, type Request, type Response } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { audit } from '../lib/audit';
import {
  clearPendingCookie, clearSessionCookie, checkPassword, COOKIE_NAME, hashPassword, MAX_PASSWORD_BYTES,
  PENDING_COOKIE_NAME, passwordTooLong, requireCsrfHeader, sessionValid, setPendingCookie, setSessionCookie,
  verifyPendingToken, verifySessionToken, type AuthMiddleware, type PendingStage,
} from '../lib/auth';
import { getConfig } from '../lib/config';
import { decryptToken, encryptToken } from '../lib/crypto';
import { FailureLimiter } from '../lib/rateLimit';
import {
  findRecoveryCode, generateRecoveryCodes, generateTotpSecret, hashRecoveryCode, otpauthUrl, qrSvg, RECOVERY_RE,
  verifyTotp,
} from '../lib/totp';
import {
  deriveInitials, newUserDoc, normalizeUsername, toAuthUser, USERNAME_RE, UsernameTakenError, type StoredUser, type UserStore,
} from '../lib/users';
import { parseBody } from './util';

export const GENERIC_LOGIN_ERROR = 'Invalid username or password';
export const LOCKOUT_FAILURES = 10;
export const LOCKOUT_WINDOW_MS = 15 * 60 * 1000;
export const MFA_ATTEMPTS = 5;
export const MFA_WINDOW_MS = 5 * 60 * 1000;

export interface AuthRouterDeps {
  store: UserStore;
  mw: AuthMiddleware;
  now: () => number;
  bcryptCost?: number;
}

const loginSchema = z.object({ username: z.string().min(1).max(64), password: z.string().min(1).max(1024) }).strict();
const codeSchema = z.object({ code: z.string().min(1).max(32) }).strict();
const setupSchema = z.object({ code: z.string().min(1).max(32).optional() }).strict();
const passwordSchema = z.object({ currentPassword: z.string().min(1).max(1024), newPassword: z.string().min(12).max(1024) }).strict();

const sha = (s: string) => createHash('sha256').update(s).digest('hex').slice(0, 32);
const isLocked = (u: StoredUser, now: number) => Boolean(u.lockedUntil) && Date.parse(u.lockedUntil!) > now;

export function authRouter(deps: AuthRouterDeps): Router {
  const { store, mw, now } = deps;
  const r = Router();
  const mfaLimiter = new FailureLimiter(MFA_ATTEMPTS, MFA_WINDOW_MS, now);
  const ip = (req: Request) => req.ip ?? null;

  const loginLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 5,
    standardHeaders: true,
    legacyHeaders: false,
    skipSuccessfulRequests: true,
    message: { error: 'Too many attempts. Try again later.' },
  });

  r.use(requireCsrfHeader);

  // ---- helpers ----------------------------------------------------------------------------------------------
  /** Atomically count a failed password / code attempt; lock the account after LOCKOUT_FAILURES in the window. */
  async function recordFailure(u: StoredUser): Promise<{ locked: boolean }> {
    const res = await store.mutate(u.id, (cur) => {
      const t = now();
      if (isLocked(cur, t)) return { patch: {} };
      const inWindow = cur.failedWindowStart !== null && t - Date.parse(cur.failedWindowStart) < LOCKOUT_WINDOW_MS;
      const count = (inWindow ? cur.failedLogins : 0) + 1;
      if (count >= LOCKOUT_FAILURES) {
        return { patch: { failedLogins: 0, failedWindowStart: null, lockedUntil: new Date(t + LOCKOUT_WINDOW_MS).toISOString() } };
      }
      return { patch: { failedLogins: count, failedWindowStart: inWindow ? cur.failedWindowStart : new Date(t).toISOString() } };
    });
    mw.invalidate(u.id);
    const locked = res.ok && res.user !== null && isLocked(res.user, now());
    if (locked) audit('login_locked', { userId: u.id, username: u.username });
    return { locked };
  }

  const successPatch = () => ({ failedLogins: 0, failedWindowStart: null, lockedUntil: null, lastLoginAt: new Date(now()).toISOString() });

  /** The user behind a pending cookie, re-read from the store (never from the cache). */
  async function pendingUser(req: Request, stage: PendingStage): Promise<StoredUser | undefined> {
    const tok = verifyPendingToken(req.cookies?.[PENDING_COOKIE_NAME]);
    if (!tok || tok.stage !== stage) return undefined;
    const u = await store.getById(tok.userId);
    if (!u || u.disabled || u.sessionVersion !== tok.sv) return undefined;
    if (stage === 'mfa' && !u.totpEnabled) return undefined;
    if (stage !== 'mfa' && u.totpEnabled) return undefined; // enroll/change tokens may never replace an active factor
    if (stage === 'enroll' && u.mustChangePassword) return undefined;
    if (stage === 'change_password' && !u.mustChangePassword) return undefined;
    return u;
  }

  /** The user behind a full session cookie, fresh from the store (used by the sensitive MFA routes). */
  async function sessionUser(req: Request): Promise<StoredUser | undefined> {
    const tok = verifySessionToken(req.cookies?.[COOKIE_NAME]);
    if (!tok) return undefined;
    const u = await store.getById(tok.userId);
    return sessionValid(u, tok.sv) ? u : undefined;
  }

  /** Rate-limit keys: the pending/session token (hashed) and the client IP. */
  const limitKeys = (req: Request) => {
    const t = req.cookies?.[PENDING_COOKIE_NAME] ?? req.cookies?.[COOKIE_NAME];
    return [`ip:${req.ip}`, ...(t ? [`tok:${sha(t)}`] : [])];
  };

  const notSignedIn = (res: Response) => res.status(401).json({ error: 'Session expired. Sign in again.' });

  /** Full TOTP check against the given encrypted secret with an atomic replay claim. Returns the step or null. */
  async function claimTotp(u: StoredUser, secretEnc: string, code: string, extra: Partial<StoredUser> = {}): Promise<number | null> {
    const secret = await decryptToken(secretEnc);
    const step = verifyTotp(secret, code, now());
    if (step === null) return null;
    const res = await store.mutate(u.id, (cur) => {
      if (step <= cur.totpLastStep) return { abort: 'replay' };
      return { patch: { totpLastStep: step, ...extra } };
    });
    mw.invalidate(u.id);
    return res.ok ? step : null;
  }

  // ---- 1. password -----------------------------------------------------------------------------------------
  r.post('/login', loginLimiter, async (req, res) => {
    const body = parseBody(loginSchema, req, res);
    if (!body) return;
    const cfg = getConfig();
    const username = normalizeUsername(body.username);
    let user = USERNAME_RE.test(username) ? await store.getByUsername(username) : undefined;
    let hash = user?.passwordHash;
    let bootstrap = false;
    if (!user && username === cfg.bootstrapAdminUsername && cfg.appPasswordHash && (await store.isEmpty())) {
      hash = cfg.appPasswordHash;
      bootstrap = true;
    }
    // Always exactly one bcrypt compare, whether or not the account exists, is disabled or is locked.
    const passwordOk = await checkPassword(body.password, hash);
    const t = now();
    const locked = user ? isLocked(user, t) : false;

    const fail = async (reason: string) => {
      if (user && !user.disabled && !locked) await recordFailure(user);
      audit(locked ? 'login_locked' : 'login_failure', { ...(user ? { userId: user.id, username: user.username } : {}), ip: ip(req), reason });
      res.status(401).json({ error: GENERIC_LOGIN_ERROR });
    };

    if (!user && !bootstrap) return fail('unknown_user');
    if (!passwordOk) return fail(user ? 'bad_password' : 'bad_bootstrap_password');
    if (user?.disabled) return fail('disabled');
    if (locked) return fail('locked');

    if (!user) {
      // First ever login: promote the legacy single password to the first admin account (cost-12 rehash).
      try {
        user = await store.create(newUserDoc({
          username, displayName: cfg.bootstrapAdminName, role: 'admin',
          passwordHash: await hashPassword(body.password, deps.bcryptCost), mustChangePassword: false, createdBy: null, now: new Date(t),
        }));
        audit('bootstrap_admin_created', { userId: user.id, username: user.username, ip: ip(req) });
      } catch (e) {
        if (!(e instanceof UsernameTakenError)) throw e;
        user = await store.getByUsername(username); // lost a race with a concurrent first login
        if (!user || user.disabled || !(await checkPassword(body.password, user.passwordHash))) return fail('bootstrap_race');
      }
    }

    // A temporary password must be replaced before a factor is enrolled, so whoever issued it cannot enroll theirs.
    const stage: PendingStage = user.totpEnabled ? 'mfa' : user.mustChangePassword ? 'change_password' : 'enroll';
    setPendingCookie(res, user, stage);
    audit('login_success', { userId: user.id, username: user.username, ip: ip(req), reason: `password_ok:${stage}` });
    res.json({ next: stage });
  });

  // ---- 2. second factor ------------------------------------------------------------------------------------
  r.post('/mfa', async (req, res) => {
    const body = parseBody(codeSchema, req, res);
    if (!body) return;
    const user = await pendingUser(req, 'mfa');
    if (!user) return notSignedIn(res);

    const keys = limitKeys(req);
    if (mfaLimiter.blocked(...keys)) {
      audit('mfa_rate_limited', { userId: user.id, username: user.username, ip: ip(req) });
      res.status(429).json({ error: 'Too many attempts. Try again later.' });
      return;
    }
    if (isLocked(user, now())) {
      res.status(429).json({ error: 'Too many attempts. Try again later.' });
      return;
    }

    const code = body.code.trim();
    let ok = false;
    let usedRecovery = false;
    if (/^\d{6}$/.test(code) && user.totpSecretEnc) {
      ok = (await claimTotp(user, user.totpSecretEnc, code, successPatch())) !== null;
    } else if (RECOVERY_RE.test(code.toLowerCase())) {
      const idx = findRecoveryCode(user.recoveryCodes, code);
      if (idx >= 0) {
        const hash = hashRecoveryCode(code);
        // Single-use, atomically: only the request that actually removes the hash wins.
        const res2 = await store.mutate(user.id, (cur) => {
          const i = findRecoveryCode(cur.recoveryCodes, code);
          if (i < 0) return { abort: 'used' };
          return { patch: { recoveryCodes: cur.recoveryCodes.filter((h) => h !== hash), ...successPatch() } };
        });
        mw.invalidate(user.id);
        ok = res2.ok;
        usedRecovery = ok;
      }
    }

    if (!ok) {
      mfaLimiter.fail(...keys);
      await recordFailure(user);
      audit('mfa_failure', { userId: user.id, username: user.username, ip: ip(req) });
      res.status(401).json({ error: 'Invalid code' });
      return;
    }

    const fresh = (await store.getById(user.id))!;
    clearPendingCookie(res);
    setSessionCookie(res, fresh);
    audit(usedRecovery ? 'mfa_recovery_code_used' : 'mfa_success', { userId: user.id, username: user.username, ip: ip(req) });
    res.json({ ok: true, mustChangePassword: fresh.mustChangePassword, recoveryCodesRemaining: fresh.recoveryCodes.length });
  });

  // ---- 3. enrollment: generate ----------------------------------------------------------------------------
  r.post('/mfa/setup', async (req, res) => {
    const body = parseBody(setupSchema, req, res);
    if (!body) return;
    let user = await pendingUser(req, 'enroll');
    if (!user) {
      // Re-enrollment from a full session must prove possession of the current factor first.
      user = await sessionUser(req);
      if (!user) return notSignedIn(res);
      const keys = limitKeys(req);
      if (mfaLimiter.blocked(...keys) || isLocked(user, now())) {
        res.status(429).json({ error: 'Too many attempts. Try again later.' });
        return;
      }
      if (!body.code || !user.totpSecretEnc || (await claimTotp(user, user.totpSecretEnc, body.code.trim())) === null) {
        mfaLimiter.fail(...keys);
        await recordFailure(user);
        audit('mfa_failure', { userId: user.id, username: user.username, ip: ip(req), reason: 'reenroll' });
        res.status(401).json({ error: 'Invalid code' });
        return;
      }
    }
    const secret = generateTotpSecret();
    const url = otpauthUrl(secret, user.username);
    const enc = await encryptToken(secret);
    await store.mutate(user.id, () => ({ patch: { totpPendingEnc: enc } }));
    mw.invalidate(user.id);
    res.json({ otpauthUrl: url, secret, qrSvg: await qrSvg(url) });
  });

  // ---- 4. enrollment: confirm -----------------------------------------------------------------------------
  r.post('/mfa/enable', async (req, res) => {
    const body = parseBody(codeSchema, req, res);
    if (!body) return;
    const pending = await pendingUser(req, 'enroll');
    const user = pending ?? (await sessionUser(req));
    if (!user) return notSignedIn(res);
    const fromEnroll = Boolean(pending);

    const keys = limitKeys(req);
    if (mfaLimiter.blocked(...keys) || isLocked(user, now())) {
      res.status(429).json({ error: 'Too many attempts. Try again later.' });
      return;
    }
    if (!user.totpPendingEnc) {
      res.status(409).json({ error: 'Start enrollment first' });
      return;
    }
    const pendingEnc = user.totpPendingEnc;
    const secret = await decryptToken(pendingEnc);
    const step = verifyTotp(secret, body.code.trim(), now());
    const codes = generateRecoveryCodes();
    const res2 =
      step === null
        ? ({ ok: false } as const)
        : await store.mutate(user.id, (cur) => {
            if (cur.totpPendingEnc !== pendingEnc) return { abort: 'changed' };
            return {
              patch: {
                totpSecretEnc: pendingEnc, totpPendingEnc: null, totpEnabled: true, totpLastStep: step,
                recoveryCodes: codes.map(hashRecoveryCode), ...(fromEnroll ? successPatch() : {}),
              },
            };
          });
    mw.invalidate(user.id);
    if (!res2.ok) {
      mfaLimiter.fail(...keys);
      await recordFailure(user);
      audit('mfa_failure', { userId: user.id, username: user.username, ip: ip(req), reason: 'enroll' });
      res.status(401).json({ error: 'Invalid code' });
      return;
    }
    audit('mfa_enrolled', { userId: user.id, username: user.username, ip: ip(req) });
    if (fromEnroll) {
      clearPendingCookie(res);
      setSessionCookie(res, user);
    }
    res.json({ ok: true, recoveryCodes: codes, mustChangePassword: user.mustChangePassword });
  });

  // ---- session-bound routes --------------------------------------------------------------------------------
  r.get('/me', mw.requireSession, (req, res) => {
    res.json({ authenticated: true, user: req.user, mustChangePassword: Boolean(res.locals.mustChangePassword) });
  });

  r.post('/password', async (req, res) => {
    const body = parseBody(passwordSchema, req, res);
    if (!body) return;
    // Either a pending 'change_password' token (first sign-in with a temporary password) or a full session.
    const pending = await pendingUser(req, 'change_password');
    const user = pending ?? (await sessionUser(req));
    if (!user) return notSignedIn(res);
    const keys = limitKeys(req);
    if (mfaLimiter.blocked(...keys) || isLocked(user, now())) {
      res.status(429).json({ error: 'Too many attempts. Try again later.' });
      return;
    }
    if (!(await checkPassword(body.currentPassword, user.passwordHash))) {
      mfaLimiter.fail(...keys);
      await recordFailure(user);
      audit('password_change_failure', { userId: user.id, username: user.username, ip: ip(req) });
      res.status(401).json({ error: 'Current password is incorrect' });
      return;
    }
    if (passwordTooLong(body.newPassword)) {
      res.status(400).json({ error: `Password must be at most ${MAX_PASSWORD_BYTES} bytes` });
      return;
    }
    if (body.newPassword === body.currentPassword) {
      res.status(400).json({ error: 'Choose a different password' });
      return;
    }
    const passwordHash = await hashPassword(body.newPassword, deps.bcryptCost);
    const out = await store.mutate(user.id, (cur) => ({
      patch: { passwordHash, mustChangePassword: false, sessionVersion: cur.sessionVersion + 1 },
    }));
    mw.invalidate(user.id);
    if (!out.ok || !out.user) {
      res.status(409).json({ error: 'Account changed. Sign in again.' });
      return;
    }
    audit('password_changed', { userId: user.id, username: user.username, ip: ip(req) });
    if (pending) {
      setPendingCookie(res, out.user, 'enroll'); // sessionVersion changed: re-issue, now for enrollment
      res.json({ ok: true, next: 'enroll' });
      return;
    }
    setSessionCookie(res, out.user); // re-issue ours; every other session is now revoked
    res.json({ ok: true });
  });

  r.patch('/me', mw.requireSession, async (req, res) => {
    const body = parseBody(z.object({ displayName: z.string().trim().min(1).max(60) }).strict(), req, res);
    if (!body) return;
    const out = await store.mutate(req.user!.id, () => ({ patch: { displayName: body.displayName, initials: deriveInitials(body.displayName) } }));
    mw.invalidate(req.user!.id);
    if (!out.ok || !out.user) return void res.status(409).json({ error: 'Account changed. Sign in again.' });
    audit('user_updated', { userId: out.user.id, username: out.user.username, actorId: out.user.id, ip: ip(req), changes: ['displayName'] });
    res.json({ authenticated: true, user: toAuthUser(out.user), mustChangePassword: out.user.mustChangePassword });
  });

  r.post('/recovery-codes', mw.requireSession, mw.requirePasswordCurrent, async (req, res) => {
    const body = parseBody(codeSchema, req, res);
    if (!body) return;
    const user = (await store.getById(req.user!.id))!;
    const keys = limitKeys(req);
    if (mfaLimiter.blocked(...keys) || isLocked(user, now())) {
      res.status(429).json({ error: 'Too many attempts. Try again later.' });
      return;
    }
    const codes = generateRecoveryCodes();
    const ok =
      /^\d{6}$/.test(body.code.trim()) && user.totpSecretEnc
        ? await claimTotp(user, user.totpSecretEnc, body.code.trim(), { recoveryCodes: codes.map(hashRecoveryCode) })
        : null;
    if (ok === null) {
      mfaLimiter.fail(...keys);
      await recordFailure(user);
      audit('mfa_failure', { userId: user.id, username: user.username, ip: ip(req), reason: 'recovery_regen' });
      res.status(401).json({ error: 'Invalid code' });
      return;
    }
    audit('recovery_codes_regenerated', { userId: user.id, username: user.username, ip: ip(req) });
    res.json({ recoveryCodes: codes });
  });

  r.post('/logout', (req, res) => {
    const tok = verifySessionToken(req.cookies?.[COOKIE_NAME]);
    clearSessionCookie(res);
    clearPendingCookie(res);
    if (tok) audit('logout', { userId: tok.userId, ip: ip(req) });
    res.json({ ok: true });
  });

  return r;
}

