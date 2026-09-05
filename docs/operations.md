# OAuth et exploitation

## Autoriser les deux comptes

1. Dans un projet Google Cloud maîtrisé, activer **Google Calendar API**. Le projet OAuth peut être distinct du projet d’hébergement.
2. Configurer l’écran de consentement, les deux utilisateurs de test si nécessaire et un client **Application de bureau**. Télécharger son JSON hors Git. Ne pas utiliser un client Web ou une délégation de domaine.
3. Lancer localement `node dist/cli.js configure --client /chemin/protege/client.json`. Garder ce terminal ouvert pendant les deux connexions et sélectionner explicitement A puis B. La réception OAuth écoute uniquement sur `127.0.0.1`, sur un port aléatoire, avec PKCE et contrôle `state` ; elle expire après trois minutes.
4. Choisir les vrais identifiants de calendrier, pas l’alias `primary`. La liste est filtrée sur les droits `writer` ou `owner`. Les deux autorisations sont stockées séparément dans `secrets/A.credentials.json` et `secrets/B.credentials.json` avec le mode `0600`.

Scopes demandés : `calendar.events` et `calendar.calendarlist.readonly`. Google ne propose pas un scope limité à ces deux identifiants : **la restriction au calendrier sélectionné est appliquée par le programme**, pas par le jeton. Choisir si possible des calendriers et comptes dédiés au test. Les identités IAM Cloud Run/Firestore n’autorisent pas l’accès aux calendriers. [Flux OAuth des applications installées](https://developers.google.com/identity/protocols/oauth2/native-app).

### Autorisation durable

Un consentement externe laissé en mode **Testing** produit généralement un refresh token expirant après sept jours avec ces scopes. Configurer le consentement de production selon les règles Google ; « production » ne signifie pas automatiquement « application vérifiée ». La vérification, les exceptions d’usage personnel et les restrictions de l’administrateur Workspace dépendent de l’audience. Ne pas contourner une politique de domaine. Un jeton peut aussi être révoqué ou expirer ultérieurement : prévoir la procédure ci-dessous. [Expiration des jetons Google](https://developers.google.com/identity/protocols/oauth2#expiration), [vérification des applications](https://support.google.com/cloud/answer/9110914).

### Renouveler un accès

- Suspendre Scheduler ou arrêter le worker. Conserver la base : **ne pas réinitialiser les associations**.
- Relancer `configure` avec `-c /nouveau/dossier/config.json`, dans un dossier existant et protégé, et autoriser les comptes nécessaires. Cette V1 refait les deux autorisations ; elle refuse d’écraser les fichiers existants. En cas de configuration interrompue, reprendre dans un nouveau dossier plutôt que détruire des secrets sans vérification.
- Vérifier que les calendriers sélectionnés correspondent exactement à la configuration d’exploitation. Ne pas remplacer cette dernière par une nouvelle paire ou une base vierge. Remplacer uniquement les fichiers d’autorisation concernés, ou ajouter les versions Secret Manager correspondantes.
- Redémarrer le worker ; sur Cloud Run, mettre à jour les numéros `secret_versions` dans Terraform et déployer la nouvelle révision. Les clients OAuth sont chargés au démarrage.
- Faire `preview`, un passage contrôlé, puis reprendre l’exécution périodique.

Ne jamais communiquer les refresh tokens dans un ticket ou une conversation. Révoquer les anciens accès inutilisés après validation du nouvel accès, en vérifiant la portée de la révocation Google.

## Comprendre les résultats

- `success` : lectures et traitement du passage terminés. Des conflits peuvent subsister ; les autres associations continuent.
- `pending` : progression persistée, à poursuivre au passage suivant. Ce n’est pas un succès pour l’alerte de retard.
- `busy` : un autre passage/admin détient le verrou. Aucun second traitement n’est lancé.
- `auth_revoked` / `access_denied` : renouveler le consentement ou rétablir les droits, sans toucher à l’état.
- `operation_recheck` : Google a refusé une version ou signalé un identifiant déjà utilisé. Le passage suivant relit et recalcule.
- `state_identity_mismatch` : mauvaise configuration ou mauvais export. Ne pas forcer l’import.

`status` fournit le dernier succès, le retard, la dernière erreur, les compteurs et les identifiants des copies masquées. Les logs JSON du moteur ne contiennent ni titre, ni description, ni participants, ni jetons. La sortie interactive de `configure` montre les noms/identifiants des calendriers ; ne pas la collecter dans les logs Cloud Run.

## Résoudre un conflit

```sh
node dist/cli.js conflicts
node dist/cli.js resolve IDENTIFIANT --choose A
```

Le choix porte sur les champs synchronisés, pas sur les invités ou les rappels. Les deux ETags sont relus avant toute action ; si la résolution est périmée, inspecter `conflicts --refresh` et choisir à nouveau. Un original simple supprimé peut être recréé avec un nouvel identifiant si la copie survivante est choisie ; les champs hors synchronisation ne sont alors pas restaurés. Une réunion organisée supprimée doit être restaurée dans Google avant de choisir sa version vivante : le programme ne reconstruit pas les invités d’une réunion annulée.

Pour `duplicate`, utiliser `--separate` seulement si ce sont deux rendez-vous indépendants, ou `--skip` pour les laisser hors synchronisation. Il n’existe pas de fusion automatique approximative.

Pour `unsafe`, retirer manuellement de la copie les invités ou la conférence ajoutés, puis `conflicts --refresh`. Pour `missing`, vérifier les droits et restaurer la ressource dans Google si nécessaire. Une erreur 404 isolée n’est jamais une preuve de suppression.

Pour `split`, rétablir la règle de la copie et effectuer la scission sur l’original. Les nouveaux morceaux placés en revue restent bloqués ; les supprimer s’ils sont accidentels. Après revue, `resolve ID --skip` peut exclure un fragment/orphelin non associé. Cela ne supprime aucun événement Google. Ne pas enlever les marqueurs pour provoquer une nouvelle copie ni exclure sans examen une copie légitime.

## Sauvegarde et changement d’hébergement

Les bases et exports contiennent les détails originaux, y compris privés. Le masquage protège la copie, **pas la base de synchronisation**. Protéger le disque, les IAM et les sauvegardes ; ne pas les mettre dans Git. L’export ne contient pas les fichiers OAuth : les sauvegarder séparément et de façon chiffrée.

```sh
node dist/cli.js -c /chemin/source.json state export /sauvegardes/etat-unique.json
node dist/cli.js -c /chemin/destination.json state import /sauvegardes/etat-unique.json
node dist/cli.js -c /chemin/destination.json preview
```

Pour migrer : arrêter la source, attendre la fin du passage/verrou, exporter, importer dans un stockage vide, vérifier l’aperçu, puis démarrer la destination. Conserver `pairId` et les deux `calendarId` à l’identique ; seuls stockage et chemins de secrets changent. **Ne jamais lancer les deux installations avec des états indépendants.** Un import interrompu peut être relancé avec exactement le même fichier ; son marqueur empêche toute synchronisation partielle. Un export vers un nom existant est refusé.

Une sauvegarde SQLite brute nécessite l’arrêt du worker et la prise en compte du WAL ; privilégier `state export`. Firestore est configuré avec protection contre la suppression et récupération à un instant donné. Une restauration d’une ancienne sauvegarde demande toujours un aperçu et un contrôle des opérations en attente avant reprise.
