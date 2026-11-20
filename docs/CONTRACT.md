# Integration contract (server ⇄ web ⇄ infra)

The source of truth is `CLAUDE_CODE_PROMPT.md` plus `ui/`. This file pins down the details it leaves open, so the parts built in parallel fit together.

## Packages / build
- No root workspace. `server/` and `web/` are independent npm packages, each with a `package-lock.json`.
- `web`: `npm run build` → `web/dist/`. Vite dev on :5173 proxies `/api` → `http://localhost:8080`.
- `server`: `npm run build` (tsc) → `server/dist/index.js`, started with `node dist/index.js`. `npm run dev` = `tsx watch src/index.ts`. `npm test` = vitest run. `npm run hash-password` prints a bcrypt hash (reads the password from stdin, no echo).
- The server serves the SPA from `process.env.STATIC_DIR` (default `path.resolve(__dirname, '../../web/dist')`), with index.html fallback for non-`/api` GETs. The Dockerfile copies `web/dist` to `/app/public` and sets `STATIC_DIR=/app/public`.
- Listen on `process.env.PORT || 8080`.

## Environment variables (server)
`NODE_ENV, PORT, BOOTSTRAP_ADMIN_USERNAME (default "drew"), BOOTSTRAP_ADMIN_NAME (default "Drew"), PLAID_CLIENT_ID, PLAID_SECRET, PLAID_ENV (sandbox|production), SESSION_SECRET, APP_PASSWORD_HASH, GOOGLE_CLOUD_PROJECT, FIRESTORE_DATABASE (default "finance"), FIRESTORE_EMULATOR_HOST (dev), KMS_KEY_NAME (full resource name of the key; unset → dev crypto), DEV_ENCRYPTION_KEY (64 hex chars = 32 bytes), APP_TIMEZONE (default America/Denver), PUBLIC_URL (public base URL, e.g. https://reserve.example.com or the run.app URL), RUN_SERVICE_URL (the run.app URL), SCHEDULER_SA_EMAIL, STATIC_DIR`

Cloud Run secret env mapping: `PLAID_CLIENT_ID←plaid-client-id`, `PLAID_SECRET←plaid-secret`, `APP_PASSWORD_HASH←app-password-hash`, `SESSION_SECRET←session-secret`.

OIDC on `/api/internal/sync`: the audience must be either `RUN_SERVICE_URL` or `PUBLIC_URL`, and the email must be `SCHEDULER_SA_EMAIL` with `email_verified`. Cloud Scheduler targets `${RUN_SERVICE_URL}/api/internal/sync` with audience `RUN_SERVICE_URL`.

## API conventions
- JSON everywhere. Errors are `{ "error": string }` with an appropriate status. A 401 means the user isn't logged in. A 403 `{error:"password_change_required"}` on any non-auth route means the account must change its password first (the web routes to the change-password screen). `/api/*` responses are `Cache-Control: no-store`.
- State-changing requests (POST/PUT/PATCH/DELETE) to session-protected routes, and to every `/api/auth/*` route, must carry `X-Requested-With: reserve`, or they get a 403.
- Money is a JS number in dollars. Dates are `YYYY-MM-DD` strings. Timestamps are ISO strings.
- `GET /api/health` (public) → `{ ok: true }`

## Response shapes (in addition to the prompt §5)
```ts
type Group = 'cash'|'investments'|'retirement'|'credit'|'loans'|'other';
type ItemStatus = 'ok'|'login_required'|'error';

see "Accounts and MFA" below for /api/auth/* and /api/users
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

## Accounts and MFA

Shared household data: the finance collections are not scoped by user. Roles are `admin` and `member`; only admins use `/api/users`. TOTP is required for every account. Firestore: `users/{userId}` and `usernames/{username}` → `{userId}` (uniqueness, written in one transaction). User fields: username, displayName, initials, passwordHash (bcrypt 12), role, totpSecretEnc (`kms:`/`dev:` ciphertext), totpPendingEnc (enrollment in progress), totpEnabled, totpLastStep, recoveryCodes (HMAC-SHA256 hex under a key derived from SESSION_SECRET with label `recovery-codes`, single-use; rotating SESSION_SECRET therefore invalidates unused recovery codes), mustChangePassword, sessionVersion, disabled, failedLogins, failedWindowStart, lockedUntil, createdAt, createdBy, lastLoginAt.

Cookies (all `httpOnly; SameSite=Strict; Path=/`, `Secure` in production):
- `reserve_pending`: 5 min, HS256 JWT `{sub, sv, stage:'mfa'|'enroll'|'change_password', typ:'pending', aud:'reserve:pending', jti}`. Only `/api/auth/mfa*` and `/api/auth/password` read it.
- `reserve_session`: 30 days, `{sub:userId, sv, typ:'session', aud:'reserve:session', jti}`. The two token kinds use different keys derived from `SESSION_SECRET` (HMAC with a purpose label), so neither verifies as the other.
- `requireSession` loads the user (in-memory cache, 30 s, dropped on writes made through this instance) and rejects with 401 when the user is missing or disabled, `sv` differs from `sessionVersion`, or `totpEnabled` is false. It sets `req.user = {id, username, displayName, initials, role}`.

```ts
type AuthUser = { id; username; displayName; initials; role: 'admin'|'member' };
type PublicUser = { id; username; displayName; role; totpEnabled: boolean; disabled: boolean; lastLoginAt: string|null; createdAt: string };

