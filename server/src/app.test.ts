import { createHash } from 'node:crypto';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import request from 'supertest';
import { SignJWT, exportJWK, generateKeyPair, type JWK } from 'jose';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from './app';
import { COOKIE_NAME, createSessionToken } from './lib/auth';
import { resetConfig } from './lib/config';

// Everything here is answered without Firestore: auth and CSRF run before any handler
// touches the database, and the webhook/internal-sync paths use injected dependencies.

const SECRET = 'test-session-secret-'.padEnd(64, 'x');
const PASSWORD = 'correct horse battery staple';
const ENV_KEYS = ['SESSION_SECRET', 'APP_PASSWORD_HASH', 'RUN_SERVICE_URL', 'SCHEDULER_SA_EMAIL', 'PUBLIC_URL', 'NODE_ENV'] as const;
const saved: Record<string, string | undefined> = {};
let HASH: string;

const CSRF = { 'X-Requested-With': 'reserve' };
const cookieHeader = (token = createSessionToken(SECRET)) => `${COOKIE_NAME}=${token}`;
const b64url = (s: string) => Buffer.from(s, 'utf8').toString('base64url');

function setEnv(vars: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>>) {
  for (const [k, v] of Object.entries(vars)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  resetConfig();
}

beforeAll(() => {
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  HASH = bcrypt.hashSync(PASSWORD, 4);
  setEnv({ SESSION_SECRET: SECRET, APP_PASSWORD_HASH: HASH, RUN_SERVICE_URL: undefined, SCHEDULER_SA_EMAIL: undefined, PUBLIC_URL: undefined });
});

afterAll(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  resetConfig();
});

// Fresh app per test: the login rate limiter is per app instance.
let app: ReturnType<typeof createApp>;
beforeEach(() => {
  setEnv({ SESSION_SECRET: SECRET, APP_PASSWORD_HASH: HASH, NODE_ENV: 'test' });
  app = createApp();
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

describe('login', () => {
  it('sets an httpOnly, SameSite=Strict, Path=/ session cookie on success', async () => {
    const res = await request(app).post('/api/auth/login').set(CSRF).send({ password: PASSWORD });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    const cookie = [res.headers['set-cookie']].flat().find((c) => c.startsWith(`${COOKIE_NAME}=`));
    expect(cookie).toBeDefined();
    expect(cookie).toMatch(/;\s*HttpOnly/i);
    expect(cookie).toMatch(/;\s*SameSite=Strict/i);
    expect(cookie).toMatch(/;\s*Path=\//i);
    expect(cookie).not.toMatch(/;\s*Secure/i); // Secure is added in production only; see the production test below
  });

  it('issues a cookie that then authenticates the session', async () => {
    const login = await request(app).post('/api/auth/login').set(CSRF).send({ password: PASSWORD });
    const cookie = [login.headers['set-cookie']].flat().find((c) => c.startsWith(`${COOKIE_NAME}=`))!.split(';')[0];
    const me = await request(app).get('/api/auth/me').set('Cookie', cookie);
    expect(me.status).toBe(200);
    expect(me.body).toEqual({ authenticated: true });
  });

  it('returns the same generic 401 for a wrong password and sets no cookie', async () => {
    const res = await request(app).post('/api/auth/login').set(CSRF).send({ password: 'wrong' });
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: 'Invalid password' });
    expect(res.headers['set-cookie']).toBeUndefined();
  });

  it('gives the same generic 401 when no password hash is configured', async () => {
    setEnv({ APP_PASSWORD_HASH: '' });
    const noHashApp = createApp();
    const res = await request(noHashApp).post('/api/auth/login').set(CSRF).send({ password: PASSWORD });
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: 'Invalid password' });
    setEnv({ APP_PASSWORD_HASH: HASH });
  });

  it('rejects a body with an unknown field or no password with 400', async () => {
    const missing = await request(app).post('/api/auth/login').set(CSRF).send({});
    expect(missing.status).toBe(400);
    const extra = await request(app).post('/api/auth/login').set(CSRF).send({ password: PASSWORD, admin: true });
    expect(extra.status).toBe(400);
  });

  it('requires the CSRF header even with the right password', async () => {
    const res = await request(app).post('/api/auth/login').send({ password: PASSWORD });
    expect(res.status).toBe(403);
    expect(res.headers['set-cookie']).toBeUndefined();
  });

  it('answers malformed JSON with 400 and does not leak parser details', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .set(CSRF)
      .set('Content-Type', 'application/json')
      .send('{"password": ');
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'Invalid request' });
  });

  it('rate-limits after 5 failed attempts: the 6th gets 429, even with the right password', async () => {
    for (let i = 0; i < 5; i++) {
      const r = await request(app).post('/api/auth/login').set(CSRF).send({ password: 'nope' });
      expect(r.status).toBe(401);
    }
    const sixth = await request(app).post('/api/auth/login').set(CSRF).send({ password: 'nope' });
    expect(sixth.status).toBe(429);
    expect(sixth.body).toEqual({ error: 'Too many attempts. Try again later.' });
    const correct = await request(app).post('/api/auth/login').set(CSRF).send({ password: PASSWORD });
    expect(correct.status).toBe(429);
  });

  it('logout clears the cookie and needs the CSRF header', async () => {
    const noHeader = await request(app).post('/api/auth/logout').set('Cookie', cookieHeader());
    expect(noHeader.status).toBe(403);

    const res = await request(app).post('/api/auth/logout').set(CSRF).set('Cookie', cookieHeader());
    expect(res.status).toBe(200);
    const cleared = [res.headers['set-cookie']].flat().find((c) => c.startsWith(`${COOKIE_NAME}=`));
    expect(cleared).toMatch(new RegExp(`^${COOKIE_NAME}=;`));
    expect(cleared).toMatch(/Expires=Thu, 01 Jan 1970/);
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

  it('rejects a missing, tampered, wrong-secret, expired or alg:none cookie with 401', async () => {
    const valid = createSessionToken(SECRET);
    const [h, , s] = valid.split('.');
    const tampered = `${h}.${b64url(JSON.stringify({ sub: 'attacker', iat: 1, exp: 9999999999 }))}.${s}`;
    const wrongSecret = createSessionToken('a-different-secret-that-is-long-enough-to-matter-0000000000000000');
    const expired = jwt.sign({ sub: 'owner', exp: Math.floor(Date.now() / 1000) - 60 }, SECRET, { algorithm: 'HS256' });
    const none = `${b64url(JSON.stringify({ alg: 'none', typ: 'JWT' }))}.${b64url(JSON.stringify({ sub: 'owner' }))}.`;

    for (const token of [tampered, wrongSecret, expired, none, 'garbage']) {
      const res = await request(app).get('/api/categories').set('Cookie', `${COOKIE_NAME}=${token}`);
      expect(res.status, `token ${token.slice(0, 20)}...`).toBe(401);
    }
    const missing = await request(app).get('/api/categories');
    expect(missing.status).toBe(401);
  });

  it('a cookie that is valid for a different server secret does not authenticate', async () => {
    const res = await request(app).get('/api/auth/me').set('Cookie', cookieHeader(createSessionToken('other')));
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
  it('marks the session cookie Secure in production', async () => {
    setEnv({ NODE_ENV: 'production', SESSION_SECRET: SECRET, APP_PASSWORD_HASH: HASH });
    try {
      const prodApp = createApp();
      const res = await request(prodApp).post('/api/auth/login').set(CSRF).send({ password: PASSWORD });
      expect(res.status).toBe(200);
      const cookie = [res.headers['set-cookie']].flat().find((c) => c.startsWith(`${COOKIE_NAME}=`))!;
      expect(cookie).toMatch(/;\s*Secure/i);
      expect(cookie).toMatch(/;\s*HttpOnly/i);
      expect(cookie).toMatch(/;\s*SameSite=Strict/i);
    } finally {
      setEnv({ NODE_ENV: 'test' });
    }
  });

  it('does not mount the dev-only routes in production', async () => {
    setEnv({ NODE_ENV: 'production', SESSION_SECRET: SECRET, APP_PASSWORD_HASH: HASH });
    try {
      const prodApp = createApp();
      const res = await request(prodApp).post('/api/dev/seed').set('Cookie', cookieHeader()).set(CSRF);
      expect(res.status).toBe(404);
    } finally {
      setEnv({ NODE_ENV: 'test' });
    }
  });
});

describe('body limits and error handling', () => {
  it('rejects bodies over 100kb with 400 and a generic message', async () => {
    const big = JSON.stringify({ password: 'x'.repeat(200 * 1024) });
    const res = await request(app).post('/api/auth/login').set(CSRF).set('Content-Type', 'application/json').send(big);
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'Invalid request' });
  });
});

