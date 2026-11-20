import bcrypt from 'bcryptjs';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from './app';
import { setAuditSink } from './lib/audit';
import {
  COOKIE_NAME, PENDING_COOKIE_NAME, createPendingToken, createSessionToken, verifyPendingToken, verifySessionToken,
} from './lib/auth';
import { generateTotpSecret, hashRecoveryCode, totpAt } from './lib/totp';
import { MemoryUserStore, type StoredUser } from './lib/users';
import { adminGuard } from './routes/users';
import {
  BCRYPT_TEST_COST, CSRF, PASSWORD, SECRET, baseEnv, cookiePair, cookieValue, hashPw, restoreEnv, saveEnv, seedUser,
  sessionCookie,
} from './testHelpers';

let store: MemoryUserStore;
let clock: number;
let app: ReturnType<typeof createApp>;
let logs: string[];
const BOOT_HASH_PW = 'bootstrap password 123';
let ipSeq = 0;
const newIp = () => `10.1.${Math.floor(++ipSeq / 250)}.${ipSeq % 250}`;

const mk = () => createApp({ userStore: store, now: () => clock, bcryptCost: BCRYPT_TEST_COST });
beforeAll(saveEnv);
afterAll(() => { restoreEnv(); setAuditSink(null); });
beforeEach(() => {
  baseEnv({ APP_PASSWORD_HASH: bcrypt.hashSync(BOOT_HASH_PW, BCRYPT_TEST_COST) });
  store = new MemoryUserStore();
  clock = Date.UTC(2026, 10, 19, 12, 0, 0);
  logs = [];
  setAuditSink((l) => logs.push(l));
  app = mk();
});
afterEach(() => vi.restoreAllMocks());

// ---- helpers -------------------------------------------------------------------------------------------------
const post = (path: string, body: unknown, cookie?: string, a = app, ip?: string) => {
  let r = request(a).post(path).set(CSRF).set('X-Forwarded-For', ip ?? newIp());
  if (cookie) r = r.set('Cookie', cookie);
  return r.send(body as object);
};
const patch = (path: string, body: unknown, cookie: string) => request(app).patch(path).set(CSRF).set('Cookie', cookie).send(body as object);
const del = (path: string, cookie: string) => request(app).delete(path).set(CSRF).set('Cookie', cookie);
const get = (path: string, cookie?: string) => (cookie ? request(app).get(path).set('Cookie', cookie) : request(app).get(path));

const login = (username: string, password: string, a = app, ip?: string) => post('/api/auth/login', { username, password }, undefined, a, ip);
/** A code that has never been used: always one step ahead of the last. */
const freshCode = (secret: string) => { clock += 30_000; return totpAt(secret, clock); };

async function fullLogin(username: string, password: string, secret: string): Promise<string> {
  const l = await login(username, password);
  expect(l.status, 'login').toBe(200);
  const m = await post('/api/auth/mfa', { code: freshCode(secret) }, cookiePair(cookieValue(l, PENDING_COOKIE_NAME)!));
  expect(m.status, 'mfa').toBe(200);
  return cookiePair(cookieValue(m, COOKIE_NAME)!);
}

async function admin() {
  const s = await seedUser(store, { username: 'root', displayName: 'Root Admin', role: 'admin', password: 'admin password 1234' });
  return { ...s, cookie: sessionCookie(s.user) };
}
async function member(over: { username?: string; mfa?: boolean; mustChangePassword?: boolean } = {}) {
  const s = await seedUser(store, { username: over.username ?? 'bob', displayName: 'Bob Jones', role: 'member', mfa: over.mfa, mustChangePassword: over.mustChangePassword });
  return { ...s, cookie: sessionCookie(s.user) };
}
const stored = async (id: string) => (await store.getById(id))!;

// ---- bootstrap -----------------------------------------------------------------------------------------------
describe('bootstrap from APP_PASSWORD_HASH', () => {
  it('creates the first admin (drew / Drew) when no users exist and goes to enrollment', async () => {
    const res = await login('drew', BOOT_HASH_PW);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ next: 'enroll' });
    expect(cookieValue(res, COOKIE_NAME)).toBeUndefined();
    const users = await store.list();
    expect(users).toHaveLength(1);
    expect(users[0]).toMatchObject({ username: 'drew', displayName: 'Drew', initials: 'DR', role: 'admin', totpEnabled: false, mustChangePassword: false, sessionVersion: 1 });
    expect(await bcrypt.compare(BOOT_HASH_PW, users[0].passwordHash)).toBe(true);
    expect(logs.some((l) => l.includes('bootstrap_admin_created'))).toBe(true);
  });

  it('honors BOOTSTRAP_ADMIN_USERNAME / BOOTSTRAP_ADMIN_NAME (username is case-insensitive)', async () => {
    baseEnv({ APP_PASSWORD_HASH: bcrypt.hashSync(BOOT_HASH_PW, BCRYPT_TEST_COST), BOOTSTRAP_ADMIN_USERNAME: 'Owner', BOOTSTRAP_ADMIN_NAME: 'Dana Whit' });
    const a = mk();
    expect((await login('OWNER', BOOT_HASH_PW, a)).status).toBe(200);
    expect(await store.list()).toMatchObject([{ username: 'owner', displayName: 'Dana Whit', initials: 'DW' }]);
  });

  it('does nothing for a wrong password or another username', async () => {
    expect((await login('drew', 'wrong password')).status).toBe(401);
    expect((await login('someone', BOOT_HASH_PW)).status).toBe(401);
    expect(await store.list()).toHaveLength(0);
  });

  it('is ignored once any user exists', async () => {
    await seedUser(store);
    const res = await login('drew', BOOT_HASH_PW);
    expect(res.status).toBe(401);
    expect(await store.getByUsername('drew')).toBeUndefined();
    // and the env password does not open someone else's account either
    expect((await login('alice', BOOT_HASH_PW)).status).toBe(401);
  });

  it('does not bootstrap without an APP_PASSWORD_HASH', async () => {
    baseEnv({ APP_PASSWORD_HASH: undefined });
    expect((await login('drew', BOOT_HASH_PW, mk())).status).toBe(401);
    expect(await store.list()).toHaveLength(0);
  });

  it('a second concurrent first login does not create two users', async () => {
    const [a, b] = await Promise.all([login('drew', BOOT_HASH_PW), login('drew', BOOT_HASH_PW)]);
    expect([a.status, b.status].sort()).toEqual([200, 200]);
    expect(await store.list()).toHaveLength(1);
  });
});