POST /api/auth/login {username, password} → 200 {next:'mfa'|'enroll'|'change_password'} + reserve_pending
     // 'change_password' when mustChangePassword and no TOTP yet: the temporary password must be replaced BEFORE enrolling
     | 401 {error:"Invalid username or password"} (unknown user, wrong password, disabled and locked accounts are indistinguishable) | 429
POST /api/auth/mfa {code} (pending stage 'mfa'; code = 6-digit TOTP, +/-1 step, or a recovery code xxxx-xxxx)
     → 200 {ok:true, mustChangePassword, recoveryCodesRemaining} + reserve_session, pending cleared
     | 401 {error:"Invalid code"} | 401 {error:"Session expired. Sign in again."} | 429
POST /api/auth/mfa/setup {code?} (pending 'enroll'; or a full session, which must send the current TOTP `code`)
     → {otpauthUrl, secret, qrSvg}   // label "Reserve:<username>", issuer "Reserve", SHA1/6/30; qrSvg is an inline SVG string
POST /api/auth/mfa/enable {code} → 200 {ok:true, recoveryCodes:string[10] /* shown once */, mustChangePassword}
     // from 'enroll' it also sets reserve_session and clears pending | 401 {error:"Invalid code"} | 409 if setup was not called
GET  /api/auth/me → 200 {authenticated:true, user:AuthUser, mustChangePassword} | 401
PATCH /api/auth/me {displayName /* 1-60, trimmed */} → same shape as GET (session; initials recomputed: first letters of the first and last words, or the first two letters of a single word)
POST /api/auth/password {currentPassword, newPassword /* 12-72 bytes */} → {ok:true}   // full session: bumps sessionVersion, re-issues this session
     // with a pending 'change_password' token (needs the temporary password): → {ok:true, next:'enroll'} + a fresh pending 'enroll' cookie, no session
POST /api/auth/recovery-codes {code /* current TOTP */} → {recoveryCodes:string[10]}    // replaces the old set; blocked while mustChangePassword
POST /api/auth/logout → {ok:true}   // clears both cookies
```
- Brute-force limits: the per-IP login limiter (5 failed attempts / 15 min) stays. Per account, 10 failed password or MFA attempts within 15 minutes set `lockedUntil` (+15 min; a locked login answers with the same generic 401). MFA, enable, re-enroll and recovery-code regeneration also allow 5 failures per 5 minutes per pending/session token or IP (429). A completed MFA login (not a password-only success) resets the counters.
- TOTP replay: the accepted time step is written to `totpLastStep` in a transaction; a code at a step <= the stored one is rejected. A recovery code is removed in a transaction, so only one request can spend it.
- A temporary password (new user or admin reset) never lets anyone enroll a factor: a user with `mustChangePassword` and no TOTP gets stage `change_password`; `enroll` tokens are refused while `mustChangePassword` is set. So an admin who knows the temporary password cannot pre-enroll an authenticator. The bootstrap admin (own password) goes straight to `enroll`. A user who already has TOTP (admin password reset) answers MFA first and then meets the in-session `password_change_required` gate.
- Enrollment: `setup` stores the new secret encrypted as pending only. An `enroll` token can never replace an enabled factor.

### Users (admin only: 401 without a session, 403 for a member)
```ts
GET    /api/users → {users: PublicUser[]}
POST   /api/users {username /* 3-32 of [a-z0-9._-], lowercased */, displayName /* 1-60 */, role, temporaryPassword /* 12-72 bytes */} → 201 PublicUser | 409 {error:"That username is taken"}
         // mustChangePassword=true, totpEnabled=false: at first sign-in the person changes the password, then enrolls
