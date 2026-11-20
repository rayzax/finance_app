import { Router } from 'express';
import { col, ItemDoc } from '../lib/db';
import { claimManualSync, syncAll, syncItem, writeSnapshot } from '../lib/sync';

export async function latestSyncAt(): Promise<string | null> {
  const snap = await col.items().get();
  let best: string | null = null;
  for (const d of snap.docs) {
    const t = (d.data() as ItemDoc).lastSyncAt;
    if (t && (!best || t > best)) best = t;
  }
  return best;
}

export function syncRouter(): Router {
  const r = Router();
  r.post('/sync', async (_req, res) => {
    if (!claimManualSync()) {
      res.json({ ok: true, skipped: true, lastSyncAt: await latestSyncAt() });
      return;
    }
    await syncAll();
    res.json({ ok: true, lastSyncAt: await latestSyncAt() });
  });

  // Per-item sync, never debounced: used after a Plaid Link update-mode (reconnect) success.
  r.post('/items/:id/sync', async (req, res) => {
    const id = String(req.params.id);
    const ref = col.items().doc(id);
    if (!(await ref.get()).exists) { res.status(404).json({ error: 'Item not found' }); return; }
    const result = await syncItem(id);
    await writeSnapshot();
    const item = (await ref.get()).data() as ItemDoc;
    res.json({ ok: true, status: result.status, lastSyncAt: item.lastSyncAt ?? null });
  });
  return r;
}