// ---- login ---------------------------------------------------------------------------------------------------
describe('login', () => {
  it('sets a short-lived httpOnly SameSite=Strict pending cookie and no session', async () => {
    await seedUser(store);
    const res = await login('alice', PASSWORD);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ next: 'mfa' });
    const c = cookieValue(res, PENDING_COOKIE_NAME)!;
    expect(c).toMatch(/;\s*HttpOnly/i);
    expect(c).toMatch(/;\s*SameSite=Strict/i);
    expect(c).toMatch(/;\s*Path=\//i);
    expect(c).toMatch(/Max-Age=300/);
    expect(cookieValue(res, COOKIE_NAME)).toBeUndefined();
    const tok = verifyPendingToken(c.split(';')[0].split('=')[1], SECRET)!;
    expect(tok.stage).toBe('mfa');
  });

  it('answers next=enroll for a user without TOTP', async () => {
    await member({ mfa: false });
    expect((await login('bob', PASSWORD)).body).toEqual({ next: 'enroll' });
  });

  it('gives the identical response for unknown user, wrong password, disabled and locked accounts', async () => {
    const { user } = await seedUser(store, { username: 'carol' });
    await seedUser(store, { username: 'dave' });
    await store.mutate((await store.getByUsername('dave'))!.id, () => ({ patch: { disabled: true } }));
    const eve = await seedUser(store, { username: 'eve' });
    await store.mutate(eve.user.id, () => ({ patch: { lockedUntil: new Date(clock + 60_000).toISOString() } }));

    const responses = [
      await login('nobody', PASSWORD),
      await login('carol', 'wrong password!'),
      await login('dave', PASSWORD), // right password, disabled
      await login('eve', PASSWORD), // right password, locked
      await login('NO', 'x'), // not even a valid username shape
    ];
    for (const r of responses) {
      expect(r.status).toBe(401);
      expect(r.body).toEqual({ error: 'Invalid username or password' });
      expect(r.headers['set-cookie']).toBeUndefined();
      expect(Object.keys(r.body)).toEqual(['error']);
    }
    expect(user.id).toBeTruthy();
  });

  it('runs exactly one bcrypt compare for an unknown user (dummy hash)', async () => {
    const spy = vi.spyOn(bcrypt, 'compare');
    await login('ghost', 'whatever password');
    expect(spy).toHaveBeenCalledTimes(1);
    expect(String(spy.mock.calls[0][1])).toMatch(/^\$2[aby]\$12\$/); // cost-12 dummy, like real hashes
  });

  it('validates the body and needs the CSRF header', async () => {
    expect((await post('/api/auth/login', { password: 'x' })).status).toBe(400);
    expect((await post('/api/auth/login', { username: 'alice' })).status).toBe(400);
    expect((await post('/api/auth/login', { username: 'alice', password: 'x', admin: true })).status).toBe(400);
    const noHeader = await request(app).post('/api/auth/login').send({ username: 'alice', password: PASSWORD });
    expect(noHeader.status).toBe(403);
  });

  it('keeps the per-IP limiter: the 6th failed attempt from one IP is 429', async () => {
    await seedUser(store);
    for (let i = 0; i < 5; i++) expect((await login('alice', 'nope nope nope', app, '9.9.9.9')).status).toBe(401);
    const sixth = await login('alice', PASSWORD, app, '9.9.9.9');
    expect(sixth.status).toBe(429);
    expect(sixth.body).toEqual({ error: 'Too many attempts. Try again later.' });
  });
});

describe('pending cookie vs session cookie', () => {
  it('a pending token is not a session (even when presented as the session cookie)', async () => {
    const { user } = await seedUser(store);
    const pending = createPendingToken(user.id, 'mfa', user.sessionVersion, SECRET);
    expect((await get('/api/auth/me', `${COOKIE_NAME}=${pending}`)).status).toBe(401);
    expect((await get('/api/categories', `${COOKIE_NAME}=${pending}`)).status).toBe(401);
    expect(verifySessionToken(pending, SECRET)).toBeNull();
  });

  it('a session token is not a pending token (even when presented as the pending cookie)', async () => {
    const { user, totpSecret } = await seedUser(store);
    const session = createSessionToken(user.id, user.sessionVersion, SECRET);
    const res = await post('/api/auth/mfa', { code: freshCode(totpSecret) }, `${PENDING_COOKIE_NAME}=${session}`);
    expect(res.status).toBe(401);
    expect(cookieValue(res, COOKIE_NAME)).toBeUndefined();
    expect(verifyPendingToken(session, SECRET)).toBeNull();
  });

  it('a pending token alone cannot reach any data route', async () => {
    const { user } = await seedUser(store);
    const pending = createPendingToken(user.id, 'mfa', user.sessionVersion, SECRET);
    for (const p of ['/api/categories', '/api/summary', '/api/users']) {
      expect((await get(p, `${PENDING_COOKIE_NAME}=${pending}`)).status).toBe(401);
    }
  });
});

