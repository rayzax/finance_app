import fs from 'node:fs';
import path from 'node:path';
import cookieParser from 'cookie-parser';
import express, { type NextFunction, type Request, type Response } from 'express';
import helmet from 'helmet';
import { requireCsrfHeader, requireSession } from './lib/auth';
import { getConfig } from './lib/config';
import { redactPlaidError } from './lib/plaid';
import { authRouter } from './routes/auth';
import { dataRouter } from './routes/data';
import { devRouter } from './routes/dev';
import { internalRouter, type OidcVerifier } from './routes/internal';
import { plaidRouter, webhookRouter, type WebhookDeps } from './routes/plaid';
import { syncRouter } from './routes/sync';

export interface AppDeps {
  webhook?: WebhookDeps;
  oidcVerifier?: OidcVerifier;
  runInternalSync?: () => Promise<void>;
}

export function createApp(deps: AppDeps = {}): express.Express {
  const cfg = getConfig();
  const app = express();
  app.set('trust proxy', 1);
  app.disable('x-powered-by');

  app.use(
    helmet({
      contentSecurityPolicy: {
        useDefaults: false,
        directives: {
          'default-src': ["'self'"],
          'script-src': ["'self'", 'https://cdn.plaid.com'],
          'frame-src': ['https://cdn.plaid.com'],
          'connect-src': ["'self'", 'https://*.plaid.com'],
          'img-src': ["'self'", 'data:', 'https://plaid-merchant-logos.plaid.com', 'https://plaid-category-icons.plaid.com'],
          'style-src': ["'self'", "'unsafe-inline'"],
          'font-src': ["'self'"],
          'manifest-src': ["'self'"],
          'object-src': ["'none'"],
          'base-uri': ["'self'"],
          'form-action': ["'self'"],
          'frame-ancestors': ["'none'"],
          ...(cfg.isProduction ? { 'upgrade-insecure-requests': [] } : {}),
        },
      },
      strictTransportSecurity: { maxAge: 31536000, includeSubDomains: true },
    }),
  );

  app.get('/api/health', (_req, res) => { res.json({ ok: true }); });

  // Raw-body routes first: the webhook needs the exact bytes, so this MUST precede express.json().
  app.use('/api/plaid', webhookRouter(deps.webhook));

  app.use(express.json({ limit: '100kb' }));
  app.use(cookieParser());

  app.use('/api/auth', authRouter());
  app.use('/api/internal', internalRouter(deps.oidcVerifier, deps.runInternalSync));

  // Everything else under /api requires a session (and the CSRF header on mutations).
  app.use('/api', requireSession, requireCsrfHeader);
  app.use('/api/plaid', plaidRouter());
  app.use('/api', syncRouter());
  app.use('/api', dataRouter());
  if (!cfg.isProduction) app.use('/api/dev', devRouter());

  app.use('/api', (_req, res) => { res.status(404).json({ error: 'Not found' }); });

  // SPA
  const staticDir = cfg.staticDir ?? path.resolve(__dirname, '../../web/dist');
  const indexHtml = path.join(staticDir, 'index.html');
  if (fs.existsSync(indexHtml)) {
    app.use(
      express.static(staticDir, {
        index: false,
        setHeaders: (res, file) => {
          if (file.endsWith('.html') || file.endsWith('sw.js')) res.setHeader('Cache-Control', 'no-cache');
          else if (file.includes(`${path.sep}assets${path.sep}`)) res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
        },
      }),
    );
    app.use((req, res, next) => {
      if (req.method !== 'GET' && req.method !== 'HEAD') return next();
      res.setHeader('Cache-Control', 'no-cache');
      res.sendFile(indexHtml);
    });
  }

  app.use((err: any, req: Request, res: Response, _next: NextFunction) => {
    if (err?.type === 'entity.parse.failed' || err?.type === 'entity.too.large') {
      res.status(400).json({ error: 'Invalid request' });
      return;
    }
    console.error(`[error] ${req.method} ${req.path}`, JSON.stringify(redactPlaidError(err)));
    if (!res.headersSent) res.status(500).json({ error: 'Internal error' });
  });

  return app;
}
