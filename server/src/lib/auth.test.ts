import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  checkPassword, cookieOptions, createAuthMiddleware, createPendingToken, createSessionToken, requireCsrfHeader,
  passwordTooLong, PENDING_MAX_AGE_S, SESSION_MAX_AGE_S, verifyPendingToken, verifySessionToken, COOKIE_NAME,
  PENDING_COOKIE_NAME, USER_CACHE_TTL_MS,
} from './auth';
import { resetConfig } from './config';
import { MemoryUserStore } from './users';
import { baseEnv, restoreEnv, saveEnv, seedUser, SECRET as APP_SECRET } from '../testHelpers';

const SECRET = 's'.repeat(64);
const PASSWORD = 'correct horse battery staple';
let HASH: string;

const b64url = (s: string) => Buffer.from(s, 'utf8').toString('base64url');

beforeAll(() => {
  HASH = bcrypt.hashSync(PASSWORD, 4);
});

describe('session tokens', () => {
  it('round-trips and carries the user id and session version', () => {
    expect(verifySessionToken(createSessionToken('u1', 7, SECRET), SECRET)).toEqual({ userId: 'u1', sv: 7 });
  });

  it('issues HS256 tokens with a 30-day lifetime, typ=session and a session audience', () => {
    const decoded = jwt.decode(createSessionToken('u1', 1, SECRET), { complete: true })!;
    expect(decoded.header.alg).toBe('HS256');
    const p = decoded.payload as jwt.JwtPayload;
    expect(p).toMatchObject({ sub: 'u1', sv: 1, typ: 'session', aud: 'reserve:session', iss: 'reserve' });
    expect(p.exp! - p.iat!).toBe(SESSION_MAX_AGE_S);
  });

  it('rejects a missing token or an empty secret', () => {
    expect(verifySessionToken(undefined, SECRET)).toBeNull();
    expect(verifySessionToken('', SECRET)).toBeNull();
    expect(verifySessionToken(createSessionToken('u1', 1, SECRET), '')).toBeNull();
  });

  it('rejects a token signed with a different secret', () => {
    expect(verifySessionToken(createSessionToken('u1', 1, 'other-secret'), SECRET)).toBeNull();
  });

  it('rejects a tampered payload (signature kept)', () => {
    const [h, , s] = createSessionToken('u1', 1, SECRET).split('.');
    const evil = b64url(JSON.stringify({ sub: 'admin', sv: 1, typ: 'session', iat: 1, exp: 9999999999 }));
    expect(verifySessionToken(`${h}.${evil}.${s}`, SECRET)).toBeNull();
  });

  it('rejects an expired token and an unsigned alg:none token', () => {
    const k = createSessionToken('u1', 1, SECRET); // shape reference only
    expect(k).toBeTruthy();
    const expired = jwt.sign({ sub: 'u1', sv: 1, typ: 'session', exp: Math.floor(Date.now() / 1000) - 10 }, SECRET, { algorithm: 'HS256' });
    expect(verifySessionToken(expired, SECRET)).toBeNull();
    const none = `${b64url(JSON.stringify({ alg: 'none', typ: 'JWT' }))}.${b64url(JSON.stringify({ sub: 'u1', sv: 1, typ: 'session' }))}.`;
    expect(verifySessionToken(none, SECRET)).toBeNull();
  });

  it('rejects the legacy single-owner token', () => {
    expect(verifySessionToken(jwt.sign({ sub: 'owner' }, SECRET, { algorithm: 'HS256', expiresIn: 60 }), SECRET)).toBeNull();
  });

  it('rejects garbage', () => {
    expect(verifySessionToken('not.a.token', SECRET)).toBeNull();
    expect(verifySessionToken('garbage', SECRET)).toBeNull();
  });

  it('uses the cookie names the web expects', () => {
    expect(COOKIE_NAME).toBe('reserve_session');
    expect(PENDING_COOKIE_NAME).toBe('reserve_pending');
  });
});

describe('pending tokens', () => {
  it('round-trips with the stage and lives 5 minutes', () => {
    const t = createPendingToken('u1', 'enroll', 3, SECRET);
    expect(verifyPendingToken(t, SECRET)).toEqual({ userId: 'u1', sv: 3, stage: 'enroll' });
    const p = jwt.decode(t) as jwt.JwtPayload;
    expect(p).toMatchObject({ typ: 'pending', aud: 'reserve:pending' });
    expect(p.exp! - p.iat!).toBe(PENDING_MAX_AGE_S);
    expect(PENDING_MAX_AGE_S).toBe(300);
  });

  it('is never a session and a session is never pending', () => {
    expect(verifySessionToken(createPendingToken('u1', 'mfa', 1, SECRET), SECRET)).toBeNull();
    expect(verifyPendingToken(createSessionToken('u1', 1, SECRET), SECRET)).toBeNull();
  });

  it('is not accepted even when forged with the session signing context claims', () => {
    // same secret, same claims shape as a session, but a pending-typed key: still not a session
    const forged = jwt.sign({ sv: 1, typ: 'session' }, SECRET, { algorithm: 'HS256', subject: 'u1', audience: 'reserve:session', issuer: 'reserve', expiresIn: 60 });
    expect(verifySessionToken(forged, SECRET)).toBeNull(); // raw secret != derived key
  });

  it('rejects an expired pending token', () => {
    expect(verifyPendingToken(createPendingToken('u1', 'mfa', 1, SECRET, -5), SECRET)).toBeNull();
  });

  it('rejects an unknown stage', () => {
    const k = createPendingToken('u1', 'mfa', 1, SECRET);
    const [h, p, s] = k.split('.');
    const body = JSON.parse(Buffer.from(p, 'base64url').toString());
    body.stage = 'admin';
    expect(verifyPendingToken(`${h}.${b64url(JSON.stringify(body))}.${s}`, SECRET)).toBeNull();
  });
});

