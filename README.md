# Reserve

A private personal finance app for one household (iPhone-first PWA) on GCP. Bank data comes from Plaid. React + Vite frontend and an Express API ship as one container on Cloud Run. Everything is Terraform, and deploys are one click from GitHub Actions with no JSON keys.

## Deploy to a fresh GCP project

Prerequisites: `gcloud` (logged in as a project owner), `gh` (optional but recommended), a GCP project with billing enabled, and a GitHub repo containing this code.

### 1. Bootstrap (once)

```bash
gcloud auth login
scripts/bootstrap.sh <PROJECT_ID> <github_owner/repo> [region]    # region defaults to us-central1
# optional custom domain: APP_DOMAIN=reserve.example.com scripts/bootstrap.sh ...
```

This is idempotent. It enables the bootstrap APIs, creates the versioned state bucket `<project>-tfstate`, the `deployer` service account, and a Workload Identity pool and provider restricted to your repo (`assertion.repository == 'owner/repo'`), and sets the repository variables `GCP_PROJECT_ID, GCP_REGION, WIF_PROVIDER, DEPLOYER_SA, TF_STATE_BUCKET, PLAID_ENV` (and `APP_DOMAIN` if given). Without `gh`, it prints them for you to add under Settings > Secrets and variables > Actions > Variables.

### 2. Set GitHub secrets

```bash
scripts/set-secrets.sh <github_owner/repo>
```

It prompts (no echo) for `PLAID_CLIENT_ID` and `PLAID_SECRET`, and generates `APP_PASSWORD_HASH` from the password you choose (via `npm run hash-password`). The secrets live in GitHub only until the workflow copies them into Secret Manager.

### 3. Click Deploy

Actions > Deploy > Run workflow (it also runs on every push to `main`). The workflow:

1. Authenticates through Workload Identity Federation.
2. `terraform apply` phase 1: APIs plus the secret containers and the generated session secret. Cloud Run fails to create a revision that references a secret with no versions, so the secret values must exist before the service does.
3. Upserts the three secret versions (a new version only if the value differs from `latest`; values are never printed).
4. `terraform apply` phase 2: everything else (Firestore `finance` + indexes, KMS, Artifact Registry, service accounts, Cloud Run, Scheduler, domain mapping).
5. Builds and pushes the image, updates the Cloud Run service, smoke-tests `/api/health`, and writes the URL (and DNS records) to the job summary.

You can override the Plaid environment per run with the `plaid_env` input.

### 4. Add DNS records (custom domain, optional)

Set the `APP_DOMAIN` repository variable (for example `reserve.example.com`) and re-run Deploy. The domain mapping uses `google_cloud_run_domain_mapping`, which needs the **deployer service account to be a verified owner of the domain** in Google Search Console:

1. Verify the domain (or its parent) in Search Console with your own account (DNS TXT record).
2. In Search Console > Settings > Users and permissions, add `deployer@<PROJECT_ID>.iam.gserviceaccount.com` as an **Owner**.
3. Re-run Deploy. Create the DNS records listed in the job summary (or `terraform -chdir=infra output domain_dns_records`) at your DNS provider. Certificate provisioning can take up to an hour.

Without a domain, use the `*.run.app` URL from the summary.

### 5. Add to the iPhone home screen

Open the URL in Safari, sign in, tap Share, then **Add to Home Screen**. On first use, link a bank from the Wealth tab.

## Local development

Requirements: Node 22, `gcloud` with the Firestore emulator component (`gcloud components install cloud-firestore-emulator beta`), and **Java 21+** (the emulator needs it).

```bash
cp .env.example .env            # fill in Plaid sandbox keys, hash, DEV_ENCRYPTION_KEY (openssl rand -hex 32)
                                # first sign-in: username BOOTSTRAP_ADMIN_USERNAME + that password, then enroll an authenticator
(cd server && npm ci && npm run hash-password)   # paste the output into APP_PASSWORD_HASH
(cd web && npm ci)
scripts/dev.sh
```

`scripts/dev.sh` starts the emulator (:8081), the API (:8080, `tsx watch`) and Vite (:5173, proxying `/api`), and stops them all on Ctrl-C. With `KMS_KEY_NAME` unset, Plaid tokens are encrypted with AES-256-GCM using `DEV_ENCRYPTION_KEY`. In non-production, `POST /api/dev/seed` links a Plaid sandbox item.

## Accounts & MFA

Everyone in the household sees the same finance data; accounts only control who can sign in. Roles: `admin` (can manage people) and `member` (can use the whole app). **TOTP two-step sign-in is required for every account.**

