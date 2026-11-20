import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { checkPassword, clearSessionCookie, requireCsrfHeader, requireSession, setSessionCookie } from '../lib/auth';
import { parseBody } from './util';

const loginSchema = z.object({ password: z.string().min(1).max(1024) }).strict();

export function authRouter(): Router {
  const r = Router();
  const limiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 5,
    standardHeaders: true,
    legacyHeaders: false,
    skipSuccessfulRequests: true,
    message: { error: 'Too many attempts. Try again later.' },
  });

  r.post('/login', requireCsrfHeader, limiter, async (req, res) => {
    const body = parseBody(loginSchema, req, res);
    if (!body) return;
    if (!(await checkPassword(body.password))) {
      res.status(401).json({ error: 'Invalid password' });
      return;
    }
    setSessionCookie(res);
    res.json({ ok: true });
  });

  r.post('/logout', requireCsrfHeader, (_req, res) => {
    clearSessionCookie(res);
    res.json({ ok: true });
  });

  r.get('/me', requireSession, (_req, res) => {
    res.json({ authenticated: true });
  });
  return r;
}
