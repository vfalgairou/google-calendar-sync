# Architecture et contrat de sécurité

## Organisation

- `google.ts` : accès REST Calendar via la bibliothèque OAuth officielle ; scopes et calendriers explicites, requêtes conditionnelles.
- `content.ts` : projection, confidentialité, comparaison canonique et calcul calendaire des occurrences avec Temporal.
- `engine.ts` : ingestion, décisions, journal d’écritures, conflits et reprise.
- `store.ts` : contrat transactionnel partagé Memory/SQLite/Firestore, snapshots et verrou à génération.
- `state.ts` : transfert versionné et reprise d’import.
- `cli.ts`, `auth.ts`, `server.ts` : administration locale, consentement, worker et HTTP privé.

## Passage et reprise

1. Acquérir un verrou de 90 s, renouvelé toutes les 20 s et avant les appels significatifs. Toute écriture d’état vérifie la génération et l’expiration du verrou.
2. Ingestérer les pages des deux calendriers ; persister ensemble chaque page et son curseur. Tant que les deux côtés ne sont pas prêts, aucune écriture Calendar.
3. Vérifier les disparitions lors d’une reconstruction complète ; rejouer le journal uniquement après relecture des ressources.
4. Comparer les champs aux dernières versions communes, puis enregistrer l’opération avant de l’exécuter.
5. Enregistrer le résultat réel, les baselines correspondant à l’opération et les compteurs. Répondre HTTP après le passage, jamais avec une tâche détachée.

Une création utilise un ID déterministe compatible Google et des propriétés privées `gcsPair` / `gcsLink`. Une réponse perdue est donc retrouvée à l’identique. Une modification utilise `If-Match` ; après une réponse perdue, le contenu réellement présent est vérifié avant tout rejeu, notamment avant une notification d’organisateur. Une nouvelle édition faite entre la coupure et la reprise reste distincte du dernier état commun.

Les lectures incrémentales utilisent `syncToken`, `showDeleted=true`, `singleEvents=false`, sans `timeMin` ni filtre incompatible. `410` remplace seulement la génération du cache de lecture ; liens, exclusions, conflits et journal restent en place. Un événement absent d’une nouvelle liste ou d’un GET est une anomalie, pas une annulation. [Synchronisation incrémentale Google](https://developers.google.com/workspace/calendar/api/guides/sync), [modification conditionnelle](https://developers.google.com/workspace/calendar/api/guides/version-resources).

Les lectures réseau sont bornées et les erreurs transitoires réessayées avec attente exponentielle et aléa. Les écritures ne sont pas rejouées aveuglément : le journal les remet en vérification au passage suivant ; pour les limitations/indisponibilités, il conserve une attente exponentielle de deux à trente minutes. Un résultat incertain déjà appliqué est reconnu même pendant cette attente. Les transactions Firestore ne font aucun appel Calendar. Les passages ont un budget configurable de 45 s par défaut ; un appel déjà parti peut dépasser le budget jusqu’à son timeout. Le journal rend récupérable une interruption brutale de conteneur.

## Réunions et récurrences

`organizer.self=false` signifie invitation reçue ; un original organisateur avec invités est une réunion organisée ; sinon c’est un rendez-vous simple. Le moteur ne modifie ni participants, ni réponses, ni réservations, ni conférences. Un miroir auquel un utilisateur ajoute des invités ou une conférence passe en revue avant toute propagation.

Les séries restent des séries RRULE/RDATE/EXDATE ; seules les exceptions sont traitées individuellement. La recherche d’une série encore active utilise au plus une occurrence future. Une occurrence est associée par la série parente et `originalStartTime`, pas par sa nouvelle heure après déplacement. Son premier état commun est reconstruit à partir de la série, ce qui permet de détecter deux premières modifications concurrentes. Les durées calendaires et les zones IANA préservent les changements d’heure et les journées entières. [Récurrences Google](https://developers.google.com/workspace/calendar/api/guides/recurringevents).

Les modifications structurelles d’une copie de réunion bloquent la série et mettent les nouveaux maîtres récurrents du même côté en revue. Cette règle est volontairement plus conservatrice qu’une simple détection de `UNTIL` : on ne sait pas prouver que deux nouveaux morceaux proviennent d’une scission. Les modifications de titre/lieu/description/horaire de série et d’occurrence restent possibles. La restauration explicite d’une copie de série réassocie ses exceptions et conserve les suppressions individuelles.

## Limites à connaître avant mise en service

- V1 mono-paire et usage personnel ; pas de multi-utilisateurs ni de service public.
- Pas de transaction distribuée entre deux calendriers. Un utilisateur peut modifier la source juste après sa lecture ; les ETags empêchent l’écrasement concurrent de la cible, puis le passage suivant traite la source. Une notification déjà envoyée par Google ne peut pas être annulée.
- Les mêmes réunions présentes nativement des deux côtés restent sous gestion Google, avec les droits natifs de chaque compte. Le synchroniseur ne donne pas au participant les droits de l’organisateur.
- La restauration d’un rendez-vous simple supprimé peut changer son URL/ID. Une réunion supprimée avec participants ne peut pas être recréée depuis sa copie par cette V1.
- Les anomalies `missing`, `orphan`, `unsafe` et les scissions nécessitent une revue humaine. Pas de réparation destructive automatique ni de fusion approximative.
- Le GET peut ne plus exposer un tombstone ancien : l’association reste alors bloquée plutôt que supprimer une copie à tort. Garder les passages réguliers.
- Les bases gardent le cache et l’historique des liens sans purge automatique. Google est lu de façon incrémentale, mais le snapshot d’état Firestore est chargé à chaque passage : **les lectures Firestore et la mémoire croissent avec l’état total**. Mesurer volume, durée et coût lors de la recette ; ce stockage n’est pas optimisé pour des millions d’événements.
- Le masque « Occupé » laisse volontairement les horaires et la disponibilité visibles dans la copie. Le lien vers l’original ne contourne pas ses droits Google.
- `GET /healthz` vérifie la vie du processus, pas la validité OAuth. La fraîcheur vient de `status --check` et de l’alerte de dernier succès.
- SQLite utilise uniquement un disque local persistant. Aucun SQLite sur Cloud Storage/NFS, ni sur le disque éphémère Cloud Run. [Contrat Cloud Run](https://docs.cloud.google.com/run/docs/container-contract).

Les tests avec un double Google prouvent les décisions et reprises sur les réponses simulées, pas le comportement complet du service Google. La [recette réelle](testing.md) est un gate explicite avant production.
