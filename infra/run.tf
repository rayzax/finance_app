data "google_project" "this" {
  project_id = var.project_id
}

locals {
  # Deterministic Cloud Run v2 URL. Computing it here (instead of reading the
  # service's own uri attribute) avoids a dependency cycle, because the URL is
  # needed in the service's env vars and in the scheduler job.
  run_service_url = "https://reserve-${data.google_project.this.number}.${var.region}.run.app"
  public_url      = var.app_domain != "" ? "https://${var.app_domain}" : local.run_service_url
}

resource "google_cloud_run_v2_service" "reserve" {
  name                = "reserve"
  location            = var.region
  ingress             = "INGRESS_TRAFFIC_ALL"
  deletion_protection = false

  template {
    service_account = google_service_account.runtime.email

    scaling {
      min_instance_count = 0
      max_instance_count = 2
    }

    containers {
      # Placeholder; CI owns the image (see ignore_changes below).
      image = "us-docker.pkg.dev/cloudrun/container/hello"

      resources {
        limits = {
          cpu    = "1"
          memory = "512Mi"
        }
      }

      env {
        name  = "NODE_ENV"
        value = "production"
      }
      env {
        name  = "PLAID_ENV"
        value = var.plaid_env
      }
      env {
        name  = "FIRESTORE_DATABASE"
        value = google_firestore_database.finance.name
      }
      env {
        name  = "GOOGLE_CLOUD_PROJECT"
        value = var.project_id
      }
      env {
        name  = "KMS_KEY_NAME"
        value = google_kms_crypto_key.plaid_tokens.id
      }
      env {
        name  = "APP_TIMEZONE"
        value = var.app_timezone
      }
      env {
        name  = "PUBLIC_URL"
        value = local.public_url
      }
      env {
        name  = "RUN_SERVICE_URL"
        value = local.run_service_url
      }
      env {
        name  = "SCHEDULER_SA_EMAIL"
        value = google_service_account.scheduler.email
      }

      dynamic "env" {
        for_each = local.runtime_secrets
        content {
          name = env.key
          value_source {
            secret_key_ref {
              secret  = env.value
              version = "latest"
            }
          }
        }
      }
    }
  }

  lifecycle {
    ignore_changes = [
      template[0].containers[0].image,
      template[0].labels,
      labels,
      client,
      client_version,
    ]
  }

  # Secret access must exist before the revision is created, and every referenced
  # secret needs at least one version (the workflow adds them in phase 1).
  depends_on = [
    google_project_service.apis,
    google_secret_manager_secret_iam_member.runtime,
    google_secret_manager_secret_version.session,
    google_kms_crypto_key_iam_member.runtime,
    google_project_iam_member.runtime_datastore,
  ]
}
