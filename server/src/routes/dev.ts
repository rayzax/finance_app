import { Router } from 'express';
import { Products } from 'plaid';
import { logPlaidError, plaid } from '../lib/plaid';
import { writeSnapshot } from '../lib/sync';
import { createItemFromPublicToken } from './plaid';

/** Non-production only: links a Plaid sandbox item and syncs it. */
export function devRouter(): Router {
  const r = Router();
  r.post('/seed', async (_req, res) => {
    try {
      const pt = await plaid().sandboxPublicTokenCreate({ institution_id: 'ins_109508', initial_products: [Products.Transactions] });
      const itemId = await createItemFromPublicToken(pt.data.public_token, { institution_id: 'ins_109508', name: 'First Platypus Bank' });
      await writeSnapshot();
      res.json({ ok: true, itemId });
    } catch (e) {
      logPlaidError('dev seed', e);
      res.status(502).json({ error: 'Seed failed' });
    }
  });
  return r;
}
