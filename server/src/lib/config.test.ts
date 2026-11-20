import { afterEach, describe, expect, it } from 'vitest';
import { assertStartupConfig, loadConfig, getConfig, resetConfig } from './config';

afterEach(() => resetConfig());

describe('loadConfig', () => {
  it('defaults to development with an ephemeral session secret', () => {
    const cfg = loadConfig({});
    expect(cfg.nodeEnv).toBe('development');
    expect(cfg.isProduction).toBe(false);
    expect(cfg.sessionSecret).toMatch(/^[0-9a-f]{64}$/);
    expect(loadConfig({}).sessionSecret).not.toBe(cfg.sessionSecret);
  });

  it('uses SESSION_SECRET when set', () => {
    expect(loadConfig({ SESSION_SECRET: 'abc' }).sessionSecret).toBe('abc');
  });

  it('never generates a session secret in production', () => {
    expect(loadConfig({ NODE_ENV: 'production' }).sessionSecret).toBe('');
  });

  it('only treats PLAID_ENV=production as production Plaid', () => {
    expect(loadConfig({ PLAID_ENV: 'production' }).plaidEnv).toBe('production');
    expect(loadConfig({ PLAID_ENV: 'sandbox' }).plaidEnv).toBe('sandbox');
    expect(loadConfig({ PLAID_ENV: 'development' }).plaidEnv).toBe('sandbox');
  });

  it('trims the password hash and strips trailing slashes from URLs', () => {
    const cfg = loadConfig({
      APP_PASSWORD_HASH: '  $2a$12$abc  ',
      PUBLIC_URL: 'https://reserve.example///',
      RUN_SERVICE_URL: 'https://run.example/',
    });
    expect(cfg.appPasswordHash).toBe('$2a$12$abc');
    expect(cfg.publicUrl).toBe('https://reserve.example');
    expect(cfg.runServiceUrl).toBe('https://run.example');
  });

  it('defaults the timezone to America/Denver and the port to 8080', () => {
    const cfg = loadConfig({});
    expect(cfg.timezone).toBe('America/Denver');
    expect(cfg.port).toBe(8080);
    expect(loadConfig({ APP_TIMEZONE: 'Europe/Paris', PORT: '3000' })).toMatchObject({ timezone: 'Europe/Paris', port: 3000 });
  });

  it('treats blank optional values as unset', () => {
    const cfg = loadConfig({ KMS_KEY_NAME: '   ', GOOGLE_CLOUD_PROJECT: '' });
    expect(cfg.kmsKeyName).toBeUndefined();
    expect(cfg.projectId).toBeUndefined();
  });
});

describe('assertStartupConfig', () => {
  it('does nothing outside production', () => {
    expect(() => assertStartupConfig(loadConfig({}))).not.toThrow();
  });

  it('refuses to start in production without KMS, session secret and password hash', () => {
    expect(() => assertStartupConfig(loadConfig({ NODE_ENV: 'production' }))).toThrow(
      /KMS_KEY_NAME, SESSION_SECRET, APP_PASSWORD_HASH/,
    );
  });

  it('starts in production when everything required is set', () => {
    const cfg = loadConfig({
      NODE_ENV: 'production',
      KMS_KEY_NAME: 'projects/p/locations/l/keyRings/r/cryptoKeys/k',
      SESSION_SECRET: 's'.repeat(64),
      APP_PASSWORD_HASH: '$2a$12$abc',
    });
    expect(() => assertStartupConfig(cfg)).not.toThrow();
  });
});

describe('getConfig / resetConfig', () => {
  it('caches the config until resetConfig is called', () => {
    const before = process.env.APP_TIMEZONE;
    try {
      process.env.APP_TIMEZONE = 'Asia/Tokyo';
      resetConfig();
      expect(getConfig().timezone).toBe('Asia/Tokyo');
      process.env.APP_TIMEZONE = 'Asia/Seoul';
      expect(getConfig().timezone).toBe('Asia/Tokyo');
      resetConfig();
      expect(getConfig().timezone).toBe('Asia/Seoul');
    } finally {
      if (before === undefined) delete process.env.APP_TIMEZONE;
      else process.env.APP_TIMEZONE = before;
    }
  });
});
