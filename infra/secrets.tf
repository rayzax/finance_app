# Secret containers only. The values of these three are added by the deploy
# workflow (never by Terraform) so they do not land in state.
locals {
  external_secrets = toset(["plaid-client-id", "plaid-secret", "app-password-hash"])
}

resource "google_secret_manager_secret" "external" {
  for_each  = local.external_secrets
  secret_id = each.value

  replication {
    auto {}
  }

  depends_on = [google_project_service.apis]
}

# The session secret is generated here, so it IS stored in Terraform state.
# The state bucket is private and versioned; see the README.
resource "random_password" "session" {
  length  = 64
  special = false
}

resource "google_secret_manager_secret" "session" {
  secret_id = "session-secret"

  replication {
    auto {}
  }

  depends_on = [google_project_service.apis]
}

resource "google_secret_manager_secret_version" "session" {
  secret      = google_secret_manager_secret.session.id
  secret_data = random_password.session.result
}
