resource "google_firestore_database" "finance" {
  project                 = var.project_id
  name                    = "finance"
  location_id             = var.firestore_location
  type                    = "FIRESTORE_NATIVE"
  delete_protection_state = "DELETE_PROTECTION_ENABLED"

  depends_on = [google_project_service.apis]
}

resource "google_firestore_index" "transactions_kind_date" {
  project    = var.project_id
  database   = google_firestore_database.finance.name
  collection = "transactions"

  fields {
    field_path = "kind"
    order      = "ASCENDING"
  }
  fields {
    field_path = "date"
    order      = "DESCENDING"
  }
}

resource "google_firestore_index" "transactions_month_date" {
  project    = var.project_id
  database   = google_firestore_database.finance.name
  collection = "transactions"

  fields {
    field_path = "month"
    order      = "ASCENDING"
  }
  fields {
    field_path = "date"
    order      = "DESCENDING"
  }
}
