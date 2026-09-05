# Hébergement Docker

Faire d’abord la [recette OAuth et Google](testing.md). Les commandes ci-dessous sont des instructions de déploiement, **elles ne sont pas exécutées automatiquement**. Les paramètres `PROJECT_ID`, image et destinataire sont à fournir ; aucun projet métier n’est supposé.

## Serveur dédié : SQLite

1. Construire l’image avec `docker compose build`.
2. Effectuer `configure` sur le poste local avec navigateur. Transférer les deux fichiers d’autorisation par un canal protégé vers `./secrets/` sur le serveur, sans les ajouter à Git.
3. Créer `secrets/config.json` à partir de `examples/config.docker.json` avec les deux vrais `calendarId`, `pairId` inchangé, et ces chemins dans le conteneur : `/secrets/A.credentials.json`, `/secrets/B.credentials.json`, base `/data/state.sqlite`. Garder `allowWrites: false` pour l’aperçu.
4. Autoriser la lecture des secrets par l’UID 1000 de l’image (propriétaire ou ACL ciblée), sans les rendre lisibles par tous. Répertoire secret `0700`, fichiers `0600`. Avec Docker rootless/user namespaces, adapter les UID mappés. Ne pas exécuter le synchroniseur en root pour contourner ces droits.
5. Exécuter l’aperçu dans le même volume que le futur worker :

```sh
docker compose run --rm sync preview
```

Après validation, passer `allowWrites` à `true` dans `secrets/config.json`, puis :

```sh
docker compose run --rm sync sync
docker compose run --rm sync preview
docker compose run --rm sync status
docker compose up -d
docker compose logs --tail 30 sync
```

L’image est non privilégiée, la racine est en lecture seule, aucun port n’est publié. Le volume `sync-data` persiste la base WAL. `docker compose down` conserve le volume ; **ne pas utiliser `down -v` sur l’installation réelle**. Le worker synchronise toutes les 120 s. Le contrôle de santé signale plus de dix minutes sans succès ; configurer la supervision externe du serveur pour recevoir les alertes (Docker seul n’envoie pas de courriel).

Administration : `docker compose exec sync status`, `docker compose exec sync conflicts`, etc. Pour une sauvegarde, arrêter le worker puis utiliser un conteneur ponctuel avec un répertoire de sauvegardes monté explicitement et accessible à l’UID 1000 :

```sh
docker compose stop sync
docker compose run --rm -v /chemin/protege/sauvegardes:/backup sync state export /backup/etat-unique.json
docker compose up -d
```

Ne pas donner aux conteneurs un accès au socket Docker. Pour publier une image multiarchitecture dans votre registre : `docker buildx build --platform linux/amd64,linux/arm64 --tag REGISTRE/IMAGE:VERSION --push .` ; conserver le digest retenu.

## Cloud Run : Firestore et IAM

### Ressources prévues

Terraform crée dans un projet dédié : APIs nécessaires à l’hébergement, Artifact Registry, Firestore Native régional avec protection de suppression/PITR, deux comptes de service distincts, trois conteneurs de secrets **sans leur contenu**, Cloud Run privé, Scheduler OIDC toutes les deux minutes et alertes Monitoring. La région par défaut est `europe-west1`.

