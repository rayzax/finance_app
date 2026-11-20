variable "project_id" {
  description = "GCP project ID that hosts Reserve."
  type        = string
}

variable "region" {
  description = "Region for Cloud Run, Artifact Registry and Cloud Scheduler."
  type        = string
  default     = "us-central1"
}

variable "firestore_location" {
  description = "Location of the Firestore database (multi-region such as nam5, or a region)."
  type        = string
  default     = "nam5"
}

variable "plaid_env" {
  description = "Plaid environment: sandbox or production."
  type        = string
  default     = "sandbox"

  validation {
    condition     = contains(["sandbox", "production"], var.plaid_env)
    error_message = "plaid_env must be \"sandbox\" or \"production\"."
  }
}

variable "app_domain" {
  description = "Optional custom domain (for example reserve.example.com). Empty disables the domain mapping."
  type        = string
  default     = ""
}

variable "app_timezone" {
  description = "IANA timezone used for all date calculations and the sync schedule."
  type        = string
  default     = "America/Denver"
}
