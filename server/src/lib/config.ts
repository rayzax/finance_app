import { randomBytes } from 'node:crypto';

export interface Config {
  nodeEnv: string;
  isProduction: boolean;
  port: number;
  plaidClientId: string;
  plaidSecret: string;
  plaidEnv: 'sandbox' | 'production';
  sessionSecret: string;
  appPasswordHash: string;
  firestoreDatabase: string;
  projectId: string | undefined;
  kmsKeyName: string | undefined;
  devEncryptionKey: string | undefined;
  timezone: string;
  publicUrl: string | undefined;
  runServiceUrl: string | undefined;
  schedulerSaEmail: string | undefined;
  staticDir: string | undefined;
}

type Env = Record<string, string | undefined>;

const clean = (v: string | undefined): string | undefined => {
  const t = v?.trim();
  return t ? t : undefined;
};

export function loadConfig(env: Env = process.env): Config {
  const nodeEnv = env.NODE_ENV || 'development';
  const isProduction = nodeEnv === 'production';
  const plaidEnv = env.PLAID_ENV === 'production' ? 'production' : 'sandbox';
  return {
    nodeEnv,
    isProduction,
    port: Number(env.PORT) || 8080,
    plaidClientId: env.PLAID_CLIENT_ID ?? '',
    plaidSecret: env.PLAID_SECRET ?? '',
    plaidEnv,
    // In dev an ephemeral secret is fine (sessions die on restart).
    sessionSecret: env.SESSION_SECRET || (isProduction ? '' : randomBytes(32).toString('hex')),
    appPasswordHash: (env.APP_PASSWORD_HASH ?? '').trim(),
    firestoreDatabase: env.FIRESTORE_DATABASE || 'finance',
    projectId: clean(env.GOOGLE_CLOUD_PROJECT),
    kmsKeyName: clean(env.KMS_KEY_NAME),
    devEncryptionKey: clean(env.DEV_ENCRYPTION_KEY),
    timezone: env.APP_TIMEZONE || 'America/Denver',
    publicUrl: clean(env.PUBLIC_URL)?.replace(/\/+$/, ''),
    runServiceUrl: clean(env.RUN_SERVICE_URL)?.replace(/\/+$/, ''),
    schedulerSaEmail: clean(env.SCHEDULER_SA_EMAIL),
    staticDir: clean(env.STATIC_DIR),
  };
}

let cached: Config | undefined;
export function getConfig(): Config {
  if (!cached) cached = loadConfig();
  return cached;
}
/** For tests: drop the cached config so env changes are picked up. */
export function resetConfig(): void {
  cached = undefined;
}

/** Throws if the process must not start with this configuration. */
export function assertStartupConfig(cfg: Config): void {
  if (!cfg.isProduction) return;
  const missing: string[] = [];
  if (!cfg.kmsKeyName) missing.push('KMS_KEY_NAME');
  if (!cfg.sessionSecret) missing.push('SESSION_SECRET');
  if (!cfg.appPasswordHash) missing.push('APP_PASSWORD_HASH');
  if (missing.length) {
    throw new Error(`Refusing to start in production without: ${missing.join(', ')}`);
  }
}
