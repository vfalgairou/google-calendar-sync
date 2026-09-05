# Google Calendar Sync

Synchronisation bidirectionnelle d’une paire de calendriers Google, en TypeScript / Node.js 24. Une image Docker, deux modes d’hébergement : **Cloud Run + Firestore** ou **serveur dédié + SQLite**.

Le moteur, la CLI, les tests et l’infrastructure sont implémentés. **La recette sur deux comptes Google de test reste indispensable avant toute utilisation réelle.** Aucun compte, secret ou déploiement n’est fourni. Les configurations d’exemple désactivent les écritures.

## Démarrage local

Prérequis : Node.js 24, npm, un client OAuth Google « Application de bureau » et deux calendriers de test sur lesquels les comptes choisis ont le droit d’écrire.

```sh
npm ci
npm run check
node dist/cli.js configure --client /chemin/protege/client-oauth.json
node dist/cli.js preview
```

`configure` ouvre le navigateur deux fois, fait choisir les calendriers et crée `config.json` avec `allowWrites: false`. Après examen de l’aperçu, modifier ce seul paramètre en `true`, puis :

```sh
node dist/cli.js sync
node dist/cli.js preview
node dist/cli.js status
```

Attendre un passage `success` puis un aperçu sans nouvelle écriture avant d’activer l’exécution périodique. Un résultat `pending` signifie que le budget du passage est atteint : relancer `sync`, les points de progression sont conservés. Ne jamais supprimer l’état pour recommencer.

## Règles importantes

| Événement | Depuis l’original | Depuis sa copie |
|---|---|---|
| Rendez-vous sans invités | Création, édition, suppression propagées | Édition et suppression propagées |
| Réunion organisée par le compte | Miroir des champs synchronisés | Édition de l’original avec `sendUpdates=all` ; suppression = copie masquée |
| Invitation reçue | Miroir sans réponse à l’invitation | Édition locale écrasée par l’original ; suppression = copie masquée |
| Original privé/confidentiel | Copie « Occupé », sans description ni lieu | Horaires modifiables ; texte original jamais remplacé par le masque |

Champs partagés : titre, description, lieu, début, fin, fuseau, disponibilité et récurrence. Journées entières conservées. Les copies sont privées dans le calendrier cible, sans invités, Meet, pièce jointe ni rappel ; un lien `source` renvoie vers l’original. Les couleurs et rappels existants restent locaux. Les données d’organisation et les participants ne sont jamais copiés ou remplacés.

La date plancher est fixée au premier `sync` à activation − 30 jours, sans limite future. Une série active est conservée entière, même ancienne ; les événements associés ne sont jamais purgés. Les événements spéciaux Google sont exclus. Les réunions natives reconnues des deux côtés restent gérées par Google, sans troisième copie. Les doublons seulement ressemblants nécessitent une décision.

Les modifications concurrentes bloquent uniquement l’association concernée. Pour les réunions récurrentes, les modifications de champs courants et d’occurrence sont prises en charge ; **toute modification structurelle de récurrence sur une copie de réunion est conservativement bloquée**. Faire les scissions « cet événement et les suivants » sur l’original. Voir les limites précises dans [l’architecture](docs/architecture.md).

## Commandes

Toutes acceptent `-c /chemin/config.json` avant le nom de la commande, ou `SYNC_CONFIG`. Les chemins contenus dans la configuration sont relatifs au répertoire d’exécution, pas au fichier ; privilégier les chemins absolus.

| Commande | Usage |
|---|---|
| `configure --client <json>` | Deux autorisations OAuth et sélection explicite |
| `preview` | Plan sans écrire dans Calendar ni avancer l’état actif |
| `sync` | Un passage borné |
| `run` | Boucle toutes les 120 secondes, serveur dédié |
| `serve` | HTTP `POST /sync` et `GET /healthz`, Cloud Run privé |
| `status [--check]` | Diagnostic ; `--check` échoue après 10 min sans succès |
| `conflicts [--refresh]` | Différences détaillées / revalidation des versions |
| `resolve <id> --choose A` | Choisir A ou B pour un conflit concurrent |
| `resolve <id> --separate` | Deux événements réellement distincts : créer leurs copies |
| `resolve <id> --skip` | Exclure les deux événements d’un doublon suspect |
| `restore-copy <pairId>` | Rétablir une copie volontairement masquée |
| `state export <fichier>` | Export cohérent et protégé, sans écraser de fichier |
| `state import <fichier>` | Import dans un état vide, même identité de calendriers |

L’aide est en français ; les résultats structurés utilisent des clés stables en anglais. `conflicts` et les exports contiennent des données sensibles : ne pas les envoyer dans des journaux partagés.

## Installation et exploitation

- [OAuth, renouvellement, conflits, sauvegarde et migration](docs/operations.md)
- [Docker Compose et déploiement Cloud Run avec Terraform](docs/deployment.md)
- [Architecture, garanties et limites](docs/architecture.md)
- [Tests automatisés et recette Google réelle](docs/testing.md)

## Vérification sans accès Google

```sh
npm run check
docker compose -f compose.test.yaml up -d
# Attendre que http://127.0.0.1:8686 réponde.
FIRESTORE_EMULATOR_HOST=127.0.0.1:8686 npm run test:firestore
docker compose -f compose.test.yaml down
docker buildx build --platform linux/amd64,linux/arm64 --output=type=cacheonly .
terraform -chdir=infra init -backend=false
terraform -chdir=infra validate
```

Le double Calendar est local ; l’émulateur Firestore utilise le projet fictif `calendar-sync-test`. Aucun test automatisé ne lit les calendriers personnels. La CI exécute ces vérifications sans publier d’image ni déployer.
