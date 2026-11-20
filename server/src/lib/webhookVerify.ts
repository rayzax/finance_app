import { createHash, timingSafeEqual } from 'node:crypto';
import { decodeProtectedHeader, importJWK, jwtVerify, type JWK } from 'jose';

export type KeyFetcher = (kid: string) => Promise<JWK & { expired_at?: number | null }>;

export class WebhookVerifyError extends Error {}

export interface VerifierOptions {
  getKey: KeyFetcher;
  /** Epoch seconds; injectable for tests. */
  now?: () => number;
  maxAgeSeconds?: number;
}

/** Wrap a fetcher with a kid-keyed cache (bounded, so junk kids can't grow it forever). */
export function cachedKeyFetcher(fetcher: KeyFetcher, maxEntries = 16): KeyFetcher {
  const cache = new Map<string, Awaited<ReturnType<KeyFetcher>>>();
  return async (kid) => {
    const hit = cache.get(kid);
    if (hit) return hit;
    const key = await fetcher(kid);
    if (cache.size >= maxEntries) cache.delete(cache.keys().next().value as string);
    cache.set(kid, key);
    return key;
  };
}

export function safeEqualHex(a: string, b: string): boolean {
  if (!/^[0-9a-fA-F]+$/.test(a) || !/^[0-9a-fA-F]+$/.test(b)) return false;
  const ba = Buffer.from(a, 'hex');
  const bb = Buffer.from(b, 'hex');
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

/** Returns a function that resolves if the webhook is authentic and throws WebhookVerifyError otherwise. */
export function createWebhookVerifier(opts: VerifierOptions) {
  const now = opts.now ?? (() => Math.floor(Date.now() / 1000));
  const maxAge = opts.maxAgeSeconds ?? 300;

  return async function verify(rawBody: Buffer, jwt: string | undefined): Promise<void> {
    if (!jwt || !Buffer.isBuffer(rawBody)) throw new WebhookVerifyError('missing token or body');

    let header;
    try {
      header = decodeProtectedHeader(jwt);
    } catch {
      throw new WebhookVerifyError('malformed token');
    }
    if (header.alg !== 'ES256' || !header.kid) throw new WebhookVerifyError('bad alg or kid');

    let jwk;
    try {
      jwk = await opts.getKey(header.kid);
    } catch {
      throw new WebhookVerifyError('key lookup failed');
    }
    if (jwk.expired_at != null) throw new WebhookVerifyError('key expired');

    let payload;
    try {
      const key = await importJWK(jwk, 'ES256');
      // Pin the algorithm; exp/nbf are not used by Plaid so only iat is checked below.
      ({ payload } = await jwtVerify(jwt, key, { algorithms: ['ES256'] }));
    } catch {
      throw new WebhookVerifyError('bad signature');
    }

    const iat = payload.iat;
    if (typeof iat !== 'number') throw new WebhookVerifyError('missing iat');
    const t = now();
    if (t - iat > maxAge) throw new WebhookVerifyError('token too old');
    if (iat - t > 60) throw new WebhookVerifyError('token from the future');

    const claimed = (payload as any).request_body_sha256;
    if (typeof claimed !== 'string') throw new WebhookVerifyError('missing body hash');
    const actual = createHash('sha256').update(rawBody).digest('hex');
    if (!safeEqualHex(actual, claimed)) throw new WebhookVerifyError('body hash mismatch');
  };
}