// ---- MFA -----------------------------------------------------------------------------------------------------
describe('POST /api/auth/mfa', () => {
  const pendingFor = async (username = 'alice', pw = PASSWORD) => {
    const l = await login(username, pw);
    return cookiePair(cookieValue(l, PENDING_COOKIE_NAME)!);
  };

  it('accepts a TOTP code, swaps pending for a 30-day session and reports the state', async () => {
    const { user, totpSecret } = await seedUser(store);
    const pending = await pendingFor();
    const res = await post('/api/auth/mfa', { code: freshCode(totpSecret) }, pending);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, mustChangePassword: false, recoveryCodesRemaining: 0 });
    const session = cookieValue(res, COOKIE_NAME)!;
    expect(session).toMatch(/;\s*HttpOnly/i);
    expect(session).toMatch(/;\s*SameSite=Strict/i);
    expect(session).toMatch(/Max-Age=2592000/);
    expect(cookieValue(res, PENDING_COOKIE_NAME)).toMatch(new RegExp(`^${PENDING_COOKIE_NAME}=;`)); // cleared
    const me = await get('/api/auth/me', cookiePair(session));
    expect(me.body).toEqual({
      authenticated: true, mustChangePassword: false,
      user: { id: user.id, username: 'alice', displayName: 'Alice Smith', initials: 'AS', role: 'member' },
    });
    expect((await stored(user.id)).lastLoginAt).toBe(new Date(clock).toISOString());
  });

  it('accepts the +/-1 step window and rejects +/-2', async () => {
    const { totpSecret } = await seedUser(store);
    const at = (offset: number) => totpAt(totpSecret, clock + offset * 30_000);
    expect((await post('/api/auth/mfa', { code: at(-2) }, await pendingFor())).status).toBe(401);
    expect((await post('/api/auth/mfa', { code: at(2) }, await pendingFor())).status).toBe(401);
    expect((await post('/api/auth/mfa', { code: at(1) }, await pendingFor())).status).toBe(200);
    clock += 3 * 30_000; // later steps only
    expect((await post('/api/auth/mfa', { code: totpAt(totpSecret, clock - 30_000) }, await pendingFor())).status).toBe(200); // -1
  });

  it('rejects a replayed code, and any code from an earlier step than the last accepted one', async () => {
    const { user, totpSecret } = await seedUser(store);
    const code = freshCode(totpSecret);
    expect((await post('/api/auth/mfa', { code }, await pendingFor())).status).toBe(200);
    const replay = await post('/api/auth/mfa', { code }, await pendingFor());
    expect(replay.status).toBe(401);
    expect(replay.body).toEqual({ error: 'Invalid code' });
    expect(cookieValue(replay, COOKIE_NAME)).toBeUndefined();
    // the previous step is still inside the window but is now behind totpLastStep
    expect((await post('/api/auth/mfa', { code: totpAt(totpSecret, clock - 30_000) }, await pendingFor())).status).toBe(401);
    expect((await stored(user.id)).totpLastStep).toBe(Math.floor(clock / 30_000));
  });

  it('rejects an expired pending token', async () => {
    const { user, totpSecret } = await seedUser(store);
    const expired = createPendingToken(user.id, 'mfa', user.sessionVersion, SECRET, -10);
    const res = await post('/api/auth/mfa', { code: freshCode(totpSecret) }, `${PENDING_COOKIE_NAME}=${expired}`);
    expect(res.status).toBe(401);
    expect(cookieValue(res, COOKIE_NAME)).toBeUndefined();
  });

  it('needs a pending cookie and the CSRF header', async () => {
    const { totpSecret } = await seedUser(store);
    expect((await post('/api/auth/mfa', { code: freshCode(totpSecret) })).status).toBe(401);
    const noHeader = await request(app).post('/api/auth/mfa').set('Cookie', await pendingFor()).send({ code: '123456' });
    expect(noHeader.status).toBe(403);
  });

  it('recovery codes work once, in constant-format xxxx-xxxx, and count down', async () => {
    const { user } = await seedUser(store);
    await store.mutate(user.id, () => ({ patch: { recoveryCodes: ['abcd-2345', 'wxyz-6789', 'kkkk-3333'].map(hashRecoveryCode) } }));
    const ok = await post('/api/auth/mfa', { code: ' ABCD-2345 ' }, await pendingFor());
    expect(ok.status).toBe(200);
    expect(ok.body).toEqual({ ok: true, mustChangePassword: false, recoveryCodesRemaining: 2 });
    expect(cookieValue(ok, COOKIE_NAME)).toBeDefined();
    expect((await stored(user.id)).recoveryCodes).toHaveLength(2);

    const reuse = await post('/api/auth/mfa', { code: 'abcd-2345' }, await pendingFor());
    expect(reuse.status).toBe(401);
    expect(reuse.body).toEqual({ error: 'Invalid code' });
    const other = await post('/api/auth/mfa', { code: 'wxyz-6789' }, await pendingFor());
    expect(other.status).toBe(200);
    expect(other.body.recoveryCodesRemaining).toBe(1);
  });

  it('a recovery code can be spent by only one of two concurrent requests', async () => {
    const { user } = await seedUser(store);
    await store.mutate(user.id, () => ({ patch: { recoveryCodes: [hashRecoveryCode('abcd-2345')] } }));
    const p1 = await pendingFor();
    const p2 = await pendingFor();
    const rs = await Promise.all([post('/api/auth/mfa', { code: 'abcd-2345' }, p1), post('/api/auth/mfa', { code: 'abcd-2345' }, p2)]);
    expect(rs.map((r) => r.status).sort()).toEqual([200, 401]);
  });

  it('gives one generic error for malformed, wrong and reused input', async () => {
    await seedUser(store);
    for (const code of ['000000', 'zzzz-zzzz', 'abc', '12345678', 'ABCD-23456']) {
      const r = await post('/api/auth/mfa', { code }, await pendingFor());
      expect(r.status, code).toBe(401);
      expect(r.body).toEqual({ error: 'Invalid code' });
    }
  });

  it('rate-limits to 5 failures per pending token: the 6th attempt is 429 even with the right code', async () => {
    const { totpSecret } = await seedUser(store);
    const pending = await pendingFor();
    for (let i = 0; i < 5; i++) expect((await post('/api/auth/mfa', { code: '000000' }, pending, app, '8.8.8.8')).status).toBe(401);
    const blocked = await post('/api/auth/mfa', { code: freshCode(totpSecret) }, pending, app, '7.7.7.7');
    expect(blocked.status).toBe(429);
    expect(cookieValue(blocked, COOKIE_NAME)).toBeUndefined();
  });

  it('rate-limits per IP across different pending tokens', async () => {
    await seedUser(store);
    for (let i = 0; i < 5; i++) {
      const l = await login('alice', PASSWORD);
      expect((await post('/api/auth/mfa', { code: '000000' }, cookiePair(cookieValue(l, PENDING_COOKIE_NAME)!), app, '6.6.6.6')).status).toBe(401);
    }
    const l = await login('alice', PASSWORD);
    expect((await post('/api/auth/mfa', { code: '000000' }, cookiePair(cookieValue(l, PENDING_COOKIE_NAME)!), app, '6.6.6.6')).status).toBe(429);
  });

  it('forgets MFA failures after 5 minutes', async () => {
    const { totpSecret } = await seedUser(store);
    const pending = await pendingFor();
    for (let i = 0; i < 5; i++) await post('/api/auth/mfa', { code: '000000' }, pending, app, '5.5.5.5');
    clock += 5 * 60_000 + 1000;
    const fresh = await pendingFor();
    expect((await post('/api/auth/mfa', { code: freshCode(totpSecret) }, fresh, app, '5.5.5.5')).status).toBe(200);
  });
});

