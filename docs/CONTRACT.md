# Integration contract (server ⇄ web ⇄ infra)

The source of truth is `CLAUDE_CODE_PROMPT.md` plus `ui/`. This file pins down the details it leaves open, so the parts built in parallel fit together.

## Packages / build
- No root workspace. `server/` and `web/` are independent npm packages, each with a `package-lock.json`.
- `web`: `npm run build` → `web/dist/`. Vite dev on :5173 proxies `/api` → `http://localhost:8080`.
- `server`: `npm run build` (tsc) → `server/dist/index.js`, started with `node dist/index.js`. `npm run dev` = `tsx watch src/index.ts`. `npm test` = vitest run. `npm run hash-password` prints a bcrypt hash (reads the password from stdin, no echo).
- The server serves the SPA from `process.env.STATIC_DIR` (default `path.resolve(__dirname, '../../web/dist')`), with index.html fallback for non-`/api` GETs. The Dockerfile copies `web/dist` to `/app/public` and sets `STATIC_DIR=/app/public`.
- Listen on `process.env.PORT || 8080`.

## Environment variables (server)
`NODE_ENV, PORT, PLAID_CLIENT_ID, PLAID_SECRET, PLAID_ENV (sandbox|production), SESSION_SECRET, APP_PASSWORD_HASH, GOOGLE_CLOUD_PROJECT, FIRESTORE_DATABASE (default "finance"), FIRESTORE_EMULATOR_HOST (dev), KMS_KEY_NAME (full resource name of the key; unset → dev crypto), DEV_ENCRYPTION_KEY (64 hex chars = 32 bytes), APP_TIMEZONE (default America/Denver), PUBLIC_URL (public base URL, e.g. https://reserve.example.com or the run.app URL), RUN_SERVICE_URL (the run.app URL), SCHEDULER_SA_EMAIL, STATIC_DIR`

Cloud Run secret env mapping: `PLAID_CLIENT_ID←plaid-client-id`, `PLAID_SECRET←plaid-secret`, `APP_PASSWORD_HASH←app-password-hash`, `SESSION_SECRET←session-secret`.

OIDC on `/api/internal/sync`: the audience must be either `RUN_SERVICE_URL` or `PUBLIC_URL`, and the email must be `SCHEDULER_SA_EMAIL` with `email_verified`. Cloud Scheduler targets `${RUN_SERVICE_URL}/api/internal/sync` with audience `RUN_SERVICE_URL`.

## API conventions
- JSON everywhere. Errors are `{ "error": string }` with an appropriate status. A 401 means the user isn't logged in.
- State-changing requests (POST/PUT/PATCH/DELETE) to session-protected routes, and to login, must carry `X-Requested-With: reserve`, or they get a 403.
- Money is a JS number in dollars. Dates are `YYYY-MM-DD` strings. Timestamps are ISO strings.
- `GET /api/health` (public) → `{ ok: true }`

## Response shapes (in addition to the prompt §5)
```ts
type Group = 'cash'|'investments'|'retirement'|'credit'|'loans'|'other';
type ItemStatus = 'ok'|'login_required'|'error';

POST /api/auth/login {password} → 200 {ok:true} | 401 {error:"Invalid password"} | 429
GET  /api/auth/me → {authenticated:true}
POST /api/sync → {ok:true, skipped?:true, lastSyncAt:string|null}
POST /api/items/:id/sync → {ok:true, status:ItemStatus, lastSyncAt:string|null} | 404   // not debounced; web calls it after Plaid Link update-mode (reconnect) success
GET  /api/categories (session) → [{key, label}]   // all category keys incl. income/transfer/other

GET /api/summary → { netWorth, assets, liabilities, delta, deltaLabel /* "past month" | "past 3 months" | "past year" | "all time" */,
  series:[{date, value}], groups:[{group:Group, label, total /* positive number; liabilities are flagged by group */, count, subtitle}],
  lastSyncAt: string|null, hasAccounts: boolean }

GET /api/accounts → {
  groups: [{ group:Group, label, total, accounts: Account[] }],   // only non-empty groups, order cash,investments,retirement,credit,loans,other
  items:  [{ id, institutionName, status:ItemStatus, error:string|null, lastSyncAt, newAccountsAvailable:boolean }] }
Account = { id, itemId, institutionName, name, officialName, mask, type, subtype, group:Group,
            current, available, limit, currency, hidden }

GET /api/transactions?kind=spend|income|transfer&q=&before=<cursor>&limit=50 → {
  days:[{ date, label /* Today | Yesterday | Tue, Nov 17 */, items: Tx[] }],
  nextCursor: string|null, monthSpent, monthEarned, month /* YYYY-MM, current month in APP_TIMEZONE */ }
Tx = { id, date, name, merchantName, amount /* Plaid sign: + = out */, category, categoryLabel,
       kind, pending, logoUrl, accountId, accountName, userCategory:boolean }

PATCH /api/transactions/:id {category, applyToMerchant?} → Tx
GET  /api/budgets?month=YYYY-MM → per prompt (top-level `spent` sums only categories that have a limit, so `limit`/`spent`/`left` are comparable; `pct` is an integer 0–100, can exceed 100; web derives its own ratio from spent/limit); categories cover every spend category that has a limit or any spending
PUT  /api/budgets {limits} → {ok:true}
GET  /api/cashflow → per prompt (upcoming[].direction = 'in'|'out', amount positive)
POST /api/plaid/link-token {itemId?} → {link_token}
POST /api/plaid/exchange {public_token, institution:{institution_id, name}} → {ok:true, itemId}
DELETE /api/items/:id → {ok:true}
PATCH /api/accounts/:id {hidden} → Account
POST /api/dev/seed (non-production only, session required) → {ok:true, itemId}
```
