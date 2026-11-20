#!/usr/bin/env bash
# One-time (idempotent) bootstrap of a GCP project for Reserve deploys.
# Usage: scripts/bootstrap.sh <PROJECT_ID> <github_owner/repo> [region]
# Optional env: APP_DOMAIN (custom domain), PLAID_ENV (default sandbox)
set -euo pipefail

if [[ $# -lt 2 || $# -gt 3 ]]; then
  echo "Usage: $0 <PROJECT_ID> <github_owner/repo> [region]" >&2
  exit 1
fi

PROJECT_ID="$1"
REPO="$2"
REGION="${3:-us-central1}"
[[ "$REPO" == */* ]] || { echo "Repo must look like owner/repo" >&2; exit 1; }

BUCKET="${PROJECT_ID}-tfstate"
SA_NAME="deployer"
SA_EMAIL="${SA_NAME}@${PROJECT_ID}.iam.gserviceaccount.com"
POOL="github"
PROVIDER="github-actions"

gcloud config set project "$PROJECT_ID" >/dev/null 2>&1 || true
PROJECT_NUMBER="$(gcloud projects describe "$PROJECT_ID" --format='value(projectNumber)')"

echo "==> Enabling bootstrap APIs"
gcloud services enable \
  iam.googleapis.com iamcredentials.googleapis.com sts.googleapis.com \
  cloudresourcemanager.googleapis.com serviceusage.googleapis.com \
  storage.googleapis.com --project "$PROJECT_ID"

echo "==> Terraform state bucket gs://${BUCKET}"
if ! gcloud storage buckets describe "gs://${BUCKET}" --project "$PROJECT_ID" >/dev/null 2>&1; then
  gcloud storage buckets create "gs://${BUCKET}" --project "$PROJECT_ID" \
    --location "$REGION" --uniform-bucket-level-access --public-access-prevention
fi
gcloud storage buckets update "gs://${BUCKET}" --versioning >/dev/null

echo "==> Deployer service account ${SA_EMAIL}"
if ! gcloud iam service-accounts describe "$SA_EMAIL" --project "$PROJECT_ID" >/dev/null 2>&1; then
  gcloud iam service-accounts create "$SA_NAME" --project "$PROJECT_ID" \
    --display-name "Reserve Terraform deployer"
  # IAM is eventually consistent; give the new account a moment.
  sleep 10
fi

ROLES=(
  roles/run.admin
  roles/artifactregistry.admin
  roles/datastore.owner
  roles/secretmanager.admin
  roles/cloudkms.admin
  roles/cloudscheduler.admin
  roles/iam.serviceAccountAdmin
  roles/iam.serviceAccountUser
  roles/resourcemanager.projectIamAdmin
  roles/serviceusage.serviceUsageAdmin
)
for role in "${ROLES[@]}"; do
  gcloud projects add-iam-policy-binding "$PROJECT_ID" \
    --member "serviceAccount:${SA_EMAIL}" --role "$role" \
    --condition=None --quiet >/dev/null
done
gcloud storage buckets add-iam-policy-binding "gs://${BUCKET}" \
  --member "serviceAccount:${SA_EMAIL}" --role roles/storage.admin >/dev/null

echo "==> Workload Identity pool/provider for ${REPO}"
if ! gcloud iam workload-identity-pools describe "$POOL" --location global \
  --project "$PROJECT_ID" >/dev/null 2>&1; then
  gcloud iam workload-identity-pools create "$POOL" --location global \
    --project "$PROJECT_ID" --display-name "GitHub Actions"
fi

PROVIDER_ARGS=(
  --location global --project "$PROJECT_ID" --workload-identity-pool "$POOL"
  --issuer-uri "https://token.actions.githubusercontent.com"
  --attribute-mapping "google.subject=assertion.sub,attribute.repository=assertion.repository,attribute.repository_owner=assertion.repository_owner"
  --attribute-condition "assertion.repository == '${REPO}'"
)
if gcloud iam workload-identity-pools providers describe "$PROVIDER" --location global \
  --project "$PROJECT_ID" --workload-identity-pool "$POOL" >/dev/null 2>&1; then
  gcloud iam workload-identity-pools providers update-oidc "$PROVIDER" "${PROVIDER_ARGS[@]}"
else
  gcloud iam workload-identity-pools providers create-oidc "$PROVIDER" "${PROVIDER_ARGS[@]}" \
    --display-name "GitHub OIDC"
fi

gcloud iam service-accounts add-iam-policy-binding "$SA_EMAIL" --project "$PROJECT_ID" \
  --role roles/iam.workloadIdentityUser \
  --member "principalSet://iam.googleapis.com/projects/${PROJECT_NUMBER}/locations/global/workloadIdentityPools/${POOL}/attribute.repository/${REPO}" \
  >/dev/null

WIF_PROVIDER="projects/${PROJECT_NUMBER}/locations/global/workloadIdentityPools/${POOL}/providers/${PROVIDER}"

declare -A VARS=(
  [GCP_PROJECT_ID]="$PROJECT_ID"
  [GCP_REGION]="$REGION"
  [WIF_PROVIDER]="$WIF_PROVIDER"
  [DEPLOYER_SA]="$SA_EMAIL"
  [TF_STATE_BUCKET]="$BUCKET"
)
[[ -n "${APP_DOMAIN:-}" ]] && VARS[APP_DOMAIN]="$APP_DOMAIN"

echo "==> GitHub repository variables"
if command -v gh >/dev/null 2>&1 && gh auth status >/dev/null 2>&1; then
  for k in "${!VARS[@]}"; do
    gh variable set "$k" --repo "$REPO" --body "${VARS[$k]}"
    echo "set $k"
  done
  # Do not clobber an existing PLAID_ENV (it may already be "production").
  if ! gh variable get PLAID_ENV --repo "$REPO" >/dev/null 2>&1; then
    gh variable set PLAID_ENV --repo "$REPO" --body "${PLAID_ENV:-sandbox}"
    echo "set PLAID_ENV"
  fi
  [[ -n "${APP_DOMAIN:-}" ]] || echo "(APP_DOMAIN not set; optional. Re-run with APP_DOMAIN=reserve.example.com to add one.)"
else
  echo "gh not available or not logged in. Add these repository variables manually"
  echo "(Settings > Secrets and variables > Actions > Variables):"
  for k in "${!VARS[@]}"; do echo "  ${k}=${VARS[$k]}"; done
  echo "  PLAID_ENV=${PLAID_ENV:-sandbox}"
  echo "  APP_DOMAIN=<optional custom domain>"
fi

echo
echo "Bootstrap complete. Next: scripts/set-secrets.sh ${REPO}, then run the Deploy workflow."
