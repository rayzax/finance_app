terraform {
  required_version = ">= 1.5.0"

  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "~> 6.0"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.6"
    }
  }

  # The bucket is supplied at init time:
  #   terraform init -backend-config=bucket=<project>-tfstate
  backend "gcs" {
    prefix = "reserve"
  }
}

provider "google" {
  project = var.project_id
  region  = var.region
}
