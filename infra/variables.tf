variable "project_id" {
  type        = string
  description = "Projet Google Cloud dédié, avec facturation activée."
}
variable "region" {
  type    = string
  default = "europe-west1"
}
variable "name" {
  type    = string
  default = "calendar-sync"
}
variable "image" {
  type        = string
  description = "Image publiée dans Artifact Registry ; préférer une référence par digest."
}
variable "alert_email" {
  type        = string
  description = "Destinataire des alertes d'exploitation."
}
variable "scheduler_enabled" {
  type        = bool
  default     = false
  description = "Activer après aperçu et première synchronisation contrôlée."
}
variable "secret_versions" {
  type = object({
    config        = string
    credentials-a = string
    credentials-b = string
  })
  default     = { config = "1", credentials-a = "1", credentials-b = "1" }
  description = "Versions numériques explicites : changer la version crée une révision Cloud Run. Jamais de contenu secret dans Terraform."
  validation {
    condition     = alltrue([for version in values(var.secret_versions) : can(regex("^[1-9][0-9]*$", version))])
    error_message = "Utiliser des numéros de versions, pas latest."
  }
}
