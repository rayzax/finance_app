import bcrypt from 'bcryptjs';
import { resetConfig } from './lib/config';
import { encryptToken } from './lib/crypto';
import { createSessionToken, COOKIE_NAME } from './lib/auth';
import { generateTotpSecret } from './lib/totp';
import { newUserDoc, type MemoryUserStore, type Role, type StoredUser } from './lib/users';

export const SECRET = 'test-session-secret-'.padEnd(64, 'x');
export const DEV_KEY = 'ab'.repeat(32);
export const PASSWORD = 'correct horse battery staple';
export const CSRF = { 'X-Requested-With': 'reserve' };
export const BCRYPT_TEST_COST = 4;

const ENV_KEYS = [
  'SESSION_SECRET', 'APP_PASSWORD_HASH', 'RUN_SERVICE_URL', 'SCHEDULER_SA_EMAIL', 'PUBLIC_URL', 'NODE_ENV',
  'DEV_ENCRYPTION_KEY', 'KMS_KEY_NAME', 'BOOTSTRAP_ADMIN_USERNAME', 'BOOTSTRAP_ADMIN_NAME',
] as const;
type EnvKey = (typeof ENV_KEYS)[number];
const saved: Partial<Record<EnvKey, string | undefined>> = {};

export function saveEnv() {
  for (const k of ENV_KEYS) saved[k] = process.env[k];
}
export function restoreEnv() {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  resetConfig();
}
export function setEnv(vars: Partial<Record<EnvKey, string | undefined>>) {
  for (const [k, v] of Object.entries(vars)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  resetConfig();
}
export function baseEnv(extra: Partial<Record<EnvKey, string | undefined>> = {}) {
  setEnv({
    NODE_ENV: 'test', SESSION_SECRET: SECRET, DEV_ENCRYPTION_KEY: DEV_KEY, KMS_KEY_NAME: undefined,
    APP_PASSWORD_HASH: undefined, RUN_SERVICE_URL: undefined, SCHEDULER_SA_EMAIL: undefined, PUBLIC_URL: undefined,
    BOOTSTRAP_ADMIN_USERNAME: undefined, BOOTSTRAP_ADMIN_NAME: undefined, ...extra,
  });
}

export const hashPw = (pw = PASSWORD) => bcrypt.hashSync(pw, BCRYPT_TEST_COST);

/** Insert a user straight into the fake store. With mfa=true it has TOTP enabled and a known secret. */
export async function seedUser(
  store: MemoryUserStore,
  opts: { username?: string; displayName?: string; role?: Role; password?: string; mfa?: boolean; mustChangePassword?: boolean; now?: Date } = {},
): Promise<{ user: StoredUser; totpSecret: string; password: string }> {
  const password = opts.password ?? PASSWORD;
  const doc = newUserDoc({
    username: opts.username ?? 'alice', displayName: opts.displayName ?? 'Alice Smith', role: opts.role ?? 'member',
    passwordHash: hashPw(password), mustChangePassword: opts.mustChangePassword ?? false, createdBy: null, now: opts.now ?? new Date(),
  });
  const totpSecret = generateTotpSecret();
  if (opts.mfa !== false) {
    doc.totpEnabled = true;
    doc.totpSecretEnc = await encryptToken(totpSecret);
  }
  const user = await store.create(doc);
  return { user, totpSecret, password };
}

export const sessionCookie = (u: Pick<StoredUser, 'id' | 'sessionVersion'>, secret = SECRET) =>
  `${COOKIE_NAME}=${createSessionToken(u.id, u.sessionVersion, secret)}`;

export function cookieValue(res: { headers: Record<string, unknown> }, name: string): string | undefined {
  const c = [res.headers['set-cookie'] as string[] | string | undefined].flat().find((x) => x?.startsWith(`${name}=`));
  return c;
}
export const cookiePair = (setCookie: string) => setCookie.split(';')[0];
