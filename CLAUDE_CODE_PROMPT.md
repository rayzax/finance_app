# Build: "Reserve", a personal finance web app on GCP (iPhone-first, Plaid)

You're building a private, single-user personal finance web app for Drew. It runs in his own GCP project. Its main use is on an **iPhone, added to the home screen**; desktop is secondary. Bank data comes from **Plaid** (not Stripe).

This is a **fresh build**. Follow the same deployment pattern as Drew's IPTV web app: Terraform for all infrastructure, plus a **one-click GitHub Actions deploy** into any GCP project.

The UI is already designed and approved, and it's in `./ui/`:
- **`ui/DESIGN_SPEC.md`:** the source of truth for layout, components and states.
- **`ui/tokens.css`:** color, type and spacing tokens.
- **`ui/mockups/*.dc.html`:** pixel references with inline styles.

Match them closely. Don't restyle anything.

---

## 1. Stack (decided)

| Layer | Choice |
|---|---|
| Frontend | React 18 + Vite + TypeScript, React Router. An installable **PWA** with a manifest and apple-touch-icon. Fonts are self-hosted with `@fontsource/cormorant-garamond` and `@fontsource/inter`. Charts are hand-built in SVG, with no chart library. |
| Backend | Node 22 + Express + TypeScript, with `zod` validating every request body. |
| Packaging | **One container:** a multi-stage Dockerfile builds the web app and the server; Express serves the API at `/api/*` and the SPA everywhere else. |
| Hosting | **Cloud Run**, `us-central1`, min instances 0, max 2, 1 vCPU / 512Mi. |
| Database | **Firestore (Native)**, using a *named* database called `finance`, so it can't collide with a `(default)` database in the project. |
| Secrets | **Secret Manager** for the Plaid client ID and secret, the session secret, and the app password hash. |
| Token encryption | **Cloud KMS** symmetric key (90-day rotation) that encrypts every Plaid `access_token` before it's written to Firestore. Only the Cloud Run service account can decrypt. Local dev falls back to AES-256-GCM with a key from `DEV_ENCRYPTION_KEY`. |
| Scheduled sync | **Cloud Scheduler** every 6 hours → `POST /api/internal/sync`, carrying an OIDC token signed by a dedicated scheduler service account. The server verifies the token with `google-auth-library`: the audience is the service URL and the email is the scheduler SA. |
| IaC | **Terraform** with a GCS backend; the state bucket is created by the bootstrap script. |
| CI/CD | **GitHub Actions** using Workload Identity Federation, with no JSON keys anywhere. |
| Domain | Custom domain using whatever method the IPTV app uses, for consistency. If you can't see that repo, use `google_cloud_run_domain_mapping`. That requires the deployer SA to be a verified owner of the domain in Search Console, so document the step. Make the domain optional through a variable. |

## 2. Security model (Drew is a security engineer, so get this right)

- **Login (superseded by named accounts with required TOTP MFA: see `docs/CONTRACT.md`, "Accounts and MFA").** Originally one password, checked with `bcryptjs` against `APP_PASSWORD_HASH`, which comes from Secret Manager. Ship `npm run hash-password` to generate the hash.
- **Session.** An HS256 JWT signed with `SESSION_SECRET`, held in an `httpOnly; Secure; SameSite=Strict; Path=/` cookie, valid for 30 days. Every `/api/*` route except login, the webhook and internal sync requires it.
- **Login rate limit.** 5 attempts per 15 minutes per IP (`express-rate-limit`, `app.set('trust proxy', 1)`). Use a constant-time compare, and return a generic error on failure.
- **CSRF.** Rely on SameSite=Strict, and also require the `X-Requested-With: reserve` header on every state-changing request.
- **Headers.** Use `helmet`, with a CSP that allows only what Plaid Link needs:
  - `script-src 'self' https://cdn.plaid.com`
  - `frame-src https://cdn.plaid.com`
  - `connect-src 'self' https://*.plaid.com`
  - `img-src 'self' data: https://plaid-merchant-logos.plaid.com https://plaid-category-icons.plaid.com`

  Also set HSTS.
