import { Router, raw } from 'express';
import rateLimit from 'express-rate-limit';
import { CountryCode, Products } from 'plaid';
import { z } from 'zod';
import { col, ItemDoc } from '../lib/db';
import { decryptToken, encryptToken } from '../lib/crypto';
import { getConfig } from '../lib/config';
import { plaid, logPlaidError, redactPlaidError } from '../lib/plaid';
import { syncItem } from '../lib/sync';
import { cachedKeyFetcher, createWebhookVerifier, WebhookVerifyError, type KeyFetcher } from '../lib/webhookVerify';
import { parseBody } from './util';

const linkTokenSchema = z.object({ itemId: z.string().min(1).max(200).optional() }).strict();
const exchangeSchema = z.object({
  public_token: z.string().min(1).max(500),
  institution: z.object({ institution_id: z.string().max(100).optional().nullable(), name: z.string().max(200) }),
});

const plaidKeyFetcher: KeyFetcher = async (kid) => {
  const res = await plaid().webhookVerificationKeyGet({ key_id: kid });
  return res.data.key as any;
};

/** Creates an item from a Plaid public_token: exchange, encrypt, store, initial sync. */
export async function createItemFromPublicToken(publicToken: string, institution: { institution_id?: string | null; name: string }): Promise<string> {
  const ex = await plaid().itemPublicTokenExchange({ public_token: publicToken });
  const itemId = ex.data.item_id;
  const doc: ItemDoc = {
    institutionId: institution.institution_id ?? undefined,
    institutionName: institution.name,
    accessTokenEnc: await encryptToken(ex.data.access_token),
    cursor: null,
    status: 'ok',
    error: null,
    newAccountsAvailable: false,
    createdAt: new Date().toISOString(),
    lastSyncAt: null,
  };
  await col.items().doc(itemId).set(doc);
  await syncItem(itemId); // never throws; records status on the item
  return itemId;
}

/** Protected plaid routes (session + CSRF header applied by the caller). */
export function plaidRouter(): Router {
  const r = Router();

  r.post('/link-token', async (req, res) => {
    const body = parseBody(linkTokenSchema, req, res);
    if (!body) return;
    const cfg = getConfig();
    const base = {
      user: { client_user_id: 'owner' },
      client_name: 'Reserve',
      language: 'en',
      country_codes: [CountryCode.Us],
      ...(cfg.publicUrl ? { webhook: `${cfg.publicUrl}/api/plaid/webhook` } : {}),
    };
    try {
      if (body.itemId) {
        const ref = col.items().doc(body.itemId);
        const snap = await ref.get();
        if (!snap.exists) { res.status(404).json({ error: 'Item not found' }); return; }
        const item = snap.data() as ItemDoc;
        const r2 = await plaid().linkTokenCreate({
          ...base,
          access_token: await decryptToken(item.accessTokenEnc),
          ...(item.newAccountsAvailable ? { update: { account_selection_enabled: true } } : {}),
        });
        // The user is acting on the "new accounts" prompt; clear the flag.
        if (item.newAccountsAvailable) await ref.set({ newAccountsAvailable: false }, { merge: true });
        res.json({ link_token: r2.data.link_token });
        return;
      }
      const r2 = await plaid().linkTokenCreate({
        ...base,
        products: [Products.Transactions],
        transactions: { days_requested: 730 },
      });
      res.json({ link_token: r2.data.link_token });
    } catch (e) {
      logPlaidError('link-token', e);
      res.status(502).json({ error: 'Could not create link token' });
    }
  });

  r.post('/exchange', async (req, res) => {
    const body = parseBody(exchangeSchema, req, res);
    if (!body) return;
    try {
      const itemId = await createItemFromPublicToken(body.public_token, body.institution);
      res.json({ ok: true, itemId });
    } catch (e) {
      logPlaidError('exchange', e);
      res.status(502).json({ error: 'Could not link account' });
    }
  });
  return r;
}

export interface WebhookDeps { getKey?: KeyFetcher; now?: () => number; sync?: (itemId: string) => Promise<unknown> }

/**
 * Public webhook route. Must be mounted BEFORE express.json(): it needs the raw body
 * so the SHA-256 in the signed JWT can be compared against the exact bytes received.
 */
export function webhookRouter(deps: WebhookDeps = {}): Router {
  const r = Router();
  const verify = createWebhookVerifier({ getKey: cachedKeyFetcher(deps.getKey ?? plaidKeyFetcher), now: deps.now });
  const doSync = deps.sync ?? syncItem;
  const limiter = rateLimit({ windowMs: 60_000, limit: 300, standardHeaders: true, legacyHeaders: false, message: { error: 'Too many requests' } });

  r.post('/webhook', limiter, raw({ type: '*/*', limit: '1mb' }), async (req, res) => {
    try {
      await verify(req.body as Buffer, req.get('Plaid-Verification'));
    } catch (e) {
      if (!(e instanceof WebhookVerifyError)) console.error('[webhook] verify error', redactPlaidError(e));
      res.status(401).json({ error: 'Invalid webhook' });
      return;
    }

    let payload: any;
    try { payload = JSON.parse((req.body as Buffer).toString('utf8')); } catch { res.status(400).json({ error: 'Invalid JSON' }); return; }
    const itemId = typeof payload?.item_id === 'string' ? payload.item_id : undefined;
    if (!itemId) { res.json({ ok: true }); return; }

    try {
      const work = handleWebhook(payload, itemId, doSync);
      // Respond within Plaid's window, but give short work a chance to finish first
      // (Cloud Run may throttle CPU after the response is sent).
      await Promise.race([work, new Promise((r2) => setTimeout(r2, 8000))]);
      work.catch(() => undefined);
    } catch (e) {
      console.error('[webhook] handler error', redactPlaidError(e));
    }
    res.json({ ok: true });
  });
  return r;
}

async function handleWebhook(p: any, itemId: string, doSync: (id: string) => Promise<unknown>): Promise<void> {
  const ref = col.items().doc(itemId);
  const snap = await ref.get();
  if (!snap.exists) return;
  const type = p.webhook_type;
  const code = p.webhook_code;
  if (type === 'TRANSACTIONS' && code === 'SYNC_UPDATES_AVAILABLE') {
    await doSync(itemId);
  } else if (type === 'ITEM') {
    if (code === 'ERROR' || code === 'PENDING_EXPIRATION' || code === 'PENDING_DISCONNECT') {
      await ref.set({ status: 'login_required', error: 'Login required' }, { merge: true });
    } else if (code === 'NEW_ACCOUNTS_AVAILABLE') {
      await ref.set({ newAccountsAvailable: true }, { merge: true });
    } else if (code === 'LOGIN_REPAIRED') {
      await ref.set({ status: 'ok', error: null }, { merge: true });
      await doSync(itemId);
    }
  }
}