PATCH  /api/users/:id {displayName?, role?, disabled?} → PublicUser | 404      // disabling bumps sessionVersion
POST   /api/users/:id/reset-password {temporaryPassword} → {ok:true}          // mustChangePassword, bumps sessionVersion, clears lockout
POST   /api/users/:id/reset-mfa → {ok:true}                                   // clears TOTP + recovery codes, bumps sessionVersion
DELETE /api/users/:id → {ok:true} | 404
```
Guards (400 `{error}`; checked inside the write transaction): an admin cannot delete, disable or demote themselves, and the last active admin cannot be deleted, disabled or demoted. Responses are an allow-list: never `passwordHash`, `totpSecretEnc`, `totpPendingEnc` or `recoveryCodes`.

### Bootstrap
While `users` is empty, `POST /api/auth/login` with `username == BOOTSTRAP_ADMIN_USERNAME` and a password that matches `APP_PASSWORD_HASH` creates that admin (`BOOTSTRAP_ADMIN_NAME`, password re-hashed at cost 12) and answers `{next:'enroll'}`. Once any user exists `APP_PASSWORD_HASH` is ignored.

### Audit log
One JSON line per event on stdout (`severity`, `message:"auth:<event>"`, `event`, `userId`, `username`, `ip`, `reason`/`changes`): login success/failure/lock, bootstrap, MFA success/failure/rate-limit/recovery-code use, enrollment, password change, recovery-code regeneration, user created/updated/deleted/password-reset/mfa-reset, logout. Never passwords, codes, secrets or tokens; unknown usernames are not logged.

## Recurring costs and savings goals

Both are session-protected, the state-changing calls need `X-Requested-With: reserve`, and bodies are zod-validated (`400 {error:"Invalid request"}`). Collections: `recurringCosts/{id}`, `goals/{id}`. Daily `snapshots/{date}` now also carry `balances: {accountId: current}` (all accounts, hidden included); goals use them for the savings rate.

### Recurring costs
```ts
type RecurringStatus = 'paid'|'due_soon'|'upcoming'|'overdue';
Cost = { id, name, amount /* >0 */, dayOfMonth /* 1-31, clamped to the month's length */, category /* a spend category key */,
         categoryLabel, matchMerchant: string|null /* stored normalized, e.g. "netflix" */, active: boolean }

GET /api/recurring-costs?month=YYYY-MM (default: current month in APP_TIMEZONE) → {
  month, totalMonthly /* active costs */, paidCount, paidAmount, upcomingCount /* active and unpaid, overdue included */, upcomingAmount,
  items: (Cost & { dueDate, status: RecurringStatus, paidTxId: string|null, paidDate: string|null })[],   // sorted by dueDate
  detected: [{ streamId, description, averageAmount, frequency, predictedNextDate: string|null, lastDate: string|null }] }  // Plaid outflow streams not already tracked
POST   /api/recurring-costs {name, amount, dayOfMonth, category?='bills', matchMerchant?: string|null, active?=true} → 201 Cost
PATCH  /api/recurring-costs/:id  (any subset of the POST fields) → Cost | 404
DELETE /api/recurring-costs/:id → {ok:true} | 404
```
- Paid: a transaction in that month (money out, any account) whose normalized merchant name or raw name equals, or contains on whole hyphen-delimited words, the normalized `matchMerchant` (else the normalized `name`), with amount within +/-15% of the cost. The closest amount wins.
- Status: paid, else overdue when the due date is before today, else due_soon when within 5 days (including today), else upcoming. All dates are in APP_TIMEZONE. Inactive costs are listed but excluded from the totals and the forecast.
- A detected stream is hidden once its normalized description matches a tracked cost.
- `GET /api/cashflow` merges active costs into the forecast as MONTHLY outflows (next occurrence on/after today; the current month is skipped once the cost is paid). A Plaid outflow stream with the same normalized merchant is dropped (the manual cost wins).

### Goals
```ts
type Pace = 'ahead'|'on_track'|'behind'|'done'|'no_date';
Goal = { id, name, targetAmount, targetDate: string|null, source:'accounts'|'manual', accountIds: string[],
         current, pct /* 0-100, capped, 1 decimal */, remaining, monthlyNeeded: number|null, expectedPct: number|null, pace: Pace,
         projectedDate: string|null, countOnlyNew: boolean, manualAmount: number, createdAt: string }

GET /api/goals → { goals: Goal[] /* not archived, oldest first */,
                   summary: { totalSaved /* each goal capped at its target */, totalTarget, onTrack /* ahead + on_track + done */, behind } }
POST   /api/goals {name, targetAmount, targetDate?: YYYY-MM-DD|null, source, accountIds? (required, non-empty, must exist, for 'accounts'),
                   countOnlyNew?: boolean, manualAmount?: number>=0 (manual)} → 201 Goal
PATCH  /api/goals/:id  (any subset of the POST fields, plus archived: boolean) → Goal | 404
DELETE /api/goals/:id → {ok:true} | 404
POST   /api/goals/:id/contribute {amount /* non-zero; negative = withdrawal */, date?: YYYY-MM-DD} → Goal
         | 400 if the goal is not manual or the withdrawal exceeds the saved amount | 404
```
- `current`: accounts goals = sum of the linked accounts' current balances (hidden accounts allowed) minus `startingBalance`, which is captured when "count only new savings" is on (at creation, when it is switched on, or when the linked accounts change). Manual goals = `manualAmount` + the sum of contributions.
- `expectedPct` is linear from createdAt (APP_TIMEZONE date) to targetDate. Ahead if pct >= expectedPct + 5, behind if pct < expectedPct - 5, otherwise on_track; done when current >= target; no_date without a target date. `monthlyNeeded` = remaining / months left (days / 30.4375, rounded up, at least 1); null when done or undated.
- `projectedDate` comes from the 90-day savings rate: accounts goals use the snapshots' per-account balances plus the live balance (needs >= 7 days of history); manual goals use the contributions in the window averaged over 30-90 days. null when the rate is <= 0 or unknown, and when done. The math lives in `server/src/lib/goals.ts`.