describe('cookieOptions', () => {
  const original = process.env.NODE_ENV;
  afterAll(() => {
    process.env.NODE_ENV = original;
    resetConfig();
  });

  it('is httpOnly, SameSite=Strict and path-scoped', () => {
    process.env.NODE_ENV = 'production';
    resetConfig();
    expect(cookieOptions()).toMatchObject({ httpOnly: true, sameSite: 'strict', path: '/', secure: true });
  });

  it('is not Secure outside production (local http development)', () => {
    process.env.NODE_ENV = 'development';
    resetConfig();
    expect(cookieOptions()).toMatchObject({ httpOnly: true, sameSite: 'strict', path: '/', secure: false });
  });
});

describe('checkPassword', () => {
  it('accepts the right password', async () => {
    await expect(checkPassword(PASSWORD, HASH)).resolves.toBe(true);
  });

  it('rejects a wrong password, including near misses', async () => {
    await expect(checkPassword('wrong', HASH)).resolves.toBe(false);
    await expect(checkPassword(PASSWORD.toUpperCase(), HASH)).resolves.toBe(false);
    await expect(checkPassword('', HASH)).resolves.toBe(false);
  });

  it('rejects everything when there is no hash (still burns one compare)', async () => {
    await expect(checkPassword(PASSWORD, '')).resolves.toBe(false);
    await expect(checkPassword(PASSWORD, undefined)).resolves.toBe(false);
  });

  it('returns false instead of throwing for a malformed hash', async () => {
    await expect(checkPassword(PASSWORD, 'not-a-bcrypt-hash')).resolves.toBe(false);
  });

  it('flags passwords over bcrypt\'s 72-byte limit', () => {
    expect(passwordTooLong('a'.repeat(72))).toBe(false);
    expect(passwordTooLong('a'.repeat(73))).toBe(true);
    expect(passwordTooLong('é'.repeat(37))).toBe(true);
  });
});

const run = async (mw: (req: any, res: any, next: () => void) => any, req: any) => {
  const out: { status?: number; body?: unknown; nextCalled: boolean; locals: Record<string, unknown> } = { nextCalled: false, locals: {} };
  const res = {
    locals: out.locals,
    status(code: number) { out.status = code; return this; },
    json(body: unknown) { out.body = body; return this; },
  };
  await mw(req, res, () => { out.nextCalled = true; });
  return out;
};

describe('requireCsrfHeader (unit)', () => {
  it('requires X-Requested-With: reserve on state-changing methods only', async () => {
    const headers = (v?: string) => ({ get: (n: string) => (n === 'X-Requested-With' ? v : undefined) });
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      expect(await run(requireCsrfHeader, { method, ...headers() })).toMatchObject({ status: 403, nextCalled: false });
      expect(await run(requireCsrfHeader, { method, ...headers('Reserve') })).toMatchObject({ status: 403, nextCalled: false });
      expect((await run(requireCsrfHeader, { method, ...headers('reserve') })).nextCalled).toBe(true);
    }
    expect((await run(requireCsrfHeader, { method: 'GET', ...headers() })).nextCalled).toBe(true);
    expect((await run(requireCsrfHeader, { method: 'HEAD', ...headers() })).nextCalled).toBe(true);
  });
});

describe('createAuthMiddleware', () => {
  beforeAll(saveEnv);
  afterAll(restoreEnv);

  it('loads the user, rejects revoked/disabled/no-MFA, and caches for at most 30s', async () => {
    baseEnv();
    const store = new MemoryUserStore();
    let t = 1_000_000;
    const mw = createAuthMiddleware(store, () => t);
    const { user } = await seedUser(store);
    const cookies = { [COOKIE_NAME]: createSessionToken(user.id, user.sessionVersion, APP_SECRET) };

    const ok = await run(mw.requireSession, { cookies });
    expect(ok.nextCalled).toBe(true);

    // disabled directly in the store: still served from the cache until the TTL passes...
    await store.mutate(user.id, () => ({ patch: { disabled: true } }));
    expect((await run(mw.requireSession, { cookies })).nextCalled).toBe(true);
    t += USER_CACHE_TTL_MS + 1;
    expect(await run(mw.requireSession, { cookies })).toMatchObject({ status: 401, nextCalled: false });

    // ...and invalidate() applies a change immediately.
    await store.mutate(user.id, () => ({ patch: { disabled: false } }));
    mw.invalidate(user.id);
    expect((await run(mw.requireSession, { cookies })).nextCalled).toBe(true);

    await store.mutate(user.id, () => ({ patch: { totpEnabled: false } }));
    mw.invalidate(user.id);
    expect((await run(mw.requireSession, { cookies })).status).toBe(401);
    await store.mutate(user.id, () => ({ patch: { totpEnabled: true, sessionVersion: 2 } }));
    mw.invalidate(user.id);
    expect((await run(mw.requireSession, { cookies })).status).toBe(401);
    expect(await run(mw.requireSession, {})).toMatchObject({ status: 401, body: { error: 'Not authenticated' } });
  });
});