- **Plaid webhook** (`POST /api/plaid/webhook`). Verify the `Plaid-Verification` JWT:
  1. Get the key by `kid` from `/webhook_verification_key/get` and cache it.
  2. Verify the ES256 signature.
  3. Reject the request if `iat` is more than 5 minutes old.
  4. Check that the SHA-256 of the **raw body** matches `request_body_sha256`. Use `express.raw` on this route.
- **Plaid access tokens** never reach the browser or the logs. Redact Plaid errors before logging them.
- **Cloud Run** is publicly invocable (`allUsers`), because the app has its own login. The internal sync route is protected by OIDC verification.
- **Least privilege.** The runtime SA gets only `datastore.user`, `secretAccessor` on its specific secrets, and `cloudkms.cryptoKeyEncrypterDecrypter` on the one key. The scheduler SA gets only `run.invoker`.
- **Second factor:** TOTP is now built and required (see the contract). Passkeys/WebAuthn remain a possible later addition.

## 3. Plaid integration

- **Products:** `transactions`. Country `US`. Request `transactions.days_requested: 730` when creating the link token. Set `webhook` to `${PUBLIC_URL}/api/plaid/webhook` when `PUBLIC_URL` is set.
- **Environments:** `PLAID_ENV` = `sandbox` | `production`. Plaid shut down its *Development* environment in 2024, so real banks need **Production** (limited Production access is fine for personal use). Sandbox test login: `user_good` / `pass_good`.
- **Endpoints used:**
  - `/link/token/create`, which also handles **update mode** when an `itemId` is passed, for re-authentication.
  - `/item/public_token/exchange`
  - `/accounts/get`, for cached balances. Don't call `/accounts/balance/get` routinely, because it costs money per call.
  - `/transactions/sync`
  - `/transactions/recurring/get`
  - `/item/remove`
  - `/webhook_verification_key/get`
- **Sync algorithm**, per item:
  1. Decrypt the token.
  2. Call `/accounts/get` and upsert the accounts.
  3. Page `/transactions/sync` from the stored `cursor` until `has_more` is false, collecting `added`, `modified` and `removed`. On `TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION`, restart from the original cursor, up to 3 tries.
  4. Batch-write upserts and deletes, at most 400 per batch. **Keep any category the user set by hand** when a transaction is modified.
  5. Save `next_cursor`.
  6. Refresh the recurring streams. Not having enough history yet is not an error.
  7. Set the item status: `ok`, `login_required` (on `ITEM_LOGIN_REQUIRED`), or `error`.

  After all items, write today's **net-worth snapshot**.
- **Webhooks handled:**
  - `SYNC_UPDATES_AVAILABLE` → sync that item.
  - `ITEM` errors / `PENDING_EXPIRATION` / `PENDING_DISCONNECT` → set `login_required`.
  - `ITEM: NEW_ACCOUNTS_AVAILABLE` → mark the item so the UI can offer update mode.

## 4. Data model (Firestore, database `finance`)

```
items/{itemId}          institutionId, institutionName, accessTokenEnc ("kms:<b64>"), cursor,
                        status: ok|login_required|error, error, createdAt, lastSyncAt
accounts/{accountId}    itemId, institutionName, name, officialName, mask, type, subtype,
                        group: cash|investments|retirement|credit|loans|other,
                        current, available, limit, currency, hidden:boolean, updatedAt
transactions/{txId}     itemId, accountId, date (YYYY-MM-DD), month (YYYY-MM), name, merchantName,
                        amount (Plaid sign: + = money out), pfcPrimary, pfcDetailed,
                        category (our key), userCategory, kind: spend|income|transfer,
                        pending, logoUrl, updatedAt
merchantRules/{normalizedMerchant}   category      ← "apply to future" overrides
snapshots/{YYYY-MM-DD}  date, netWorth, assets, liabilities, groups{cash,investments,...}
recurring/{itemId}      inflow[], outflow[]  (streamId, accountId, description, frequency,
                        lastDate, predictedNextDate, averageAmount(abs), isActive, status)
settings/budgets        limits { groceries: 600, dining: 300, ... }  (applies every month)
```

Composite indexes go in Terraform (`google_firestore_index`): `transactions(kind ASC, date DESC)` and `transactions(month ASC, date DESC)`.

