output "service_name" {
  description = "Cloud Run service name."
  value       = google_cloud_run_v2_service.reserve.name
}

output "service_url" {
  description = "Public URL of the app (custom domain if configured, else the run.app URL)."
  value       = local.public_url
}

output "run_service_url" {
  description = "Deterministic run.app URL (OIDC audience, used for smoke tests)."
  value       = local.run_service_url
}

output "ar_repo" {
  description = "Artifact Registry image path (append :tag)."
  value       = "${var.region}-docker.pkg.dev/${var.project_id}/${google_artifact_registry_repository.reserve.repository_id}/reserve"
}

output "domain_dns_records" {
  description = "DNS records to create at your DNS provider (empty if no custom domain)."
  value = var.app_domain == "" ? [] : [
    for r in try(google_cloud_run_domain_mapping.app[0].status[0].resource_records, []) : {
      name   = r.name != "" ? r.name : var.app_domain
      type   = r.type
      rrdata = r.rrdata
    }
  ]
}

output "runtime_service_account" {
  value = google_service_account.runtime.email
}

output "scheduler_service_account" {
  value = google_service_account.scheduler.email
}

output "kms_key_name" {
  value = google_kms_crypto_key.plaid_tokens.id
}
