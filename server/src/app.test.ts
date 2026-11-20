import { createHash } from 'node:crypto';
import jwt from 'jsonwebtoken';
import request from 'supertest';
import { SignJWT, exportJWK, generateKeyPair, type JWK } from 'jose';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from './app';
import { COOKIE_NAME, PENDING_COOKIE_NAME, createPendingToken, createSessionToken } from './lib/auth';
import { MemoryUserStore, type StoredUser } from './lib/users';
import {
  BCRYPT_TEST_COST, CSRF, SECRET, baseEnv, restoreEnv, saveEnv, seedUser, sessionCookie, setEnv,
} from './testHelpers';

// Everything here is answered without Firestore: auth and CSRF run against an in-memory user store, and the
// webhook/internal-sync paths use injected dependencies. The full auth flow lives in authFlow.test.ts.

const b64url = (s: string) => Buffer.from(s, 'utf8').toString('base64url');

let store: MemoryUserStore;
let alice: StoredUser;
const cookieHeader = () => sessionCookie(alice);

beforeAll(saveEnv);
afterAll(restoreEnv);

// Fresh app + store per test: rate limiters are per app instance.
let app: ReturnType<typeof createApp>;
const mkApp = (extra: Parameters<typeof createApp>[0] = {}) => createApp({ userStore: store, bcryptCost: BCRYPT_TEST_COST, ...extra });
beforeEach(async () => {
  baseEnv();
  store = new MemoryUserStore();
  alice = (await seedUser(store)).user;
  app = mkApp();
});

describe('public routes', () => {
  it('GET /api/health is public', async () => {
    const res = await request(app).get('/api/health');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });

  it('sends HSTS, a restrictive CSP and hides X-Powered-By', async () => {
    const res = await request(app).get('/api/health');
    expect(res.headers['strict-transport-security']).toContain('max-age=31536000');
    expect(res.headers['content-security-policy']).toContain("frame-ancestors 'none'");
    expect(res.headers['content-security-policy']).toContain('https://cdn.plaid.com');
    expect(res.headers['x-powered-by']).toBeUndefined();
  });
});

describe('logout', () => {
  it('clears both cookies and needs the CSRF header', async () => {
    const noHeader = await request(app).post('/api/auth/logout').set('Cookie', cookieHeader());
    expect(noHeader.status).toBe(403);

    const res = await request(app).post('/api/auth/logout').set(CSRF).set('Cookie', cookieHeader());
    expect(res.status).toBe(200);
    for (const name of [COOKIE_NAME, PENDING_COOKIE_NAME]) {
      const cleared = [res.headers['set-cookie']].flat().find((c) => c.startsWith(`${name}=`));
      expect(cleared, name).toMatch(new RegExp(`^${name}=;`));
      expect(cleared).toMatch(/Expires=Thu, 01 Jan 1970/);
    }
  });
});

describe('session enforcement on protected routes', () => {
  const protectedGets = ['/api/auth/me', '/api/categories', '/api/summary', '/api/accounts', '/api/transactions', '/api/budgets', '/api/cashflow', '/api/goals', '/api/recurring-costs'];

  it.each(protectedGets)('GET %s without a cookie is 401', async (path) => {
    const res = await request(app).get(path);
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: 'Not authenticated' });
  });

  it('new write routes need the CSRF header and validate bodies before touching the database', async () => {
    for (const path of ['/api/goals', '/api/recurring-costs']) {
      const noHeader = await request(app).post(path).set('Cookie', cookieHeader()).send({});
      expect(noHeader.status).toBe(403);
      const bad = await request(app).post(path).set(CSRF).set('Cookie', cookieHeader()).send({ name: '', amount: -1, targetAmount: 0 });
      expect(bad.status).toBe(400);
    }
    const contrib = await request(app).post('/api/goals/abc/contribute').set(CSRF).set('Cookie', cookieHeader()).send({ amount: 0 });
    expect(contrib.status).toBe(400);
  });

  it('a protected route with a valid cookie is reachable (categories needs no database)', async () => {
    const res = await request(app).get('/api/categories').set('Cookie', cookieHeader());
    expect(res.status).toBe(200);
    expect(res.body).toEqual(expect.arrayContaining([{ key: 'groceries', label: 'Groceries' }]));
  });

  it('unknown /api routes without a session are 401, not 404 (no route enumeration)', async () => {
    const res = await request(app).get('/api/does-not-exist');
    expect(res.status).toBe(401);
  });

  it('unknown /api routes with a session are 404', async () => {
    const res = await request(app).get('/api/does-not-exist').set('Cookie', cookieHeader());
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'Not found' });
  });

  it('rejects a missing, tampered, wrong-secret, expired, alg:none or pending-typed cookie with 401', async () => {
    const valid = createSessionToken(alice.id, alice.sessionVersion, SECRET);
    const [h, , sig] = valid.split('.');
    const tampered = `${h}.${b64url(JSON.stringify({ sub: 'attacker', sv: 1, iat: 1, exp: 9999999999 }))}.${sig}`;
    const wrongSecret = createSessionToken(alice.id, alice.sessionVersion, 'a-different-secret-that-is-long-enough-to-matter-0000000000000000');
    const expired = jwt.sign({ sub: alice.id, sv: 1, typ: 'session', exp: Math.floor(Date.now() / 1000) - 60 }, SECRET, { algorithm: 'HS256' });
    const none = `${b64url(JSON.stringify({ alg: 'none', typ: 'JWT' }))}.${b64url(JSON.stringify({ sub: alice.id }))}.`;
    const legacy = jwt.sign({ sub: 'owner' }, SECRET, { algorithm: 'HS256', expiresIn: 60 });
    const pending = createPendingToken(alice.id, 'mfa', alice.sessionVersion, SECRET);

    for (const token of [tampered, wrongSecret, expired, none, legacy, pending, 'garbage']) {
      const res = await request(app).get('/api/categories').set('Cookie', `${COOKIE_NAME}=${token}`);
      expect(res.status, `token ${token.slice(0, 20)}...`).toBe(401);
    }
    const missing = await request(app).get('/api/categories');
    expect(missing.status).toBe(401);
  });

  it('a cookie that is valid for a different server secret does not authenticate', async () => {
    const res = await request(app).get('/api/auth/me').set('Cookie', `${COOKIE_NAME}=${createSessionToken(alice.id, alice.sessionVersion, 'other')}`);
    expect(res.status).toBe(401);
  });
});