**Account groups:**
- `depository` → cash
- `credit` → credit
- `loan` → loans
- `investment` → **retirement** if the subtype is one of `401k, 401a, 403b, 457b, ira, roth, roth 401k, sep ira, simple ira, pension, retirement, keogh, thrift savings plan`; otherwise **investments**
- anything else → other

Credit and loans are liabilities, so **net worth = assets − liabilities**, using `current` balances.

**Categories** (Plaid personal finance category → our key, with the label in brackets):
- `FOOD_AND_DRINK_GROCERIES` (detailed) → groceries [Groceries]
- any other `FOOD_AND_DRINK` → dining [Dining out]
- `TRANSPORTATION` → transport [Transport]
- `GENERAL_MERCHANDISE` → shopping [Shopping]
- `RENT_AND_UTILITIES` → bills [Bills & utilities]
- `HOME_IMPROVEMENT` → home [Home]
- `MEDICAL` → health [Health]
- `PERSONAL_CARE` → personal [Personal care]
- `ENTERTAINMENT` → entertainment [Entertainment]
- `TRAVEL` → travel [Travel]
- `GENERAL_SERVICES` → services [Services]
- `GOVERNMENT_AND_NON_PROFIT` → giving [Gifts & giving]
- `BANK_FEES` → fees [Fees]
- `LOAN_PAYMENTS` → loans [Loan payments], **except** `LOAN_PAYMENTS_CREDIT_CARD_PAYMENT` → transfer
- `INCOME` → income
- `TRANSFER_IN` / `TRANSFER_OUT` → transfer
- anything else → other

`kind` = transfer | income | spend, set from the category. A negative amount in a spending category is a **refund**: it reduces that category's total. Transfers and income never count as spending. Pending transactions count.

## 5. API

All routes are JSON and require the session unless noted otherwise.

```
POST   /api/auth/login            {password}        (public, rate-limited) → sets cookie
POST   /api/auth/logout
GET    /api/auth/me
POST   /api/plaid/link-token      {itemId?}         (itemId ⇒ update mode)
POST   /api/plaid/exchange        {public_token, institution}  → create item, encrypt, initial sync
POST   /api/plaid/webhook                           (public, signature-verified)
POST   /api/internal/sync                           (public, OIDC-verified, scheduler only)
POST   /api/sync                                    → sync all now (debounced: max once per 60s)
GET    /api/summary?range=1M|3M|1Y|ALL   → { netWorth, assets, liabilities, delta, deltaLabel,
                                             series:[{date,value}], groups:[{group,total,count,subtitle}],
                                             lastSyncAt }
GET    /api/accounts                     → accounts grouped, plus items with status
PATCH  /api/accounts/:id          {hidden}
GET    /api/transactions?kind=&q=&before=&limit=50   → { days:[{date,label,items[]}], nextCursor,
                                                         monthSpent, monthEarned }
PATCH  /api/transactions/:id      {category, applyToMerchant?:boolean}
GET    /api/transactions.csv?month=YYYY-MM
GET    /api/budgets?month=YYYY-MM        → { limit, spent, left, pct, daysLeft,
                                             categories:[{key,label,limit,spent,over}] }
PUT    /api/budgets               {limits:{key:number}}
GET    /api/cashflow                     → { asOf, horizonDate, cashNow, projected, bills:n, paydays:n,
                                             upcoming:[{date,description,amount,direction}],
                                             weekly:[{weekStart,value,projected:boolean}] }
DELETE /api/items/:id                    → /item/remove + delete its accounts and transactions
```

**Summary:** the series comes from `snapshots` within the range. The delta is the latest value minus the earliest value in the range. If there's only one snapshot, the delta is 0 and the chart shows a flat line.

**Cash flow forecast:**
1. `cashNow` = the sum of `current` across cash accounts.
2. For each active recurring stream, project its occurrences over the next 30 days from `predictedNextDate`, or from `lastDate` plus the frequency (WEEKLY, BIWEEKLY, SEMI_MONTHLY, MONTHLY, ANNUALLY), using `averageAmount`.
3. `projected` = `cashNow` + inflows − outflows.
4. `weekly` = 4 past weeks of actual end-of-week cash (from snapshots) plus 2 to 4 projected weeks.

