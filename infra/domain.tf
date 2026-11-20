# Optional custom domain. Requires the deployer service account to be a verified
# owner of the domain in Google Search Console (see README).
resource "google_cloud_run_domain_mapping" "app" {
  count    = var.app_domain != "" ? 1 : 0
  name     = var.app_domain
  location = var.region

  metadata {
    namespace = var.project_id
  }

  spec {
    route_name = google_cloud_run_v2_service.reserve.name
  }
}
