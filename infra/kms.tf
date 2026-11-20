resource "google_kms_key_ring" "reserve" {
  name     = "reserve"
  location = var.region

  depends_on = [google_project_service.apis]
}

resource "google_kms_crypto_key" "plaid_tokens" {
  name            = "plaid-tokens"
  key_ring        = google_kms_key_ring.reserve.id
  rotation_period = "7776000s" # 90 days
  purpose         = "ENCRYPT_DECRYPT"

  lifecycle {
    prevent_destroy = true
  }
}