**Budgets:** `daysLeft` is counted in `America/Denver` (`APP_TIMEZONE`). Every date calculation uses that timezone.

## 6. Frontend requirements

Follow `ui/DESIGN_SPEC.md` exactly. In short:
- Four tabs: **Home · Activity · Budgets · Wealth**, plus a **Login** screen and a **Settings** bottom sheet opened from the "DS" avatar.
- The PWA setup, safe areas and 16px inputs listed in the spec are required, and so are the custom pull-to-refresh, bottom sheets and 44pt targets.
- **Plaid Link:** use `react-plaid-link`, both for linking new accounts and for update mode from Wealth → Connections → "Reconnect".
- **Data fetching:** a small `api.ts` wrapper that always sends `X-Requested-With`, plus **TanStack Query** for caching, with sensible `staleTime` values. A 401 response sends the user to Login.
- Money is formatted with `Intl.NumberFormat('en-US', {style:'currency', currency:'USD'})`. Net-worth cents are split out for the hero display.
- Charts: SVG paths generated from the series data, with scrubbing on touch-drag (pointer events). Use the gold stroke described in the spec.
- Write accessible markup as described in the spec. Test at 390×844 and 430×932 in Safari's responsive mode, or on a real device through the deployed URL.

## 7. Repo layout

```
/web            React app (vite.config.ts with /api proxy to :8080 for dev)
/server         Express API (src/index.ts, routes/, lib/{db,crypto,plaid,sync,categories,dates}.ts)
/infra          Terraform (providers.tf, variables.tf, apis.tf, iam.tf, artifact_registry.tf,
                firestore.tf, kms.tf, secrets.tf, run.tf, scheduler.tf, domain.tf, outputs.tf)
/scripts        bootstrap.sh, set-secrets.sh, dev.sh
/.github/workflows/deploy.yml
Dockerfile, .dockerignore, README.md, .env.example
```

## 8. Infrastructure and deploy

**`scripts/bootstrap.sh <PROJECT_ID> <github_owner/repo> [region]`** is run once by Drew with `gcloud`. It must be idempotent. It:
1. Enables the APIs that bootstrapping needs (IAM, IAM Credentials, STS, Cloud Resource Manager, Service Usage, Storage).
2. Creates a versioned GCS bucket for Terraform state, `<project>-tfstate`.
3. Creates a `deployer` SA with the roles Terraform needs: run.admin, artifactregistry.admin, datastore.owner, secretmanager.admin, cloudkms.admin, cloudscheduler.admin, iam.serviceAccountAdmin, iam.serviceAccountUser, resourcemanager.projectIamAdmin, serviceusage.serviceUsageAdmin, and storage.admin on the state bucket.
4. Creates a Workload Identity pool and an OIDC provider for GitHub, with the attribute condition `assertion.repository == '<owner/repo>'`, and grants `roles/iam.workloadIdentityUser` on the deployer SA.
5. Sets the GitHub repository **variables** with `gh variable set` if `gh` is installed, and otherwise prints them: `GCP_PROJECT_ID`, `GCP_REGION`, `WIF_PROVIDER`, `DEPLOYER_SA`, `TF_STATE_BUCKET`, `APP_DOMAIN` (optional), `PLAID_ENV`.

**GitHub secrets:** `PLAID_CLIENT_ID`, `PLAID_SECRET`, `APP_PASSWORD_HASH`.

