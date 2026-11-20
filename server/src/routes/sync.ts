import { Router } from 'express';
import { col, ItemDoc } from '../lib/db';
import { claimManualSync, syncAll } from '../lib/sync';

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
  return r;
}