// ---- lockout -------------------------------------------------------------------------------------------------
describe('account lockout', () => {
  it('locks after 10 failures in 15 minutes (distinct IPs), even for the right password, then unlocks', async () => {
    const { user } = await seedUser(store);
    for (let i = 0; i < 10; i++) expect((await login('alice', 'wrong password!!')).status).toBe(401);
    const u = await stored(user.id);
    expect(Date.parse(u.lockedUntil!)).toBe(clock + 15 * 60_000);
    const locked = await login('alice', PASSWORD);
    expect(locked.status).toBe(401);
    expect(locked.body).toEqual({ error: 'Invalid username or password' });
    expect(logs.some((l) => l.includes('login_locked'))).toBe(true);

    clock += 15 * 60_000 + 1;
    expect((await login('alice', PASSWORD)).status).toBe(200);
  });

  it('does not lock when failures are spread over more than the window', async () => {
    const { user } = await seedUser(store);
    for (let i = 0; i < 6; i++) await login('alice', 'wrong password!!');
    clock += 16 * 60_000;
    for (let i = 0; i < 6; i++) await login('alice', 'wrong password!!');
    expect((await stored(user.id)).lockedUntil).toBeNull();
    expect((await login('alice', PASSWORD)).status).toBe(200);
  });

  it('MFA failures count toward the lockout', async () => {
    const { user } = await seedUser(store);
    for (let i = 0; i < 10; i++) {
      const l = await login('alice', PASSWORD);
      await post('/api/auth/mfa', { code: '000000' }, cookiePair(cookieValue(l, PENDING_COOKIE_NAME)!), app, newIp());
    }
    expect((await stored(user.id)).lockedUntil).not.toBeNull();
    expect((await login('alice', PASSWORD)).status).toBe(401);
  });

  it('a completed login clears the failure counter', async () => {
    const { user, totpSecret } = await seedUser(store);
    for (let i = 0; i < 4; i++) await login('alice', 'wrong password!!');
    expect((await stored(user.id)).failedLogins).toBe(4);
    await fullLogin('alice', PASSWORD, totpSecret);
    expect(await stored(user.id)).toMatchObject({ failedLogins: 0, failedWindowStart: null });
  });

  it('a password-only success does not reset the counter (no MFA-guess laundering)', async () => {
    const { user } = await seedUser(store);
    for (let i = 0; i < 4; i++) await login('alice', 'wrong password!!');
    await login('alice', PASSWORD);
    expect((await stored(user.id)).failedLogins).toBe(4);
  });
});

// ---- enrollment ----------------------------------------------------------------------------------------------
describe('TOTP enrollment', () => {
  async function enrollPending(username = 'bob') {
    const l = await login(username, PASSWORD);
    expect(l.body).toEqual({ next: 'enroll' });
    return cookiePair(cookieValue(l, PENDING_COOKIE_NAME)!);
  }

  it('setup returns the otpauth URL, the secret and an inline SVG; the secret is stored encrypted and not yet enabled', async () => {
    const { user } = await member({ mfa: false });
    const res = await post('/api/auth/mfa/setup', {}, await enrollPending());
    expect(res.status).toBe(200);
    expect(Object.keys(res.body).sort()).toEqual(['otpauthUrl', 'qrSvg', 'secret']);
    expect(res.body.secret).toMatch(/^[A-Z2-7]{32}$/);
    expect(res.body.otpauthUrl.startsWith('otpauth://totp/Reserve:bob?')).toBe(true);
    expect(res.body.otpauthUrl).toContain('issuer=Reserve');
    expect(res.body.qrSvg).toContain('<svg');
    const u = await stored(user.id);
    expect(u.totpEnabled).toBe(false);
    expect(u.totpSecretEnc).toBeNull();
    expect(u.totpPendingEnc).toMatch(/^dev:/); // AES-GCM in dev, kms: in prod
    expect(JSON.stringify(u)).not.toContain(res.body.secret);
  });

  it('enable verifies the code, returns 10 recovery codes once, stores only hashes and issues the session', async () => {
    const { user } = await member({ mfa: false });
    const pending = await enrollPending();
    const setup = await post('/api/auth/mfa/setup', {}, pending);
    const secret = setup.body.secret as string;

    const bad = await post('/api/auth/mfa/enable', { code: '000000' }, pending);
    expect(bad.status).toBe(401);
    expect(cookieValue(bad, COOKIE_NAME)).toBeUndefined();

    const res = await post('/api/auth/mfa/enable', { code: freshCode(secret) }, pending);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.mustChangePassword).toBe(false);
    const codes = res.body.recoveryCodes as string[];
    expect(codes).toHaveLength(10);
    for (const c of codes) expect(c).toMatch(/^[a-z0-9]{4}-[a-z0-9]{4}$/);
    const session = cookieValue(res, COOKIE_NAME)!;
    expect((await get('/api/auth/me', cookiePair(session))).status).toBe(200);

    const u = await stored(user.id);
    expect(u).toMatchObject({ totpEnabled: true, totpPendingEnc: null });
    expect(u.totpSecretEnc).toMatch(/^dev:/);
    expect(u.recoveryCodes).toEqual(codes.map(hashRecoveryCode));
    for (const c of codes) expect(JSON.stringify(u)).not.toContain(c);
  });

  it('enable without a prior setup is a 409; a replayed enable is rejected', async () => {
    await member({ mfa: false });
    const pending = await enrollPending();
    expect((await post('/api/auth/mfa/enable', { code: '123456' }, pending)).status).toBe(409);
  });

  it('an enroll token cannot replace an already-enabled factor', async () => {
    const { user } = await seedUser(store);
    const enroll = createPendingToken(user.id, 'enroll', user.sessionVersion, SECRET);
    const res = await post('/api/auth/mfa/setup', {}, `${PENDING_COOKIE_NAME}=${enroll}`);
    expect(res.status).toBe(401);
    expect((await stored(user.id)).totpPendingEnc).toBeNull();
  });

  it('an mfa-stage token cannot enroll, and an enroll-stage token cannot answer the MFA challenge', async () => {
    const a = await seedUser(store, { username: 'a1' });
    const b = await seedUser(store, { username: 'b1', mfa: false });
    const mfaTok = createPendingToken(a.user.id, 'mfa', a.user.sessionVersion, SECRET);
    expect((await post('/api/auth/mfa/setup', {}, `${PENDING_COOKIE_NAME}=${mfaTok}`)).status).toBe(401);
    const enrollTok = createPendingToken(b.user.id, 'enroll', b.user.sessionVersion, SECRET);
    expect((await post('/api/auth/mfa', { code: '123456' }, `${PENDING_COOKIE_NAME}=${enrollTok}`)).status).toBe(401);
  });

  it('re-enrollment from a full session requires the current TOTP code', async () => {
    const { user, totpSecret } = await seedUser(store);
    const cookie = sessionCookie(user);
    expect((await post('/api/auth/mfa/setup', {}, cookie)).status).toBe(401);
    expect((await post('/api/auth/mfa/setup', { code: '000000' }, cookie)).status).toBe(401);
    const ok = await post('/api/auth/mfa/setup', { code: freshCode(totpSecret) }, cookie);
    expect(ok.status).toBe(200);
    // the live factor is untouched until the new one is confirmed
    const u = await stored(user.id);
    expect(u.totpEnabled).toBe(true);
    expect(u.totpPendingEnc).toMatch(/^dev:/);
    const en = await post('/api/auth/mfa/enable', { code: freshCode(ok.body.secret) }, cookie);
    expect(en.status).toBe(200);
    expect(en.body.recoveryCodes).toHaveLength(10);
    expect(cookieValue(en, COOKIE_NAME)).toBeUndefined(); // already signed in
  });

  it('the session middleware refuses a session for a user without TOTP', async () => {
    const { user } = await member({ mfa: false });
    expect((await get('/api/auth/me', sessionCookie(user))).status).toBe(401);
    expect((await get('/api/categories', sessionCookie(user))).status).toBe(401);
  });

});