**Terraform:**
- Enables the run, artifactregistry, firestore, secretmanager, cloudkms, cloudscheduler and iamcredentials APIs.
- Creates the Artifact Registry repo `reserve`.
- Creates the Firestore database `finance` (`FIRESTORE_NATIVE`, location variable defaulting to `nam5`, delete protection on) and its indexes.
- Creates the KMS keyring `reserve` and the key `plaid-tokens`.
- Creates **secret containers** for `plaid-client-id`, `plaid-secret` and `app-password-hash`. Their values are added by the workflow, not Terraform, so they never land in state. Also creates `session-secret`, filled from `random_password` (that one is in state, and the bucket is private; note this in the README).
- Creates the runtime and scheduler SAs with the IAM bindings above.
- Creates the Cloud Run v2 service:
  - **env:** `NODE_ENV=production`, `PLAID_ENV`, `FIRESTORE_DATABASE=finance`, `KMS_KEY_NAME`, `APP_TIMEZONE=America/Denver`, `PUBLIC_URL`, `SCHEDULER_SA_EMAIL`.
  - **secret env** (version `latest`): the four secrets.
  - Starts on the placeholder image `us-docker.pkg.dev/cloudrun/container/hello`, with `lifecycle { ignore_changes = [template[0].containers[0].image] }`, so CI owns the image.
  - Sets the `allUsers` invoker.
- Creates the Scheduler job (`0 */6 * * *`, `America/Denver`, OIDC).
- Creates the optional domain mapping.
- **Outputs:** service URL, domain DNS records, AR repo path.

**`.github/workflows/deploy.yml`:**
- **Triggers:** `workflow_dispatch` (the one click, with an optional `plaid_env` override) and `push` to `main`.
- **Steps:**
  1. Check out the repo, authenticate with `google-github-actions/auth@v2` through WIF, then set up gcloud and Terraform.
  2. `terraform init -backend-config=bucket=$TF_STATE_BUCKET`, then `terraform apply -auto-approve` with the variables.
  3. **Upsert secret versions:** add a new version only if the value differs from `latest`. Use `printf %s "$VAL" | gcloud secrets versions add … --data-file=-`, and never echo the values.
  4. Build the image with Docker and push it, tagged `:${{ github.sha }}` and `:latest`.
  5. `gcloud run services update reserve --image …:${{ github.sha }} --region $GCP_REGION`.
  6. Smoke test: `curl -fsS $URL/api/health`.
  7. Post the URL to the job summary.
- Use `concurrency: deploy-${{ github.ref }}`.

## 9. Local development

- `scripts/dev.sh` runs the Firestore emulator (`gcloud emulators firestore start`), the server on :8080 with `tsx watch`, and Vite on :5173 with an `/api` proxy.
- `.env.example` lists every variable, with Plaid sandbox, `DEV_ENCRYPTION_KEY`, and an unset `KMS_KEY_NAME`.
- Add a `/api/dev/seed` route that works only when `NODE_ENV !== 'production'`. It links a Plaid sandbox item through `/sandbox/public_token/create` (institution `ins_109508`), so the UI has real-looking data with no clicking.

## 10. Milestones and acceptance criteria

1. **Skeleton:** the repo, Dockerfile, health route, Login, and an empty tab shell in the Alpine Reserve style. It runs locally.
2. **Plaid sandbox end to end:** link an account, run the initial sync, and see accounts and transactions in Firestore, with access tokens stored only as `kms:`/`dev:` ciphertext.
3. **Screens:** Home, Activity, Budgets and Wealth on live data, matching the mockups at 390×844, including the empty, loading and error states.
4. **Infrastructure:** bootstrap, then a one-click deploy to a fresh project, ending with an HTTPS URL that works from an iPhone added to the home screen. The scheduler sync runs, and the webhook verifies a sandbox `SYNC_UPDATES_AVAILABLE`, fired with `/sandbox/item/fire_webhook`.
5. **Hardening:** tests for the webhook verifier, category mapping, the forecast projection, and the auth middleware (Vitest). Run `npm audit`, then `terraform validate` and `tflint`.

**Done means:**
- Lighthouse PWA "installable" passes.
- No text fails 4.5:1 contrast.
- No secret values appear in Terraform state other than the session secret.
- No Plaid tokens appear in logs or API responses.
- The README walks through: bootstrap → set GitHub secrets → click Deploy → add DNS records → add to the iPhone home screen.

## 11. Ground rules

- Ask Drew before adding any paid GCP service beyond those listed: Cloud Run, Firestore, KMS, Secret Manager, Scheduler and Artifact Registry. A load balancer is the main one to watch for.
- Keep it single-user. No multi-tenant abstractions.
- Use real sample data only through the Plaid sandbox. Don't hard-code fake numbers in the app.
- Commit in small, logical steps that match the milestones.
