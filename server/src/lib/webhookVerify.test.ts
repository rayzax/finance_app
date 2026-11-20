import { createHash } from 'node:crypto';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { SignJWT, exportJWK, generateKeyPair, type JWK } from 'jose';
import { cachedKeyFetcher, createWebhookVerifier, safeEqualHex, WebhookVerifyError, type KeyFetcher } from './webhookVerify';

const NOW = 1_700_000_000;
const BODY = Buffer.from('{"webhook_type":"TRANSACTIONS","webhook_code":"SYNC_UPDATES_AVAILABLE","item_id":"item-1"}');
const sha256Hex = (b: Buffer) => createHash('sha256').update(b).digest('hex');

type KeyPair = Awaited<ReturnType<typeof generateKeyPair>>;
let signing: KeyPair;
let publicJwk: JWK;

beforeAll(async () => {
  signing = await generateKeyPair('ES256');
  publicJwk = { ...(await exportJWK(signing.publicKey)), kid: 'kid-1', alg: 'ES256', use: 'sig' };
});

/** Signs a Plaid-style verification JWT. Pass `kid: null` to omit the header kid. */
async function signToken(opts: {
  iat?: number;
  kid?: string | null;
  key?: KeyPair['privateKey'];
  claims?: Record<string, unknown>;
  alg?: 'ES256';
} = {}): Promise<string> {
  const { iat = NOW, kid = 'kid-1', key = signing.privateKey, claims = { request_body_sha256: sha256Hex(BODY) } } = opts;
  const header: { alg: 'ES256'; kid?: string } = { alg: 'ES256' };
  if (kid !== null) header.kid = kid;
  return new SignJWT(claims).setProtectedHeader(header).setIssuedAt(iat).sign(key);
}

const b64url = (s: string) => Buffer.from(s, 'utf8').toString('base64url');

function makeVerifier(getKey?: KeyFetcher) {
  return createWebhookVerifier({
    getKey: getKey ?? (async (kid) => ({ ...publicJwk, kid })),
    now: () => NOW,
  });
}

describe('createWebhookVerifier', () => {
  it('accepts a correctly signed, fresh token whose body hash matches', async () => {
    const verify = makeVerifier();
    await expect(verify(BODY, await signToken())).resolves.toBeUndefined();
  });

  it('rejects a token signed by a different key', async () => {
    const other = await generateKeyPair('ES256');
    const verify = makeVerifier();
    const jwt = await signToken({ key: other.privateKey });
    await expect(verify(BODY, jwt)).rejects.toThrow(WebhookVerifyError);
    await expect(verify(BODY, jwt)).rejects.toThrow('bad signature');
  });

  it('rejects a token whose payload was altered after signing', async () => {
    const verify = makeVerifier();
    const [h, , s] = (await signToken()).split('.');
    const forged = b64url(JSON.stringify({ iat: NOW, request_body_sha256: sha256Hex(BODY), extra: 1 }));
    await expect(verify(BODY, `${h}.${forged}.${s}`)).rejects.toThrow('bad signature');
  });

  it('rejects an HS256 token (alg confusion) even if it is otherwise valid', async () => {
    const verify = makeVerifier();
    const secret = new TextEncoder().encode('s'.repeat(32));
    const jwt = await new SignJWT({ request_body_sha256: sha256Hex(BODY) })
      .setProtectedHeader({ alg: 'HS256', kid: 'kid-1' })
      .setIssuedAt(NOW)
      .sign(secret);
    await expect(verify(BODY, jwt)).rejects.toThrow('bad alg or kid');
  });

  it('rejects an unsigned alg:none token', async () => {
    const verify = makeVerifier();
    const jwt = `${b64url(JSON.stringify({ alg: 'none', kid: 'kid-1' }))}.${b64url(
      JSON.stringify({ iat: NOW, request_body_sha256: sha256Hex(BODY) }),
    )}.`;
    await expect(verify(BODY, jwt)).rejects.toThrow('bad alg or kid');
  });

  it('rejects a token with no kid in the header', async () => {
    const verify = makeVerifier();
    await expect(verify(BODY, await signToken({ kid: null }))).rejects.toThrow('bad alg or kid');
  });

  it('rejects a token whose iat is more than 5 minutes old', async () => {
    const verify = makeVerifier();
    await expect(verify(BODY, await signToken({ iat: NOW - 301 }))).rejects.toThrow('token too old');
  });

  it('accepts a token exactly 5 minutes old (boundary)', async () => {
    const verify = makeVerifier();
    await expect(verify(BODY, await signToken({ iat: NOW - 300 }))).resolves.toBeUndefined();
  });

  it('rejects a token whose iat is more than 60 seconds in the future', async () => {
    const verify = makeVerifier();
    await expect(verify(BODY, await signToken({ iat: NOW + 120 }))).rejects.toThrow('token from the future');
  });

  it('rejects a tampered body (SHA-256 mismatch)', async () => {
    const verify = makeVerifier();
    const jwt = await signToken();
    const tampered = Buffer.from('{"webhook_type":"ITEM","webhook_code":"ERROR","item_id":"item-1"}');
    await expect(verify(tampered, jwt)).rejects.toThrow('body hash mismatch');
  });

  it('rejects a token with no request_body_sha256 claim', async () => {
    const verify = makeVerifier();
    await expect(verify(BODY, await signToken({ claims: {} }))).rejects.toThrow('missing body hash');
  });

  it('rejects when the token or body is missing', async () => {
    const verify = makeVerifier();
    await expect(verify(BODY, undefined)).rejects.toThrow('missing token or body');
    await expect(verify(BODY, '')).rejects.toThrow('missing token or body');
    await expect(verify('not a buffer' as unknown as Buffer, await signToken())).rejects.toThrow('missing token or body');
  });

  it('rejects a malformed token', async () => {
    const verify = makeVerifier();
    await expect(verify(BODY, 'not-a-jwt')).rejects.toThrow('malformed token');
  });

  it('rejects when the key lookup fails', async () => {
    const verify = makeVerifier(async () => { throw new Error('plaid down'); });
    await expect(verify(BODY, await signToken())).rejects.toThrow('key lookup failed');
  });

  it('rejects when the key has expired_at set', async () => {
    const verify = makeVerifier(async (kid) => ({ ...publicJwk, kid, expired_at: NOW - 10 }));
    await expect(verify(BODY, await signToken())).rejects.toThrow('key expired');
  });

  it('looks up the key by the token kid', async () => {
    const getKey = vi.fn<KeyFetcher>(async (kid) => ({ ...publicJwk, kid }));
    const verify = makeVerifier(getKey);
    await verify(BODY, await signToken({ kid: 'kid-1' }));
    expect(getKey).toHaveBeenCalledWith('kid-1');
  });
});

