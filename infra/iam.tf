resource "google_service_account" "runtime" {
  account_id   = "reserve-runtime"
  display_name = "Reserve Cloud Run runtime"

  depends_on = [google_project_service.apis]
}

resource "google_service_account" "scheduler" {
  account_id   = "reserve-scheduler"
  display_name = "Reserve Cloud Scheduler invoker"

  depends_on = [google_project_service.apis]
}

locals {
  runtime_member = "serviceAccount:${google_service_account.runtime.email}"

  # Every secret the runtime reads, keyed by its Cloud Run env var name.
  runtime_secrets = {
    PLAID_CLIENT_ID   = google_secret_manager_secret.external["plaid-client-id"].secret_id
    PLAID_SECRET      = google_secret_manager_secret.external["plaid-secret"].secret_id
    APP_PASSWORD_HASH = google_secret_manager_secret.external["app-password-hash"].secret_id
    SESSION_SECRET    = google_secret_manager_secret.session.secret_id
  }
}

# Firestore access (project level; the role has no narrower scope for a named database
# without IAM conditions, and this project holds only Reserve).
resource "google_project_iam_member" "runtime_datastore" {
  project = var.project_id
  role    = "roles/datastore.user"
  member  = local.runtime_member
}

# Secret access, granted per secret (not on the project).
resource "google_secret_manager_secret_iam_member" "runtime" {
  for_each  = local.runtime_secrets
  secret_id = each.value
  role      = "roles/secretmanager.secretAccessor"
  member    = local.runtime_member
}

# Encrypt/decrypt on the single key only.
resource "google_kms_crypto_key_iam_member" "runtime" {
  crypto_key_id = google_kms_crypto_key.plaid_tokens.id
  role          = "roles/cloudkms.cryptoKeyEncrypterDecrypter"
  member        = local.runtime_member
}

# Scheduler SA may only invoke this one service.
resource "google_cloud_run_v2_service_iam_member" "scheduler_invoker" {
  project  = var.project_id
  location = var.region
  name     = google_cloud_run_v2_service.reserve.name
  role     = "roles/run.invoker"
  member   = "serviceAccount:${google_service_account.scheduler.email}"
}

# The app has its own login, so the service is publicly invocable.
resource "google_cloud_run_v2_service_iam_member" "public" {
  project  = var.project_id
  location = var.region
  name     = google_cloud_run_v2_service.reserve.name
  role     = "roles/run.invoker"
  member   = "allUsers"
}