describe('internal sync route (OIDC-verified scheduler)', () => {
  const SCHEDULER = 'scheduler@proj.iam.gserviceaccount.com';

  it('returns 503 when internal sync is not configured', async () => {
    const run = vi.fn(async () => {});
    const res = await request(createApp({ runInternalSync: run })).post('/api/internal/sync').set('Authorization', 'Bearer x');
    expect(res.status).toBe(503);
    expect(run).not.toHaveBeenCalled();
  });

  describe('when configured', () => {
    beforeEach(() => {
      setEnv({ RUN_SERVICE_URL: 'https://run.example', SCHEDULER_SA_EMAIL: SCHEDULER });
    });

    it('rejects a request with no bearer token', async () => {
      const run = vi.fn(async () => {});
      const res = await request(createApp({ runInternalSync: run })).post('/api/internal/sync');
      expect(res.status).toBe(401);
      expect(run).not.toHaveBeenCalled();
    });

    it('rejects a token that verifies but belongs to another service account', async () => {
      const run = vi.fn(async () => {});
      const verifier = vi.fn(async () => ({ email: 'attacker@evil.iam.gserviceaccount.com', email_verified: true }));
      const res = await request(createApp({ oidcVerifier: verifier, runInternalSync: run }))
        .post('/api/internal/sync').set('Authorization', 'Bearer t');
      expect(res.status).toBe(401);
      expect(run).not.toHaveBeenCalled();
    });

    it('rejects an unverified email claim', async () => {
      const run = vi.fn(async () => {});
      const verifier = vi.fn(async () => ({ email: SCHEDULER, email_verified: false }));
      const res = await request(createApp({ oidcVerifier: verifier, runInternalSync: run }))
        .post('/api/internal/sync').set('Authorization', 'Bearer t');
      expect(res.status).toBe(401);
      expect(run).not.toHaveBeenCalled();
    });

    it('rejects when the verifier throws', async () => {
      const run = vi.fn(async () => {});
      const verifier = vi.fn(async () => { throw new Error('bad token'); });
      const res = await request(createApp({ oidcVerifier: verifier, runInternalSync: run }))
        .post('/api/internal/sync').set('Authorization', 'Bearer t');
      expect(res.status).toBe(401);
      expect(run).not.toHaveBeenCalled();
    });

    it('runs the sync for the scheduler service account and audience-checks the token', async () => {
      const run = vi.fn(async () => {});
      const verifier = vi.fn(async () => ({ email: SCHEDULER, email_verified: true }));
      const res = await request(createApp({ oidcVerifier: verifier, runInternalSync: run }))
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

  const webhookApp = () => createApp({ webhook: { getKey: async () => jwk } });

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
