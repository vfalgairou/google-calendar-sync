locals {
  apis    = toset(["run.googleapis.com", "firestore.googleapis.com", "cloudscheduler.googleapis.com", "secretmanager.googleapis.com", "artifactregistry.googleapis.com", "monitoring.googleapis.com", "logging.googleapis.com", "iam.googleapis.com"])
  secrets = toset(["config", "credentials-a", "credentials-b"])
}
resource "google_project_service" "api" {
  for_each           = local.apis
  project            = var.project_id
  service            = each.key
  disable_on_destroy = false
}
resource "google_artifact_registry_repository" "images" {
  location      = var.region
  repository_id = var.name
  format        = "DOCKER"
  depends_on    = [google_project_service.api]
}
resource "google_firestore_database" "state" {
  project                           = var.project_id
  name                              = "(default)"
  location_id                       = var.region
  type                              = "FIRESTORE_NATIVE"
  concurrency_mode                  = "PESSIMISTIC"
  delete_protection_state           = "DELETE_PROTECTION_ENABLED"
  point_in_time_recovery_enablement = "POINT_IN_TIME_RECOVERY_ENABLED"
  depends_on                        = [google_project_service.api]
}
resource "google_service_account" "runtime" {
  account_id   = "${var.name}-runtime"
  display_name = "Calendar sync runtime (no domain-wide delegation)"
  depends_on   = [google_project_service.api]
}
resource "google_service_account" "scheduler" {
  account_id   = "${var.name}-scheduler"
  display_name = "Calendar sync scheduler invoker"
  depends_on   = [google_project_service.api]
}
resource "google_project_iam_member" "firestore" {
  project = var.project_id
  role    = "roles/datastore.user"
  member  = "serviceAccount:${google_service_account.runtime.email}"
}
resource "google_secret_manager_secret" "runtime" {
  for_each  = local.secrets
  secret_id = "${var.name}-${each.key}"
  replication {
    user_managed {
      replicas { location = var.region }
    }
  }
  depends_on = [google_project_service.api]
}
resource "google_secret_manager_secret_iam_member" "reader" {
  for_each  = local.secrets
  secret_id = google_secret_manager_secret.runtime[each.key].id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.runtime.email}"
}
resource "google_cloud_run_v2_service" "sync" {
  name                = var.name
  location            = var.region
  deletion_protection = true
  ingress             = "INGRESS_TRAFFIC_ALL"
  template {
    service_account                  = google_service_account.runtime.email
    max_instance_request_concurrency = 1
    timeout                          = "90s"
    scaling {
      min_instance_count = 0
      max_instance_count = 1
    }
    containers {
      image = var.image
      args  = ["serve"]
      resources {
        limits   = { cpu = "1", memory = "512Mi" }
        cpu_idle = true
      }
      ports { container_port = 8080 }
      env {
        name  = "SYNC_CONFIG"
        value = "/secrets/config/config.json"
      }
      volume_mounts {
        name       = "config"
        mount_path = "/secrets/config"
      }
      volume_mounts {
        name       = "credentials-a"
        mount_path = "/secrets/A"
      }
      volume_mounts {
        name       = "credentials-b"
        mount_path = "/secrets/B"
      }
      startup_probe {
        initial_delay_seconds = 0
        period_seconds        = 5
        failure_threshold     = 12
        http_get {
          path = "/healthz"
          port = 8080
        }
      }
    }
    dynamic "volumes" {
      for_each = local.secrets
      content {
        name = volumes.value
        secret {
          secret       = google_secret_manager_secret.runtime[volumes.value].secret_id
          default_mode = 292
          items {
            version = var.secret_versions[volumes.value]
            path    = volumes.value == "config" ? "config.json" : "credentials.json"
          }
        }
      }
    }
  }
  depends_on = [google_secret_manager_secret_iam_member.reader, google_project_iam_member.firestore, google_firestore_database.state]
}
resource "google_cloud_run_v2_service_iam_member" "invoke" {
  name     = google_cloud_run_v2_service.sync.name
  location = var.region
  role     = "roles/run.invoker"
  member   = "serviceAccount:${google_service_account.scheduler.email}"
}
resource "google_cloud_scheduler_job" "sync" {
  name             = var.name
  region           = var.region
  schedule         = "*/2 * * * *"
  time_zone        = "Etc/UTC"
  paused           = !var.scheduler_enabled
  attempt_deadline = "90s"
  retry_config {
    retry_count        = 0
    max_retry_duration = "0s"
  }
  http_target {
    http_method = "POST"
    uri         = "${google_cloud_run_v2_service.sync.uri}/sync"
    oidc_token {
      service_account_email = google_service_account.scheduler.email
      audience              = google_cloud_run_v2_service.sync.uri
    }
  }
  depends_on = [google_cloud_run_v2_service_iam_member.invoke]
}
resource "google_monitoring_notification_channel" "email" {
  display_name = "Calendar sync exploitation"
  type         = "email"
  labels       = { email_address = var.alert_email }
  depends_on   = [google_project_service.api]
}
resource "google_logging_metric" "success" {
  name   = "${var.name}-success"
  filter = "resource.type=\"cloud_run_revision\" AND resource.labels.service_name=\"${var.name}\" AND jsonPayload.event=\"sync_success\""
  metric_descriptor {
    metric_kind = "DELTA"
    value_type  = "INT64"
    unit        = "1"
  }
  depends_on = [google_project_service.api]
}
resource "google_monitoring_alert_policy" "stale" {
  display_name          = "${var.name}: aucun succès depuis 10 minutes"
  combiner              = "OR"
  enabled               = var.scheduler_enabled
  notification_channels = [google_monitoring_notification_channel.email.name]
  conditions {
    display_name = "Absence de passage réussi"
    condition_absent {
      filter   = "metric.type=\"logging.googleapis.com/user/${google_logging_metric.success.name}\" AND resource.type=\"cloud_run_revision\""
      duration = "600s"
      aggregations {
        alignment_period     = "60s"
        per_series_aligner   = "ALIGN_DELTA"
        cross_series_reducer = "REDUCE_SUM"
      }
    }
  }
}
resource "google_monitoring_alert_policy" "action" {
  display_name          = "${var.name}: conflit ou accès Google à renouveler"
  combiner              = "OR"
  enabled               = var.scheduler_enabled
  notification_channels = [google_monitoring_notification_channel.email.name]
  conditions {
    display_name = "Action requise"
    condition_matched_log {
      filter = "resource.type=\"cloud_run_revision\" AND resource.labels.service_name=\"${var.name}\" AND (jsonPayload.event=\"auth_revoked\" OR jsonPayload.event=\"access_denied\" OR jsonPayload.event=\"new_conflict\")"
    }
  }
  alert_strategy {
    notification_rate_limit { period = "300s" }
    auto_close = "1800s"
  }
}
output "service_url" { value = google_cloud_run_v2_service.sync.uri }
output "image_repository" { value = "${var.region}-docker.pkg.dev/${var.project_id}/${google_artifact_registry_repository.images.repository_id}" }