describe('CSRF header on state-changing requests', () => {
  // These routes never reach their handlers in the test, because the CSRF check runs first.
  const mutations: [string, string][] = [
    ['POST', '/api/sync'],
    ['PUT', '/api/budgets'],
    ['PATCH', '/api/transactions/abc'],
    ['PATCH', '/api/accounts/abc'],
    ['DELETE', '/api/items/abc'],
    ['POST', '/api/plaid/link-token'],
  ];

  it.each(mutations)('%s %s with a session but no X-Requested-With header is 403', async (method, path) => {
    const res = await (request(app) as any)[method.toLowerCase()](path).set('Cookie', cookieHeader()).send({});
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: 'Missing X-Requested-With header' });
  });

  it('a wrong header value is also rejected', async () => {
    const res = await request(app).post('/api/sync').set('Cookie', cookieHeader()).set('X-Requested-With', 'fetch');
    expect(res.status).toBe(403);
  });

  it('the session check runs before the CSRF check (unauthenticated mutation is 401)', async () => {
    const res = await request(app).delete('/api/items/abc');
    expect(res.status).toBe(401);
  });

  it('GET requests do not need the header', async () => {
    const res = await request(app).get('/api/categories').set('Cookie', cookieHeader());
    expect(res.status).toBe(200);
  });
});

describe('production cookie flags', () => {
  it('marks the pending cookie Secure, HttpOnly and SameSite=Strict in production', async () => {
    baseEnv({ NODE_ENV: 'production' });
    const prodApp = mkApp();
    const res = await request(prodApp).post('/api/auth/login').set(CSRF).send({ username: 'alice', password: 'correct horse battery staple' });
    expect(res.status).toBe(200);
    const cookie = [res.headers['set-cookie']].flat().find((c) => c.startsWith(`${PENDING_COOKIE_NAME}=`))!;
    expect(cookie).toMatch(/;\s*Secure/i);
    expect(cookie).toMatch(/;\s*HttpOnly/i);
    expect(cookie).toMatch(/;\s*SameSite=Strict/i);
  });

  it('does not mount the dev-only routes in production', async () => {
    baseEnv({ NODE_ENV: 'production' });
    const prodApp = mkApp();
    const res = await request(prodApp).post('/api/dev/seed').set('Cookie', cookieHeader()).set(CSRF);
    expect(res.status).toBe(404);
  });
});

describe('body limits and error handling', () => {
  it('rejects bodies over 100kb with 400 and a generic message', async () => {
    const big = JSON.stringify({ username: 'alice', password: 'x'.repeat(200 * 1024) });
    const res = await request(app).post('/api/auth/login').set(CSRF).set('Content-Type', 'application/json').send(big);
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'Invalid request' });
  });
});

