import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { KeyManagementServiceClient } from '@google-cloud/kms';
import { getConfig } from './config';

let kms: KeyManagementServiceClient | undefined;
const kmsClient = () => (kms ??= new KeyManagementServiceClient());

function devKey(): Buffer {
  const hex = getConfig().devEncryptionKey;
  if (!hex || !/^[0-9a-fA-F]{64}$/.test(hex)) {
    throw new Error('DEV_ENCRYPTION_KEY must be 64 hex chars when KMS_KEY_NAME is unset');
  }
  return Buffer.from(hex, 'hex');
}

export function devEncrypt(plaintext: string, key: Buffer = devKey()): string {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([c.update(plaintext, 'utf8'), c.final()]);
  return 'dev:' + Buffer.concat([iv, c.getAuthTag(), ct]).toString('base64');
}

export function devDecrypt(payload: string, key: Buffer = devKey()): string {
  const buf = Buffer.from(payload.slice('dev:'.length), 'base64');
  const d = createDecipheriv('aes-256-gcm', key, buf.subarray(0, 12));
  d.setAuthTag(buf.subarray(12, 28));
  return Buffer.concat([d.update(buf.subarray(28)), d.final()]).toString('utf8');
}

export async function encryptToken(plaintext: string): Promise<string> {
  const { kmsKeyName } = getConfig();
  if (!kmsKeyName) return devEncrypt(plaintext);
  const [res] = await kmsClient().encrypt({ name: kmsKeyName, plaintext: Buffer.from(plaintext, 'utf8') });
  if (!res.ciphertext) throw new Error('KMS returned no ciphertext');
  return 'kms:' + Buffer.from(res.ciphertext as Uint8Array).toString('base64');
}

export async function decryptToken(stored: string): Promise<string> {
  const cfg = getConfig();
  if (stored.startsWith('kms:')) {
    if (!cfg.kmsKeyName) throw new Error('KMS_KEY_NAME not configured; cannot decrypt kms: value');
    const [res] = await kmsClient().decrypt({
      name: cfg.kmsKeyName,
      ciphertext: Buffer.from(stored.slice('kms:'.length), 'base64'),
    });
    if (!res.plaintext) throw new Error('KMS returned no plaintext');
    return Buffer.from(res.plaintext as Uint8Array).toString('utf8');
  }
  if (stored.startsWith('dev:')) {
    if (cfg.isProduction) throw new Error('dev: ciphertext is not accepted in production');
    return devDecrypt(stored);
  }
  throw new Error('Unknown ciphertext format');
}
