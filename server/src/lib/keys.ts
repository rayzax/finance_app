import { createHmac } from 'node:crypto';

/** Purpose-labelled key derivation from SESSION_SECRET: HMAC-SHA256(secret, "reserve/<label>"). */
export function deriveKey(label: string, secret: string): Buffer {
  return createHmac('sha256', secret).update(`reserve/${label}`).digest();
}