Cloud Run utilise la facturation à la requête, `min=0`, `max=1`, concurrence 1 et timeout 90 s. Les secrets sont lus via montages, Firestore via l’identité d’exécution. Aucune autorisation Calendar n’est donnée aux comptes de service. Le service n’accorde jamais `allUsers`. Le programme HTTP ne vérifie pas lui-même un JWT : **la barrière d’authentification est IAM Cloud Run** ; ne pas publier ce serveur derrière un proxy ouvert. [Appels Scheduler authentifiés](https://docs.cloud.google.com/run/docs/triggering/using-scheduler).

Le compte runtime a `roles/datastore.user` sur le projet et `secretAccessor` uniquement sur les trois secrets. Ce rôle Firestore est large à l’échelle de la base : utiliser un projet dédié. Le compte Scheduler n’a que `run.invoker` sur ce service. L’administrateur local utilise son propre ADC et ses propres fichiers OAuth.

### Bootstrap en deux phases

Prérequis : projet facturé choisi, Google Cloud CLI/Terraform/Docker installés, droits de déploiement vérifiés et consentement OAuth déjà préparé. Ne pas réutiliser un projet contenant une base `(default)` sans revue : importer une ressource existante dans Terraform exige une décision explicite. Prévoir un backend Terraform protégé si plusieurs administrateurs interviennent ; aucun backend distant n’est créé implicitement.

Créer un fichier local `infra/terraform.tfvars` (ignoré par Git) :

```hcl
project_id        = "VOTRE_PROJET"
image             = "europe-west1-docker.pkg.dev/VOTRE_PROJET/calendar-sync/sync:VERSION"
alert_email       = "VOTRE_DESTINATAIRE"
scheduler_enabled = false
secret_versions   = { config = "1", credentials-a = "1", credentials-b = "1" }
```

Vérifier l’identité/projet et le plan avant chaque `apply`. **Phase 1**, bootstrap ciblé nécessaire avant de publier l’image et d’alimenter les secrets :

```sh
gcloud auth list
gcloud config get-value project
gcloud auth application-default login
terraform -chdir=infra init
terraform -chdir=infra plan -out=bootstrap.tfplan \
  -target=google_artifact_registry_repository.images \
  -target=google_secret_manager_secret.runtime \
  -target=google_firestore_database.state
terraform -chdir=infra apply bootstrap.tfplan
```

Le ciblage est réservé à ce bootstrap ; les vérifications ultérieures utilisent le plan complet. Il ne contourne pas une erreur IAM ou une ressource existante.

Construire/publier l’image, sans secrets dans le contexte Docker :

```sh
gcloud auth configure-docker europe-west1-docker.pkg.dev
docker buildx build --platform linux/amd64,linux/arm64 \
  -t europe-west1-docker.pkg.dev/VOTRE_PROJET/calendar-sync/sync:VERSION --push .
```

Remplacer ensuite `image` dans les variables par la référence `.../sync@sha256:DIGEST` obtenue lors de la publication.

Créer un fichier protégé `secrets/cloud-run.config.json` basé sur `examples/config.cloud-run.json` : vrais calendriers, projet Firestore, mêmes `pairId`, `allowWrites: false`, chemins `/secrets/A/credentials.json` et `/secrets/B/credentials.json`. Ajouter les payloads **hors Terraform** pour ne pas inscrire les refresh tokens dans le state :

```sh
gcloud secrets versions add calendar-sync-config --project=VOTRE_PROJET --data-file=secrets/cloud-run.config.json
gcloud secrets versions add calendar-sync-credentials-a --project=VOTRE_PROJET --data-file=secrets/A.credentials.json
gcloud secrets versions add calendar-sync-credentials-b --project=VOTRE_PROJET --data-file=secrets/B.credentials.json
```

Reporter les numéros de versions réellement retournés dans `secret_versions`. **Phase 2** :

```sh
terraform -chdir=infra plan -out=deployment.tfplan
terraform -chdir=infra apply deployment.tfplan
terraform -chdir=infra output service_url
```

Scheduler reste suspendu et les alertes désactivées. Vérifier que la requête non authentifiée au service est refusée. Le déploiement seul ne prouve pas que Calendar est accessible.

### Première mise en service

Sur le poste administrateur, utiliser une configuration Firestore **avec les chemins locaux des deux secrets OAuth**, mêmes calendriers et même paire. ADC doit disposer des droits d’accès à cette base ; ne pas télécharger de clé de compte de service pour cela. Ne pas fournir la configuration aux chemins `/secrets/...` à la CLI locale.

1. `preview` local vers cette base Firestore, sans écrire.
2. Passer `allowWrites` à `true` dans la configuration locale et faire `sync` jusqu’au premier `success`.
3. Vérifier `preview` sans écritures supplémentaires, les événements et les notifications sur les comptes de test.
4. Passer `allowWrites` à `true` dans le JSON destiné à Cloud Run ; ajouter une version de `calendar-sync-config` et actualiser `secret_versions.config` dans Terraform. Appliquer ce changement en gardant Scheduler suspendu.
5. Déclencher une exécution contrôlée : `gcloud scheduler jobs run calendar-sync --location=europe-west1 --project=VOTRE_PROJET`. Si l’environnement refuse un déclenchement de job suspendu, l’opérateur peut appeler le service avec une identité explicitement autorisée `run.invoker` ; ne jamais ouvrir le service au public.
6. Vérifier un log Cloud Run `sync_success`, puis `status` via la CLI locale. C’est important : une métrique d’absence ne peut pas surveiller une série qui n’a jamais émis de point.
7. Passer `scheduler_enabled=true`, examiner et appliquer le plan. Vérifier la réception des alertes avec les scénarios de recette. Confirmer le destinataire du canal Monitoring si Google le demande.

La métrique de succès déclenche une alerte après 600 s d’absence, avec la latence normale de Monitoring. Les nouveaux conflits et accès révoqués produisent une alerte sur log, limitée à une notification par cinq minutes par politique. Ce n’est pas une garantie de livraison instantanée d’un courriel.

### Rotation et maintenance

Les secrets utilisent des versions numériques, pas `latest`. Chaque changement de version provoque une nouvelle révision du service ; un client OAuth déjà chargé ne doit pas garder un ancien refresh token en mémoire. [Secrets Cloud Run](https://docs.cloud.google.com/run/docs/configuring/services/secrets).

Avant migration ou maintenance de l’état, mettre `scheduler_enabled=false`, appliquer, puis attendre le passage actif et l’expiration/libération de son verrou. Sauvegarder par la CLI. Ne pas exécuter une boucle locale indépendante en parallèle. Cloud Run peut transitoirement chevaucher deux révisions malgré la limite d’instances : le verrou persistant reste la protection effective.

La tarification inclut Firestore, Scheduler, stockage d’images/secrets et Monitoring, même si Cloud Run n’a pas d’instance minimale. Aucune promesse de gratuité : contrôler le coût réel et le nombre de lectures Firestore pendant la recette.