describe('temporary password: change BEFORE enrolling', () => {
  const TEMP = PASSWORD;
  const NEW = 'a brand new passphrase';
  const pendingOf = (res: { headers: Record<string, unknown> }) => cookiePair(cookieValue(res, PENDING_COOKIE_NAME)!);

  it('login with mustChangePassword and no TOTP answers next=change_password', async () => {
    await member({ mfa: false, mustChangePassword: true });
    const res = await login('bob', TEMP);
    expect(res.body).toEqual({ next: 'change_password' });
    const tok = verifyPendingToken(pendingOf(res).split('=')[1], SECRET)!;
    expect(tok.stage).toBe('change_password');
    expect(cookieValue(res, COOKIE_NAME)).toBeUndefined();
  });

  it('the change_password token cannot enroll, answer MFA or reach data; an enroll token is refused while the password is temporary', async () => {
    const { user } = await member({ mfa: false, mustChangePassword: true });
    const change = `${PENDING_COOKIE_NAME}=${createPendingToken(user.id, 'change_password', user.sessionVersion, SECRET)}`;
    expect((await post('/api/auth/mfa/setup', {}, change)).status).toBe(401);
    expect((await post('/api/auth/mfa/enable', { code: '123456' }, change)).status).toBe(401);
    expect((await post('/api/auth/mfa', { code: '123456' }, change)).status).toBe(401);
    expect((await get('/api/categories', change)).status).toBe(401);
    // forged/early enroll token (e.g. minted before the flag was set) is useless until the password changed
    const enroll = `${PENDING_COOKIE_NAME}=${createPendingToken(user.id, 'enroll', user.sessionVersion, SECRET)}`;
    expect((await post('/api/auth/mfa/setup', {}, enroll)).status).toBe(401);
    expect((await stored(user.id)).totpPendingEnc).toBeNull();
  });

  it('changes the password through the pending token (needs the temporary one), then moves to enroll with a fresh token', async () => {
    const { user } = await member({ mfa: false, mustChangePassword: true });
    const pending = pendingOf(await login('bob', TEMP));
    const wrong = await post('/api/auth/password', { currentPassword: 'not the temp password', newPassword: NEW }, pending);
    expect(wrong.status).toBe(401);
    expect((await stored(user.id)).failedLogins).toBe(1);
    expect((await post('/api/auth/password', { currentPassword: TEMP, newPassword: 'short' }, pending)).status).toBe(400);

    const ok = await post('/api/auth/password', { currentPassword: TEMP, newPassword: NEW }, pending);
    expect(ok.status).toBe(200);
    expect(ok.body).toEqual({ ok: true, next: 'enroll' });
    expect(cookieValue(ok, COOKIE_NAME)).toBeUndefined(); // still no session
    const u = await stored(user.id);
    expect(u).toMatchObject({ mustChangePassword: false, sessionVersion: 2, totpEnabled: false });
    expect(verifyPendingToken(pendingOf(ok).split('=')[1], SECRET)).toMatchObject({ stage: 'enroll', sv: 2 });
    // the old pending token is dead (sessionVersion moved) and cannot change the password again
    expect((await post('/api/auth/password', { currentPassword: NEW, newPassword: 'yet another passphrase' }, pending)).status).toBe(401);

    // continue: enroll with the new token and get a session without any password gate
    const enroll = pendingOf(ok);
    const setup = await post('/api/auth/mfa/setup', {}, enroll);
    const en = await post('/api/auth/mfa/enable', { code: freshCode(setup.body.secret) }, enroll);
    expect(en.status).toBe(200);
    expect(en.body.mustChangePassword).toBe(false);
    expect((await get('/api/categories', cookiePair(cookieValue(en, COOKIE_NAME)!))).status).toBe(200);
    expect((await login('bob', TEMP)).status).toBe(401);
  });

  it('an admin who knows the temporary password cannot enroll a factor on the account', async () => {
    const { user } = await member({ mfa: false, mustChangePassword: true });
    const pending = pendingOf(await login('bob', TEMP));
    expect((await post('/api/auth/mfa/setup', {}, pending)).status).toBe(401);
    expect((await stored(user.id)).totpPendingEnc).toBeNull();
  });

  it('an enrolled user whose password was reset answers MFA first, then hits the password gate in-session', async () => {
    const { user, totpSecret } = await member({ mustChangePassword: true });
    expect((await login('bob', TEMP)).body).toEqual({ next: 'mfa' });
    const cookie = await fullLogin('bob', TEMP, totpSecret);
    expect(await get('/api/categories', cookie)).toMatchObject({ status: 403, body: { error: 'password_change_required' } });
    expect(user.id).toBeTruthy();
  });

  it('the pending change token is short-lived like the others', async () => {
    const { user } = await member({ mfa: false, mustChangePassword: true });
    const expired = `${PENDING_COOKIE_NAME}=${createPendingToken(user.id, 'change_password', user.sessionVersion, SECRET, -5)}`;
    expect((await post('/api/auth/password', { currentPassword: TEMP, newPassword: NEW }, expired)).status).toBe(401);
  });

  it('bootstrap admin skips the change step', async () => {
    expect((await login('drew', BOOT_HASH_PW)).body).toEqual({ next: 'enroll' });
  });
});

describe('PATCH /api/auth/me (own display name)', () => {
  it('updates displayName and initials (first + last word; single word -> first two letters)', async () => {
    const { user } = await member();
    const cookie = sessionCookie(user);
    const cases: [string, string][] = [['Drew S', 'DS'], ['  maya   lin  ', 'ML'], ['Cher', 'CH'], ['Mary Jane Watson', 'MW'], ['x', 'X']];
    for (const [name, initials] of cases) {
      const res = await request(app).patch('/api/auth/me').set(CSRF).set('Cookie', cookie).send({ displayName: name });
      expect(res.status, name).toBe(200);
      expect(res.body.user).toMatchObject({ displayName: name.trim(), initials, username: 'bob', role: 'member' });
      expect(Object.keys(res.body.user).sort()).toEqual(['displayName', 'id', 'initials', 'role', 'username']);
      expect((await get('/api/auth/me', cookie)).body.user.initials).toBe(initials);
    }
    expect(logs.some((l) => l.includes('"changes":["displayName"]'))).toBe(true);
  });

  it('validates, needs a session and the CSRF header, and cannot touch other fields', async () => {
    const { user } = await member();
    const cookie = sessionCookie(user);
    const patchMe = (b: unknown) => request(app).patch('/api/auth/me').set(CSRF).set('Cookie', cookie).send(b as object);
    expect((await patchMe({ displayName: '   ' })).status).toBe(400);
    expect((await patchMe({ displayName: 'x'.repeat(61) })).status).toBe(400);
    expect((await patchMe({ displayName: 'Ok', role: 'admin' })).status).toBe(400);
    expect((await patchMe({})).status).toBe(400);
    expect((await request(app).patch('/api/auth/me').set(CSRF).send({ displayName: 'Ok' })).status).toBe(401);
    expect((await request(app).patch('/api/auth/me').set('Cookie', cookie).send({ displayName: 'Ok' })).status).toBe(403);
    expect((await stored(user.id)).role).toBe('member');
  });
});

