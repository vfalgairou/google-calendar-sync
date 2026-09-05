# Vérification et recette

## Tests automatisés locaux

```sh
npm ci
npm run check
npm audit --omit=dev --audit-level=moderate
docker compose -f compose.test.yaml up -d
FIRESTORE_EMULATOR_HOST=127.0.0.1:8686 npm run test:firestore
docker compose -f compose.test.yaml down
terraform -chdir=infra init -backend=false
terraform -chdir=infra fmt -check
terraform -chdir=infra validate
docker buildx build --platform linux/amd64,linux/arm64 --output=type=cacheonly .
```

Attendre la disponibilité de l’émulateur avant ses tests. `test:firestore` échoue si `FIRESTORE_EMULATOR_HOST` manque ; le test ne bascule pas silencieusement vers Google Cloud. Le même contrat et les mêmes scénarios moteur s’exécutent sur SQLite et Firestore. Les noms de paires sont aléatoires et le projet d’émulation est fictif.

Couverture : création bidirectionnelle, convergence sans écriture, suppression, règles de réunion/invitation, confidentialité, journées entières, normalisation DST, doublons natifs et ambigus, résolution périmée, pagination/410, disparition ambiguë, concurrence ETag, journal après succès incertain, exceptions et premières éditions concurrentes, restauration de copies/séries, quarantaine de scission, aperçu sans mutation, transfert et verrou transactionnel. Les tests d’interface vérifient les paramètres HTTP Google et le fait que `/sync` attend le passage.

La CI reproduit ces contrôles. Elle ne publie pas d’image, n’applique pas Terraform et n’utilise aucun OAuth réel.

### Résultat de la validation locale de livraison

Le 5 septembre 2026 : **67 tests réussis**, TypeScript et compilation valides, audit npm de production sans vulnérabilité connue signalée, Terraform `fmt`/`validate` et configurations Compose valides. Les images `linux/amd64` et `linux/arm64` se construisent ; l’image native démarre avec Node 24, UID 1000 et SQLite. La CLI `status` a également été exécutée dans une racine en lecture seule avec un `/data` temporaire.

Le partage de ce répertoire hôte est refusé par la configuration Colima locale : le dernier smoke test a donc transmis la configuration d’exemple sur l’entrée standard, sans montage du dépôt. Le montage de secrets de l’installation Compose réelle reste à vérifier sur l’hôte retenu. L’émulateur temporaire a été arrêté après les tests. Aucun `terraform apply`, publication de registre ou appel à un calendrier Google réel n’a été effectué.

## Gate Google réel — à exécuter avant production

**Non exécuté lors du développement : nécessite deux comptes Google et calendriers de test explicitement autorisés.** Le double Calendar ne modélise pas toutes les règles internes Google (notifications, héritage des exceptions, normalisation des RRULE, restauration de tombstones). Terraform `validate` ne prouve pas un déploiement IAM ni la réception des alertes.

Préparer deux calendriers vides contrôlés, notés A et B, et si nécessaire un troisième compte de test pour les invités externes. Ne jamais inviter de vraies personnes ni réserver de vraies salles pour la recette. Consigner les preuves dans un emplacement protégé hors Git, pas dans les logs applicatifs.

| Scénario | Preuve attendue |
|---|---|
| OAuth A et B, sélection et droits | Comptes/calendriers distincts, lecture et écriture autorisées |
| Aperçu initial puis premier passage | Aperçu sans mutation ; une copie par original ; deux passages suivants sans écriture |
| Création/édition/suppression A et B | Symétrie des rendez-vous simples, absence de résurrection |
| Réunion organisée avec invité de test | Copie sans invité ni Meet, lien d’origine ; édition depuis copie met à jour l’original et notifie uniquement le changement réel |
| Suppression copie de réunion | Original non annulé, invité non notifié, masquage maintenu puis restauration explicite |
| Invitation tierce, même invitation dans A et B | Pas de réponse automatique ; aucune nouvelle copie native ; édition de miroir sans retour au tiers |
| Conflits édition/édition et édition/suppression | Deux versions conservées, autres événements traités, choix A/B revalidé |
| Original privé, puis public→privé | « Occupé », pas de description/lieu ; modifier son masque ne dévoile/écrase pas l’original |
| Journée entière, Paris/New York, changements d’heure | Dates exclusives de fin et instants/fuseaux cohérents dans les deux vues |
| Ancienne série toujours active | Maître entier conservé, aucune expansion infinie |
| Exceptions existantes avant activation | Déplacement, annulation, titre spécifique conservés |
| Édition d’occurrence des deux côtés entre passages | Conflit, pas d’écrasement silencieux |
| Série : titre/horaires puis changement de récurrence depuis original | Propagation des champs et contrôle visuel des exceptions héritées |
| Scission sur la copie puis sur l’original | Copie bloquée et nouveaux morceaux en revue ; scission d’origine correctement représentée |
| Suppression/restauration de copie de série | Exceptions réassociées et occurrences masquées conservées |
| Arrêt du conteneur pendant écriture | Reprise avec même ID, pas de deuxième création ou notification injustifiée |
| Deux appels simultanés / perte de verrou | Un traitement actif, aucun checkpoint d’un ancien propriétaire |
| Révocation OAuth et retrait de droits | Arrêt des effets, diagnostic expurgé, alerte, pas de suppression en cascade |
| Expiration de curseur ou longue absence | Reconstruction sans perte d’associations ni recréation de copies masquées |
| Transfert SQLite↔Firestore, exécution source arrêtée | Même état, aperçu sans recréation ; unique instance active après migration |
| Cloud Run / Scheduler | Service non public, appel OIDC réussi, réponse après fin du passage |
| Monitoring | Succès émis, alerte après absence >10 min, nouveau conflit et accès révoqué notifiés au destinataire prévu |

Critère d’activation : aucun écart inexpliqué, aucun conflit non qualifié, convergence démontrée et sauvegarde d’état restaurable. Si un cas Google diffère des simulations, arrêter la paire et corriger/tester le moteur avant d’activer les calendriers réels.