describe('internal sync route (OIDC-verified scheduler)', () => {
  const SCHEDULER = 'scheduler@proj.iam.gserviceaccount.com';

  it('returns 503 when internal sync is not configured', async () => {
    const run = vi.fn(async () => {});
    const res = await request(mkApp({ runInternalSync: run })).post('/api/internal/sync').set('Authorization', 'Bearer x');
    expect(res.status).toBe(503);
    expect(run).not.toHaveBeenCalled();
  });

  describe('when configured', () => {
    beforeEach(() => {
      setEnv({ RUN_SERVICE_URL: 'https://run.example', SCHEDULER_SA_EMAIL: SCHEDULER });
    });

    it('rejects a request with no bearer token', async () => {
      const run = vi.fn(async () => {});
      const res = await request(mkApp({ runInternalSync: run })).post('/api/internal/sync');
      expect(res.status).toBe(401);
      expect(run).not.toHaveBeenCalled();
    });

    it('rejects a token that verifies but belongs to another service account', async () => {
      const run = vi.fn(async () => {});
      const verifier = vi.fn(async () => ({ email: 'attacker@evil.iam.gserviceaccount.com', email_verified: true }));
      const res = await request(mkApp({ oidcVerifier: verifier, runInternalSync: run }))
        .post('/api/internal/sync').set('Authorization', 'Bearer t');
      expect(res.status).toBe(401);
      expect(run).not.toHaveBeenCalled();
    });

    it('rejects an unverified email claim', async () => {
      const run = vi.fn(async () => {});
      const verifier = vi.fn(async () => ({ email: SCHEDULER, email_verified: false }));
      const res = await request(mkApp({ oidcVerifier: verifier, runInternalSync: run }))
        .post('/api/internal/sync').set('Authorization', 'Bearer t');
      expect(res.status).toBe(401);
      expect(run).not.toHaveBeenCalled();
    });

    it('rejects when the verifier throws', async () => {
      const run = vi.fn(async () => {});
      const verifier = vi.fn(async () => { throw new Error('bad token'); });
      const res = await request(mkApp({ oidcVerifier: verifier, runInternalSync: run }))
        .post('/api/internal/sync').set('Authorization', 'Bearer t');
      expect(res.status).toBe(401);
      expect(run).not.toHaveBeenCalled();
    });

    it('runs the sync for the scheduler service account and audience-checks the token', async () => {
      const run = vi.fn(async () => {});
      const verifier = vi.fn(async () => ({ email: SCHEDULER, email_verified: true }));
      const res = await request(mkApp({ oidcVerifier: verifier, runInternalSync: run }))
        .post('/api/internal/sync').set('Authorization', 'Bearer good-token');
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ ok: true });
      expect(run).toHaveBeenCalledTimes(1);
      expect(verifier).toHaveBeenCalledWith('good-token', ['https://run.example']);
    });
  });
});

describe('Plaid webhook route (raw body, signature-verified)', () => {
  let signing: Awaited<ReturnType<typeof generateKeyPair>>;
  let jwk: JWK;
  const sha = (s: string) => createHash('sha256').update(Buffer.from(s, 'utf8')).digest('hex');

  beforeAll(async () => {
    signing = await generateKeyPair('ES256');
    jwk = { ...(await exportJWK(signing.publicKey)), kid: 'wh-1', alg: 'ES256', use: 'sig' };
  });

  const webhookApp = () => mkApp({ webhook: { getKey: async () => jwk } });

  const sign = (body: string, claimedBody = body) =>
    new SignJWT({ request_body_sha256: sha(claimedBody) })
      .setProtectedHeader({ alg: 'ES256', kid: 'wh-1' })
      .setIssuedAt(Math.floor(Date.now() / 1000))
      .sign(signing.privateKey);

  it('accepts a correctly signed webhook (no item_id, so no database work)', async () => {
    const body = JSON.stringify({ webhook_type: 'TRANSACTIONS', webhook_code: 'DEFAULT_UPDATE' });
    const res = await request(webhookApp())
      .post('/api/plaid/webhook')
      .set('Content-Type', 'application/json')
      .set('Plaid-Verification', await sign(body))
      .send(body);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });

  it('rejects a webhook with no Plaid-Verification header', async () => {
    const body = JSON.stringify({ webhook_type: 'TRANSACTIONS' });
    const res = await request(webhookApp()).post('/api/plaid/webhook').set('Content-Type', 'application/json').send(body);
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: 'Invalid webhook' });
  });

  it('rejects a webhook whose body was changed after signing', async () => {
    const signedBody = JSON.stringify({ webhook_type: 'TRANSACTIONS', item_id: 'a' });
    const sentBody = JSON.stringify({ webhook_type: 'TRANSACTIONS', item_id: 'b' });
    const res = await request(webhookApp())
      .post('/api/plaid/webhook')
      .set('Content-Type', 'application/json')
      .set('Plaid-Verification', await sign(signedBody))
      .send(sentBody);
    expect(res.status).toBe(401);
  });

  it('rejects a webhook signed by an unknown key', async () => {
    const other = await generateKeyPair('ES256');
    const body = JSON.stringify({ webhook_type: 'TRANSACTIONS' });
    const token = await new SignJWT({ request_body_sha256: sha(body) })
      .setProtectedHeader({ alg: 'ES256', kid: 'wh-1' })
      .setIssuedAt(Math.floor(Date.now() / 1000))
      .sign(other.privateKey);
    const res = await request(webhookApp()).post('/api/plaid/webhook').set('Content-Type', 'application/json').set('Plaid-Verification', token).send(body);
    expect(res.status).toBe(401);
  });

  it('is not behind the session check', async () => {
    const body = JSON.stringify({ webhook_type: 'TRANSACTIONS' });
    const res = await request(webhookApp())
      .post('/api/plaid/webhook')
      .set('Content-Type', 'application/json')
      .set('Plaid-Verification', await sign(body))
      .send(body);
    expect(res.status).toBe(200);
  });
});