- **First sign-in (bootstrap).** While the `users` collection is empty, signing in as `BOOTSTRAP_ADMIN_USERNAME` (default `drew`) with the password behind `APP_PASSWORD_HASH` creates that account as an admin (`BOOTSTRAP_ADMIN_NAME`, default `Drew`) and goes straight to authenticator setup. Scan the QR code, enter the code, and save the ten recovery codes (shown once). Once any user exists, `APP_PASSWORD_HASH` is ignored for login; leave the secret in place, nothing in the infra changes.
- **Adding people.** Settings > People > Add person (admins only). You get a generated temporary password to pass on out of band. At their first sign-in they must choose their own password first and only then set up their authenticator, so whoever issued the temporary password cannot enrol a device on that account.
- **Lost phone.** Sign in with a recovery code (each works once), or an admin uses People > Reset two-step sign-in, and the person re-enrolls at next sign-in. Admins can also reset a password. Anyone can change their display name under Settings > Your name. Settings > Recovery codes issues a fresh set (needs a current authenticator code).
- **Revoking access.** Disabling, deleting or resetting a person (and changing a password) bumps their `sessionVersion`, which signs out every device within 30 seconds at most. Rotating `SESSION_SECRET` still signs out everyone.
- **Storage.** `users/{id}` plus `usernames/{username}` (uniqueness, via a transaction). Passwords are bcrypt cost 12. TOTP secrets are encrypted with the same KMS key as the Plaid tokens (`kms:` prefix; AES-GCM with `DEV_ENCRYPTION_KEY` in dev). Recovery codes are stored only as HMAC-SHA256 hashes keyed from `SESSION_SECRET` (so rotating that secret also invalidates unused recovery codes). Auth events are logged as structured JSON (ids, usernames, IP), never passwords, codes or secrets.
- **Not recoverable by design:** if the only admin loses both their authenticator and their recovery codes, delete the `users` and `usernames` documents in Firestore; the bootstrap login then works again.

## Plaid environments

- **Sandbox**: fake data, test login `user_good` / `pass_good`. Default.
- **Production**: real banks. Plaid shut down the *Development* environment in 2024, so there is nothing between the two. Limited Production access is enough for personal use. To switch: put the Production secret in `PLAID_SECRET` (`scripts/set-secrets.sh`), set the `PLAID_ENV` repository variable to `production` (or choose it in the Deploy run), and deploy. Re-link your accounts afterwards, since sandbox items do not carry over.

## Security model

- Named accounts with required TOTP MFA (see [Accounts & MFA](#accounts--mfa)); HS256 session JWT in an `httpOnly; Secure; SameSite=Strict` cookie (30 days), revocable per user. Login is limited to 5 failed attempts per 15 minutes per IP and 10 per account. State-changing requests also need `X-Requested-With: reserve`.
- `helmet` with a CSP limited to what Plaid Link needs, plus HSTS.
- Plaid webhooks are verified (ES256 JWT, `iat` age, SHA-256 of the raw body). `/api/internal/sync` accepts only an OIDC token from the scheduler service account with the service URL as audience.
- Plaid `access_token`s are encrypted with Cloud KMS (key `plaid-tokens`, 90-day rotation) before they reach Firestore, and are never sent to the browser or logged.
- Cloud Run is publicly invocable (`allUsers`) because the app has its own login. No load balancer, no WAF.
- Least privilege: the runtime SA has `datastore.user`, `secretAccessor` on its four secrets only, and `cloudkms.cryptoKeyEncrypterDecrypter` on the one key. The scheduler SA has `run.invoker` on the service only. There are no service account keys anywhere; CI uses WIF, limited to this repo.
- **Terraform state**: the Plaid and password-hash values are added by the workflow and never touch state. The generated `session-secret` **is** in state (it comes from `random_password`). The state bucket is private (public access prevention, uniform access) and versioned; only the deployer SA (storage.admin on that bucket) and project owners can read it. Treat the bucket accordingly. To rotate the session secret (which signs out all sessions): `terraform -chdir=infra apply -replace=random_password.session` with your usual `-var`s, then redeploy.
- Note the deployer SA is powerful (project IAM admin). It can only be assumed by workflows from your repo, so protect the repo (branch protection on `main`).

## Costs

Only these services are used: Cloud Run (min instances 0, max 2, 1 vCPU / 512Mi), Firestore, Cloud KMS (one key), Secret Manager (four secrets), Cloud Scheduler (one job; the first three are free per billing account), and Artifact Registry (only the 10 most recent images are kept). For one user this is typically a few cents to a couple of dollars per month, mostly KMS and Secret Manager. Plaid has its own pricing for Production. There is no load balancer.

## Layout

```
web/      React + Vite PWA          server/   Express API
infra/    Terraform                 scripts/  bootstrap, set-secrets, dev
Dockerfile  .github/workflows/deploy.yml  .env.example
```

Validate infrastructure locally: `terraform -chdir=infra init -backend=false && terraform -chdir=infra validate && tflint --chdir=infra`.
