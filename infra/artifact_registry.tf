resource "google_artifact_registry_repository" "reserve" {
  location      = var.region
  repository_id = "reserve"
  format        = "DOCKER"
  description   = "Reserve container images"

  # Keep storage costs near zero: retain only the most recent images.
  cleanup_policy_dry_run = false
  cleanup_policies {
    id     = "keep-recent"
    action = "KEEP"
    most_recent_versions {
      keep_count = 10
    }
  }

  depends_on = [google_project_service.apis]
}
