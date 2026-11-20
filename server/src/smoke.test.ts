import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { SignJWT, exportJWK, generateKeyPair } from 'jose';
import { mapCategory, accountGroup } from './lib/categories';
import { buildForecast } from './lib/forecast';
import { createWebhookVerifier } from './lib/webhookVerify';
import { collectChanges } from './lib/sync';

describe('smoke', () => {
  it('maps categories', () => {
    expect(mapCategory('FOOD_AND_DRINK', 'FOOD_AND_DRINK_GROCERIES')).toBe('groceries');
    expect(mapCategory('LOAN_PAYMENTS', 'LOAN_PAYMENTS_CREDIT_CARD_PAYMENT')).toBe('transfer');
    expect(accountGroup('investment', '401k')).toBe('retirement');
  });
  it('forecasts', () => {
    const f = buildForecast({
      cashNow: 1000, asOf: '2026-11-19',
      streams: [
        { description: 'Rent', frequency: 'MONTHLY', predictedNextDate: '2026-12-01', averageAmount: 500, direction: 'out' },
        { description: 'Pay', frequency: 'BIWEEKLY', lastDate: '2026-11-13', averageAmount: 800, direction: 'in' },
      ],
    });
    expect(f.projected).toBe(1000 - 500 + 800 * 2);
    expect(f.bills).toBe(1);
  });
  it('verifies webhooks', async () => {
    const { publicKey, privateKey } = await generateKeyPair('ES256');
    const jwk = { ...(await exportJWK(publicKey)), kid: 'k1', alg: 'ES256', use: 'sig' };
    const body = Buffer.from('{"a":1}');
    const sign = (iat: number) =>
      new SignJWT({ request_body_sha256: createHash('sha256').update(body).digest('hex') })
        .setProtectedHeader({ alg: 'ES256', kid: 'k1' }).setIssuedAt(iat).sign(privateKey);
    const now = 1_700_000_000;
    const v = createWebhookVerifier({ getKey: async () => jwk, now: () => now });
    await expect(v(body, await sign(now))).resolves.toBeUndefined();
    await expect(v(body, await sign(now - 400))).rejects.toThrow();
    await expect(v(Buffer.from('{"a":2}'), await sign(now))).rejects.toThrow();
  });
  it('retries on mutation during pagination', async () => {
    let calls = 0;
    const page = { added: [], modified: [], removed: [], next_cursor: 'c', has_more: false };
    const err = { response: { data: { error_code: 'TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION' } } };
    const r = await collectChanges(async () => { if (++calls < 3) throw err; return page; }, 'start');
    expect(calls).toBe(3);
    expect(r.nextCursor).toBe('c');
  });
});