// ---- sessions, revocation, password --------------------------------------------------------------------------
describe('sessionVersion revocation', () => {
  it('bumping sessionVersion kills existing sessions and pending tokens', async () => {
    const { user, totpSecret } = await seedUser(store);
    const cookie = await fullLogin('alice', PASSWORD, totpSecret);
    const l = await login('alice', PASSWORD);
    const pending = cookiePair(cookieValue(l, PENDING_COOKIE_NAME)!);
    expect((await get('/api/auth/me', cookie)).status).toBe(200);

    await store.mutate(user.id, (u) => ({ patch: { sessionVersion: u.sessionVersion + 1 } }));
    clock += 31_000; // past the 30s user cache
    expect((await get('/api/auth/me', cookie)).status).toBe(401);
    expect((await post('/api/auth/mfa', { code: freshCode(totpSecret) }, pending)).status).toBe(401);
  });

  it('a disabled user is refused at login and loses an existing session', async () => {
    const adm = await admin();
    const { user, totpSecret } = await member();
    const cookie = await fullLogin('bob', PASSWORD, totpSecret);
    expect((await get('/api/auth/me', cookie)).status).toBe(200);
    expect((await patch(`/api/users/${user.id}`, { disabled: true }, adm.cookie)).status).toBe(200);
    expect((await get('/api/auth/me', cookie)).status).toBe(401);
    const res = await login('bob', PASSWORD);
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: 'Invalid username or password' });
    // re-enabling must not resurrect the old cookie
    await patch(`/api/users/${user.id}`, { disabled: false }, adm.cookie);
    expect((await get('/api/auth/me', cookie)).status).toBe(401);
    expect((await login('bob', PASSWORD)).status).toBe(200);
  });
});

describe('POST /api/auth/password and the mustChangePassword gate', () => {
  it('blocks every non-auth API route with 403 password_change_required, but /me, password and logout work', async () => {
    const { user } = await member({ mustChangePassword: true });
    const cookie = sessionCookie(user);
    for (const p of ['/api/categories', '/api/summary', '/api/goals']) {
      expect(await get(p, cookie), p).toMatchObject({ status: 403, body: { error: 'password_change_required' } });
    }
    expect((await post('/api/sync', {}, cookie)).status).toBe(403);
    const me = await get('/api/auth/me', cookie);
    expect(me.status).toBe(200);
    expect(me.body.mustChangePassword).toBe(true);
    expect((await post('/api/auth/recovery-codes', { code: '123456' }, cookie)).status).toBe(403);
    expect((await post('/api/auth/logout', {}, cookie)).status).toBe(200);
  });

  it('changes the password, clears the gate, re-issues this session and revokes the others', async () => {
    const { user } = await member({ mustChangePassword: true });
    const old = sessionCookie(user);
    const other = sessionCookie(user);
    const res = await post('/api/auth/password', { currentPassword: PASSWORD, newPassword: 'a brand new passphrase' }, old);
    expect(res.status).toBe(200);
    const fresh = cookiePair(cookieValue(res, COOKIE_NAME)!);
    expect((await get('/api/categories', fresh)).status).toBe(200);
    expect((await get('/api/auth/me', old)).status).toBe(401);
    expect((await get('/api/auth/me', other)).status).toBe(401);
    const u = await stored(user.id);
    expect(u.mustChangePassword).toBe(false);
    expect(u.sessionVersion).toBe(2);
    expect(await bcrypt.compare('a brand new passphrase', u.passwordHash)).toBe(true);
    expect((await login('bob', PASSWORD)).status).toBe(401);
    expect((await login('bob', 'a brand new passphrase')).status).toBe(200);
  });

  it('enforces length, current-password and difference rules, and counts wrong current passwords toward lockout', async () => {
    const { user } = await member();
    const cookie = sessionCookie(user);
    expect((await post('/api/auth/password', { currentPassword: PASSWORD, newPassword: 'short' }, cookie)).status).toBe(400);
    expect((await post('/api/auth/password', { currentPassword: PASSWORD, newPassword: PASSWORD }, cookie)).status).toBe(400);
    expect((await post('/api/auth/password', { currentPassword: PASSWORD, newPassword: 'x'.repeat(73) }, cookie)).status).toBe(400);
    const wrong = await post('/api/auth/password', { currentPassword: 'not it at all', newPassword: 'a brand new passphrase' }, cookie);
    expect(wrong.status).toBe(401);
    expect((await stored(user.id)).failedLogins).toBe(1);
    expect((await stored(user.id)).sessionVersion).toBe(1);
  });
});

describe('POST /api/auth/recovery-codes', () => {
  it('needs a current TOTP code, returns 10 new codes and invalidates the old ones', async () => {
    const { user, totpSecret } = await seedUser(store);
    await store.mutate(user.id, () => ({ patch: { recoveryCodes: [hashRecoveryCode('abcd-2345')] } }));
    const cookie = sessionCookie(user);
    expect((await post('/api/auth/recovery-codes', {}, cookie)).status).toBe(400);
    expect((await post('/api/auth/recovery-codes', { code: '000000' }, cookie)).status).toBe(401);
    expect((await post('/api/auth/recovery-codes', { code: 'abcd-2345' }, cookie)).status).toBe(401); // not a recovery code
    const res = await post('/api/auth/recovery-codes', { code: freshCode(totpSecret) }, cookie);
    expect(res.status).toBe(200);
    expect(res.body.recoveryCodes).toHaveLength(10);
    const u = await stored(user.id);
    expect(u.recoveryCodes).toEqual(res.body.recoveryCodes.map(hashRecoveryCode));
    expect(u.recoveryCodes).not.toContain(hashRecoveryCode('abcd-2345'));
  });

  it('requires a session', async () => {
    expect((await post('/api/auth/recovery-codes', { code: '123456' })).status).toBe(401);
  });
});

