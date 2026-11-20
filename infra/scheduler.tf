resource "google_cloud_scheduler_job" "sync" {
  name        = "reserve-sync"
  region      = var.region
  description = "Sync all Plaid items every 6 hours"
  schedule    = "0 */6 * * *"
  time_zone   = var.app_timezone

  attempt_deadline = "180s"

  retry_config {
    retry_count = 1
  }

  http_target {
    http_method = "POST"
    uri         = "${local.run_service_url}/api/internal/sync"

    oidc_token {
      service_account_email = google_service_account.scheduler.email
      audience              = local.run_service_url
    }
  }

  depends_on = [
    google_project_service.apis,
    google_cloud_run_v2_service_iam_member.scheduler_invoker,
  ]
}
