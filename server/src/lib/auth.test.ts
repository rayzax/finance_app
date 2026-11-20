import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  checkPassword, cookieOptions, createSessionToken, requireCsrfHeader, requireSession,
  SESSION_MAX_AGE_S, verifySessionToken, COOKIE_NAME,
} from './auth';
import { resetConfig } from './config';

const SECRET = 's'.repeat(64);
const PASSWORD = 'correct horse battery staple';
let HASH: string;

const b64url = (s: string) => Buffer.from(s, 'utf8').toString('base64url');

beforeAll(() => {
  HASH = bcrypt.hashSync(PASSWORD, 4); // low cost: this only needs to be a valid bcrypt hash
});

describe('session tokens', () => {
  it('round-trips a token created with the same secret', () => {
    expect(verifySessionToken(createSessionToken(SECRET), SECRET)).toBe(true);
  });

  it('issues HS256 tokens for the owner with a 30-day lifetime', () => {
    const decoded = jwt.decode(createSessionToken(SECRET), { complete: true })!;
    expect(decoded.header.alg).toBe('HS256');
    const p = decoded.payload as jwt.JwtPayload;
    expect(p.sub).toBe('owner');
    expect(p.exp! - p.iat!).toBe(SESSION_MAX_AGE_S);
  });

  it('rejects a missing token or an empty secret', () => {
    expect(verifySessionToken(undefined, SECRET)).toBe(false);
    expect(verifySessionToken('', SECRET)).toBe(false);
    expect(verifySessionToken(createSessionToken(SECRET), '')).toBe(false);
  });

  it('rejects a token signed with a different secret', () => {
    expect(verifySessionToken(createSessionToken('other-secret'), SECRET)).toBe(false);
  });

  it('rejects a tampered payload (sub changed, signature kept)', () => {
    const [h, , s] = createSessionToken(SECRET).split('.');
    const extended = b64url(JSON.stringify({ sub: 'owner', iat: 1, exp: 9999999999 }));
    expect(verifySessionToken(`${h}.${extended}.${s}`, SECRET)).toBe(false); // exp extended, old signature
    const evil = b64url(JSON.stringify({ sub: 'attacker', iat: 1, exp: 9999999999 }));
    expect(verifySessionToken(`${h}.${evil}.${s}`, SECRET)).toBe(false);
  });

  it('rejects an expired token', () => {
    const expired = jwt.sign({ sub: 'owner', exp: Math.floor(Date.now() / 1000) - 10 }, SECRET, { algorithm: 'HS256' });
    expect(verifySessionToken(expired, SECRET)).toBe(false);
  });

  it('rejects an unsigned alg:none token', () => {
    const none = `${b64url(JSON.stringify({ alg: 'none', typ: 'JWT' }))}.${b64url(JSON.stringify({ sub: 'owner' }))}.`;
    expect(verifySessionToken(none, SECRET)).toBe(false);
  });

  it('rejects a validly signed token whose subject is not the owner', () => {
    const other = jwt.sign({ sub: 'someone-else' }, SECRET, { algorithm: 'HS256', expiresIn: 60 });
    expect(verifySessionToken(other, SECRET)).toBe(false);
  });

  it('rejects garbage', () => {
    expect(verifySessionToken('not.a.token', SECRET)).toBe(false);
    expect(verifySessionToken('garbage', SECRET)).toBe(false);
  });

  it('uses the same cookie name the rest of the app expects', () => {
    expect(COOKIE_NAME).toBe('reserve_session');
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

  it('rejects everything when no hash is configured', async () => {
    await expect(checkPassword(PASSWORD, '')).resolves.toBe(false);
  });

  it('returns false instead of throwing for a malformed hash', async () => {
    await expect(checkPassword(PASSWORD, 'not-a-bcrypt-hash')).resolves.toBe(false);
  });
});

describe('requireSession / requireCsrfHeader (unit)', () => {
  const run = (mw: (req: any, res: any, next: () => void) => void, req: any) => {
    const out: { status?: number; body?: unknown; nextCalled: boolean } = { nextCalled: false };
    const res = {
      status(code: number) { out.status = code; return this; },
      json(body: unknown) { out.body = body; return this; },
    };
    mw(req, res, () => { out.nextCalled = true; });
    return out;
  };

  it('requireSession calls next() only with a valid session cookie', () => {
    process.env.SESSION_SECRET = SECRET;
    resetConfig();
    try {
      const ok = run(requireSession as any, { cookies: { [COOKIE_NAME]: createSessionToken() } });
      expect(ok.nextCalled).toBe(true);

      const missing = run(requireSession as any, { cookies: {} });
      expect(missing).toMatchObject({ status: 401, nextCalled: false, body: { error: 'Not authenticated' } });

      const noCookieParser = run(requireSession as any, {});
      expect(noCookieParser).toMatchObject({ status: 401, nextCalled: false });
    } finally {
      delete process.env.SESSION_SECRET;
      resetConfig();
    }
  });

  it('requireCsrfHeader requires X-Requested-With: reserve on state-changing methods only', () => {
    const headers = (v?: string) => ({ get: (n: string) => (n === 'X-Requested-With' ? v : undefined) });
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      expect(run(requireCsrfHeader, { method, ...headers() })).toMatchObject({ status: 403, nextCalled: false });
      expect(run(requireCsrfHeader, { method, ...headers('Reserve') })).toMatchObject({ status: 403, nextCalled: false });
      expect(run(requireCsrfHeader, { method, ...headers('reserve') }).nextCalled).toBe(true);
    }
    expect(run(requireCsrfHeader, { method: 'GET', ...headers() }).nextCalled).toBe(true);
    expect(run(requireCsrfHeader, { method: 'HEAD', ...headers() }).nextCalled).toBe(true);
  });
});