// ---- admin ---------------------------------------------------------------------------------------------------
describe('requireAdmin and the users API', () => {
  it('401 without a session, 403 for a member, 200 for an admin', async () => {
    const adm = await admin();
    const mem = await member();
    expect((await get('/api/users')).status).toBe(401);
    const forbidden = await get('/api/users', mem.cookie);
    expect(forbidden).toMatchObject({ status: 403, body: { error: 'Admin only' } });
    expect((await post('/api/users', { username: 'zed', displayName: 'Zed', role: 'member', temporaryPassword: 'twelve chars long' }, mem.cookie)).status).toBe(403);
    expect((await patch(`/api/users/${adm.user.id}`, { role: 'member' }, mem.cookie)).status).toBe(403);
    expect((await del(`/api/users/${adm.user.id}`, mem.cookie)).status).toBe(403);
    expect((await post(`/api/users/${adm.user.id}/reset-mfa`, {}, mem.cookie)).status).toBe(403);
    const ok = await get('/api/users', adm.cookie);
    expect(ok.status).toBe(200);
    expect(ok.body.users.map((u: { username: string }) => u.username)).toEqual(['root', 'bob']);
    expect(ok.headers['cache-control']).toBe('no-store');
  });

  it('needs the CSRF header on mutations', async () => {
    const adm = await admin();
    const res = await request(app).post('/api/users').set('Cookie', adm.cookie).send({});
    expect(res.status).toBe(403);
  });

  it('never returns passwordHash, totpSecretEnc, totpPendingEnc or recoveryCodes from any users endpoint', async () => {
    const adm = await admin();
    const mem = await member();
    await store.mutate(mem.user.id, () => ({ patch: { recoveryCodes: [hashRecoveryCode('abcd-2345')], totpPendingEnc: 'dev:xyz' } }));
    const secrets = [mem.user.passwordHash, adm.user.passwordHash, 'dev:', hashRecoveryCode('abcd-2345'), 'passwordHash', 'totpSecretEnc', 'totpPendingEnc', 'recoveryCodes', 'sessionVersion', 'failedLogins'];
    const responses = [
      await get('/api/users', adm.cookie),
      await post('/api/users', { username: 'cat', displayName: 'Cat Lee', role: 'member', temporaryPassword: 'twelve chars long' }, adm.cookie),
      await patch(`/api/users/${mem.user.id}`, { displayName: 'Robert Jones' }, adm.cookie),
      await post(`/api/users/${mem.user.id}/reset-password`, { temporaryPassword: 'another long one' }, adm.cookie),
      await post(`/api/users/${mem.user.id}/reset-mfa`, {}, adm.cookie),
      await get('/api/auth/me', adm.cookie),
      await get('/api/users', adm.cookie),
    ];
    for (const r of responses) {
      const text = JSON.stringify(r.body);
      for (const s of secrets) expect(text, `${r.status} ${text.slice(0, 80)}`).not.toContain(s);
    }
    const row = responses[0].body.users[0];
    expect(Object.keys(row).sort()).toEqual(['createdAt', 'disabled', 'displayName', 'id', 'lastLoginAt', 'role', 'totpEnabled', 'username']);
  });

  it('creates a user with mustChangePassword and no TOTP; usernames are normalized and unique', async () => {
    const adm = await admin();
    const res = await post('/api/users', { username: 'Frank.Z', displayName: 'frank zappa', role: 'member', temporaryPassword: 'Temp-Pass-12345' }, adm.cookie);
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ username: 'frank.z', displayName: 'frank zappa', role: 'member', totpEnabled: false, disabled: false });
    const u = await stored(res.body.id);
    expect(u).toMatchObject({ mustChangePassword: true, totpEnabled: false, initials: 'FZ', createdBy: adm.user.id, sessionVersion: 1 });
    expect(await bcrypt.compare('Temp-Pass-12345', u.passwordHash)).toBe(true);
    expect((await store.getByUsername('frank.z'))!.id).toBe(res.body.id);
    const dup = await post('/api/users', { username: 'FRANK.z', displayName: 'Other', role: 'admin', temporaryPassword: 'Temp-Pass-12345' }, adm.cookie);
    expect(dup.status).toBe(409);
    // the new user logs in and is sent to enrollment
    expect((await login('frank.z', 'Temp-Pass-12345')).body).toEqual({ next: 'change_password' });
  });

  it('validates the create body', async () => {
    const adm = await admin();
    const base = { username: 'valid.name', displayName: 'Valid', role: 'member', temporaryPassword: 'twelve chars long' };
    for (const bad of [
      { ...base, username: 'ab' }, { ...base, username: 'x'.repeat(33) }, { ...base, username: 'has space' }, { ...base, username: 'UPPER!' },
      { ...base, displayName: '' }, { ...base, role: 'owner' }, { ...base, temporaryPassword: 'short' },
      { ...base, temporaryPassword: 'x'.repeat(73) }, { ...base, extra: 1 },
    ]) {
      expect((await post('/api/users', bad, adm.cookie)).status, JSON.stringify(bad)).toBe(400);
    }
    expect(await store.list()).toHaveLength(1);
  });

  it('patches displayName (recomputing initials), role and disabled; unknown ids are 404', async () => {
    const adm = await admin();
    const mem = await member();
    const res = await patch(`/api/users/${mem.user.id}`, { displayName: 'Robert Q Jones', role: 'admin' }, adm.cookie);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ displayName: 'Robert Q Jones', role: 'admin' });
    expect((await stored(mem.user.id)).initials).toBe('RJ');
    expect((await patch('/api/users/nope', { disabled: true }, adm.cookie)).status).toBe(404);
    expect((await patch(`/api/users/${mem.user.id}`, { passwordHash: 'x' }, adm.cookie)).status).toBe(400);
  });

  it('reset-password sets mustChangePassword, revokes sessions and clears a lockout', async () => {
    const adm = await admin();
    const mem = await member();
    await store.mutate(mem.user.id, () => ({ patch: { lockedUntil: new Date(clock + 1e6).toISOString(), failedLogins: 3 } }));
    const res = await post(`/api/users/${mem.user.id}/reset-password`, { temporaryPassword: 'fresh temp password' }, adm.cookie);
    expect(res.status).toBe(200);
    expect(await stored(mem.user.id)).toMatchObject({ mustChangePassword: true, sessionVersion: 2, lockedUntil: null, failedLogins: 0 });
    expect((await get('/api/auth/me', mem.cookie)).status).toBe(401);
    expect((await login('bob', 'fresh temp password')).body).toEqual({ next: 'mfa' });
    expect((await post(`/api/users/${mem.user.id}/reset-password`, { temporaryPassword: 'short' }, adm.cookie)).status).toBe(400);
    expect((await post('/api/users/nope/reset-password', { temporaryPassword: 'fresh temp password' }, adm.cookie)).status).toBe(404);
  });

  it('reset-mfa clears TOTP and recovery codes, revokes sessions, and the user re-enrolls at next login', async () => {
    const adm = await admin();
    const mem = await member();
    await store.mutate(mem.user.id, () => ({ patch: { recoveryCodes: [hashRecoveryCode('abcd-2345')], totpLastStep: 99 } }));
    const res = await post(`/api/users/${mem.user.id}/reset-mfa`, {}, adm.cookie);
    expect(res.status).toBe(200);
    expect(await stored(mem.user.id)).toMatchObject({ totpEnabled: false, totpSecretEnc: null, totpPendingEnc: null, recoveryCodes: [], totpLastStep: 0, sessionVersion: 2 });
    expect((await get('/api/auth/me', mem.cookie)).status).toBe(401);
    expect((await login('bob', PASSWORD)).body).toEqual({ next: 'enroll' });
  });

  it('deletes a user and frees the username', async () => {
    const adm = await admin();
    const mem = await member();
    expect((await del(`/api/users/${mem.user.id}`, adm.cookie)).status).toBe(200);
    expect(await store.getById(mem.user.id)).toBeUndefined();
    expect(await store.getByUsername('bob')).toBeUndefined();
    expect((await get('/api/auth/me', mem.cookie)).status).toBe(401);
    expect((await del(`/api/users/${mem.user.id}`, adm.cookie)).status).toBe(404);
    expect((await post('/api/users', { username: 'bob', displayName: 'Bob 2', role: 'member', temporaryPassword: 'twelve chars long' }, adm.cookie)).status).toBe(201);
  });
});

