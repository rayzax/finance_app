import { Router } from 'express';
import { OAuth2Client } from 'google-auth-library';
import { getConfig } from '../lib/config';
import { syncAll } from '../lib/sync';

export interface OidcVerifier { (idToken: string, audiences: string[]): Promise<{ email?: string; email_verified?: boolean } | undefined> }

const googleClient = new OAuth2Client();
const defaultVerifier: OidcVerifier = async (idToken, audience) => {
  const ticket = await googleClient.verifyIdToken({ idToken, audience });
  return ticket.getPayload() ?? undefined;
};

export function internalRouter(verifier: OidcVerifier = defaultVerifier, run: () => Promise<void> = syncAll): Router {
  const r = Router();
  r.post('/sync', async (req, res) => {
    const cfg = getConfig();
    const audiences = [cfg.runServiceUrl, cfg.publicUrl].filter((x): x is string => !!x);
    if (!audiences.length || !cfg.schedulerSaEmail) {
      res.status(503).json({ error: 'Internal sync not configured' });
      return;
    }
    const m = /^Bearer (.+)$/i.exec(req.get('Authorization') ?? '');
    if (!m) { res.status(401).json({ error: 'Unauthorized' }); return; }
    try {
      const p = await verifier(m[1], audiences);
      if (!p || p.email_verified !== true || p.email !== cfg.schedulerSaEmail) {
        res.status(401).json({ error: 'Unauthorized' });
        return;
      }
    } catch {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
    await run();
    res.json({ ok: true });
  });
  return r;
}