describe('cachedKeyFetcher', () => {
  it('fetches each kid once and serves repeats from cache', async () => {
    const inner = vi.fn<KeyFetcher>(async (kid) => ({ ...publicJwk, kid }));
    const get = cachedKeyFetcher(inner);
    const a1 = await get('a');
    const a2 = await get('a');
    const b = await get('b');
    await get('b');
    await get('a');
    expect(inner).toHaveBeenCalledTimes(2);
    expect(inner).toHaveBeenNthCalledWith(1, 'a');
    expect(inner).toHaveBeenNthCalledWith(2, 'b');
    expect(a2).toBe(a1);
    expect(b.kid).toBe('b');
  });

  it('does not cache a failed lookup', async () => {
    const inner = vi.fn<KeyFetcher>()
      .mockRejectedValueOnce(new Error('transient'))
      .mockImplementation(async (kid) => ({ ...publicJwk, kid }));
    const get = cachedKeyFetcher(inner);
    await expect(get('a')).rejects.toThrow('transient');
    await expect(get('a')).resolves.toMatchObject({ kid: 'a' });
    expect(inner).toHaveBeenCalledTimes(2);
  });

  it('evicts the oldest entry once the bound is reached', async () => {
    const inner = vi.fn<KeyFetcher>(async (kid) => ({ ...publicJwk, kid }));
    const get = cachedKeyFetcher(inner, 2);
    await get('a');
    await get('b');
    await get('c'); // evicts 'a'
    await get('b'); // still cached
    expect(inner).toHaveBeenCalledTimes(3);
    await get('a'); // refetched
    expect(inner).toHaveBeenCalledTimes(4);
  });

  it('makes the verifier fetch the key only once per kid across many webhooks', async () => {
    const inner = vi.fn<KeyFetcher>(async (kid) => ({ ...publicJwk, kid }));
    const verify = createWebhookVerifier({ getKey: cachedKeyFetcher(inner), now: () => NOW });
    for (let i = 0; i < 3; i++) await verify(BODY, await signToken());
    expect(inner).toHaveBeenCalledTimes(1);
  });
});

describe('safeEqualHex', () => {
  it('matches identical hex strings', () => {
    expect(safeEqualHex('abcd01', 'abcd01')).toBe(true);
  });

  it('compares case-insensitively (same bytes)', () => {
    expect(safeEqualHex('ABCD01', 'abcd01')).toBe(true);
  });

  it('rejects different hex of the same length', () => {
    expect(safeEqualHex('abcd01', 'abcd02')).toBe(false);
  });

  it('rejects different lengths', () => {
    expect(safeEqualHex('abcd', 'abcd00')).toBe(false);
  });

  it('rejects non-hex or prefixed input', () => {
    expect(safeEqualHex('zz', 'zz')).toBe(false);
    expect(safeEqualHex('0xabcd', 'abcd')).toBe(false);
    expect(safeEqualHex('', '')).toBe(false);
  });
});