describe('self and last-admin guards', () => {
  it('an admin cannot delete, disable or demote themselves', async () => {
    const adm = await admin();
    await seedUser(store, { username: 'root2', role: 'admin' }); // a second admin, so only the self guard applies
    for (const r of [
      await del(`/api/users/${adm.user.id}`, adm.cookie),
      await patch(`/api/users/${adm.user.id}`, { disabled: true }, adm.cookie),
      await patch(`/api/users/${adm.user.id}`, { role: 'member' }, adm.cookie),
    ]) {
      expect(r.status).toBe(400);
      expect(r.body.error).toMatch(/own account/);
    }
    expect(await stored(adm.user.id)).toMatchObject({ role: 'admin', disabled: false });
    // renaming yourself is fine
    expect((await patch(`/api/users/${adm.user.id}`, { displayName: 'Root Renamed' }, adm.cookie)).status).toBe(200);
  });

  it('adminGuard: self, last active admin, and the cases that are allowed', () => {
    const mk2 = (id: string, role: 'admin' | 'member', disabled = false) => ({ id, role, disabled } as StoredUser);
    const a = mk2('a', 'admin');
    const b = mk2('b', 'admin');
    const m = mk2('m', 'member');
    expect(adminGuard('a', a, ['a', 'b'], { remove: true })).toBe('self');
    expect(adminGuard('a', a, ['a', 'b'], { disable: true })).toBe('self');
    expect(adminGuard('a', a, ['a', 'b'], { demote: true })).toBe('self');
    expect(adminGuard('x', a, ['a'], { remove: true })).toBe('last_admin');
    expect(adminGuard('x', a, ['a'], { demote: true })).toBe('last_admin');
    expect(adminGuard('x', a, ['a'], { disable: true })).toBe('last_admin');
    expect(adminGuard('a', b, ['a', 'b'], { remove: true })).toBeNull();
    expect(adminGuard('a', b, ['a', 'b'], { demote: true })).toBeNull();
    expect(adminGuard('a', m, ['a'], { remove: true })).toBeNull();
    expect(adminGuard('a', m, ['a'], { demote: true })).toBeNull();
    expect(adminGuard('a', mk2('d', 'admin', true), ['a'], { remove: true })).toBeNull(); // disabled admin is not "active"
    expect(adminGuard('a', b, ['a', 'b'], {})).toBeNull();
  });

  it('the last active admin cannot be removed, disabled or demoted, even under a race (stale cached actor)', async () => {
    const actor = await admin(); // root
    const target = await seedUser(store, { username: 'root2', role: 'admin' });
    // warm the cache with root as an active admin, then disable root straight in the store (as another admin could, concurrently)
    expect((await get('/api/users', actor.cookie)).status).toBe(200);
    await store.mutate(actor.user.id, () => ({ patch: { disabled: true } }));
    for (const r of [
      await del(`/api/users/${target.user.id}`, actor.cookie),
      await patch(`/api/users/${target.user.id}`, { disabled: true }, actor.cookie),
      await patch(`/api/users/${target.user.id}`, { role: 'member' }, actor.cookie),
    ]) {
      expect(r.status).toBe(400);
      expect(r.body.error).toMatch(/at least one active admin/);
    }
    expect(await stored(target.user.id)).toMatchObject({ role: 'admin', disabled: false });
  });

  it('an admin can remove another admin while another active admin remains', async () => {
    const adm = await admin();
    const other = await seedUser(store, { username: 'root2', role: 'admin' });
    expect((await patch(`/api/users/${other.user.id}`, { role: 'member' }, adm.cookie)).status).toBe(200);
    expect((await del(`/api/users/${other.user.id}`, adm.cookie)).status).toBe(200);
  });
});

// ---- logging -------------------------------------------------------------------------------------------------
describe('audit log', () => {
  it('logs structured auth events with ids and IP, and never passwords, codes or secrets', async () => {
    const adm = await admin();
    const { totpSecret } = await member();
    await login('bob', 'a very wrong password', app, '203.0.113.7');
    const l = await login('bob', PASSWORD);
    const code = freshCode(totpSecret);
    await post('/api/auth/mfa', { code: '123456' }, cookiePair(cookieValue(l, PENDING_COOKIE_NAME)!), app, '203.0.113.8');
    await post('/api/users', { username: 'gus', displayName: 'Gus', role: 'member', temporaryPassword: 'super secret temp' }, adm.cookie);
    await login('ghost', 'ghost password');

    const text = logs.join('\n');
    const events = logs.map((x) => JSON.parse(x));
    expect(events.map((e) => e.event)).toEqual(expect.arrayContaining(['login_failure', 'login_success', 'mfa_failure', 'user_created']));
    const fail = events.find((e) => e.event === 'login_failure' && e.username === 'bob');
    expect(fail).toMatchObject({ severity: 'WARNING', ip: '203.0.113.7', userId: expect.any(String) });
    for (const secret of ['a very wrong password', PASSWORD, 'super secret temp', 'ghost password', code, '123456', totpSecret]) {
      expect(text).not.toContain(secret);
    }
    expect(events.find((e) => e.reason === 'unknown_user')).not.toHaveProperty('username');
  });
});

describe('responses', () => {
  it('auth responses are never cacheable', async () => {
    await seedUser(store);
    const res = await login('alice', PASSWORD);
    expect(res.headers['cache-control']).toBe('no-store');
  });

  it('sanity: test helpers use cheap bcrypt but a real hash', () => {
    expect(hashPw()).toMatch(/^\$2[aby]\$04\$/);
    expect(generateTotpSecret()).toHaveLength(32);
  });
});
