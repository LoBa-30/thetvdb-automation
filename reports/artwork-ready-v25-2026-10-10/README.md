# TheTVDB — préparation des artworks V25 (10 octobre 2026)

**ÉTAT : AUCUN UPLOAD AUTORISÉ.** Ce dossier est un inventaire et un plan de validation, **pas** une commande d'ajout. La restriction TheTVDB a été confirmée en lecture seule (run [37962023102](https://github.com/LoBa-30/thetvdb-automation/actions/runs/37962023102)). Une levée ultérieure **n'a pas été confirmée**.

## Sources officielles internes au dépôt

- Manifeste immuable des **192 autorisations d'images initiales** : `reports/artwork-user-approvals-v23-2-2026-10-09.json`.
- **25 refus explicites** (`AUCUNE_IMAGE_ADAPTEE`) : présents dans le manifeste, **ne jamais uploader** même si une URL résiduelle existe.
- **Raska S2018E05**, ID **11960844**, autorisation antérieure isolée mais **bloquée** : aucune inclusion dans la file.
- Contrôle technique 192/192 à 1280×720, aucun doublon exact/proche dans l'ensemble analysé : `reports/artwork-user192-source-preflight-v23-2/report.json`, run 37961140372. **Non équivalent à une approbation éditoriale.**
- 35 anomalies visibles : `reports/artwork-user192-manual-visual-flags-v24-1-2026-10-10.json`.
- 10 premières alternatives visuellement prometteuses, jamais approuvées définitivement : `reports/artwork-user192-fullres-alternatives-review-v24-4-2026-10-10.json`.
- 3 variantes supplémentaires examinées à 1280×720 : `reports/artwork-ready-v25-2026-10-10/extra-visual-review.json`. Raska S2023E06 maxres2 est **refusée** car « +10 € » reste affiché. Deux autres variantes sont de simples seconds choix pour des épisodes déjà couverts.
- `queue.json` : les **192 lignes d'intégrité**, avec l'ID TheTVDB, l'ID YouTube, la variante d'origine, son SHA-256, les indices éditoriaux, toutes les options non approuvées et les étapes restant à faire.
- `needs-new-still-25.json` : 25 épisodes pour lesquels les variantes `maxres1/2/3` n'apportent pas de solution sûre. Rechercher un photogramme réel pertinent sans logo/titre/sous-titre, si un accès légitime à la vidéo est disponible.
- Rapprochement Mastu : `reports/artwork-mastu-26-historical-id-reconciliation-v25-2026-10-10.json`. **25/26** IDs retrouvent une trace dans des rapports antérieurs et 17 codes saisonniers divergent. **Toujours faire correspondre l'identifiant numérique de l'épisode, jamais seulement SxxExx.** L'ID `12014527` n'a pas de correspondance d'archive confirmée ; des contrôles supplémentaires restent nécessaires.

## Statuts de la file de 192

| Statut | Nombre | Action autorisée maintenant |
|---|---:|---|
| Pas d'overlay évident sur planche, conformité finale à revoir | 157 | Inspecter l'image originale en pleine définition et sa provenance, aucune soumission |
| Original signalé, variante alternative pré-sélectionnée | 10 | Vérifier en pleine définition, revalider l'épisode, demander une autorisation expresse pour **changer la variante**, aucune soumission |
| Original signalé, pas d'alternative maxres adaptée | 25 | Chercher une **vraie nouvelle capture vidéo**, aucune soumission |
| Refus de l'utilisateur | 25 hors file | Exclusion permanente tant que l'utilisateur n'a pas explicitement révisé son refus |
| Raska S2018E05 | 1 hors file | Bloqué pour problème texte/logo |

**Aucune des 192 entrées n'est actuellement `uploadReady=true`.** Un SHA correct, un statut `MISSING` ancien ou un aperçu visuellement propre **ne suffit pas**.

## Procédure stricte lors de la levée de restriction

1. **Contrôle préalable sans POST, sur demande explicite** : lancer le diagnostic authentifié en lecture seule via `.github/workflows/artwork-user192-form-restriction-diagnostic-v23-2.yml`. S'il reste un avertissement, un formulaire absent, un CAPTCHA, une erreur 202/401/403/429 ou une ambiguïté : **STOP**. Ne pas multiplier les tentatives.
2. **Lire les notifications pertinentes**, vérifier qu'aucun nouvel avertissement ne remet en cause les propositions, sans les marquer comme lues intentionnellement.
3. **Vérifier un canary unique, avant toute soumission** : candidat potentiel Djilsi S2018E02 / TVDB ID 9242991 / YouTube `k1blyDB6xj4` / `maxres2`. Ce choix original a été autorisé ; sa conformité éditoriale **n'est pas encore certifiée**. Vérifier réellement à 1280×720 : qualité, logos, textes, watermark, spoilers, contenu approprié, bonne scène.
4. **Vérifier l'identité actuelle sur le site** : ID TheTVDB, intitulé de l'épisode, série, année, vidéo d'origine et existence d'une illustration déjà présente. Si une image est déjà présente : **ne rien ajouter** et comparer avant toute modification. Si titre/provenance divergent : **STOP**.
5. **Re-télécharger la source depuis l'URL autorisée et comparer son SHA-256 à celui de la file**. Si le fichier a changé, **STOP** et inspecter de nouveau.
6. **En cas de variante différente de la sélection initiale**, demander l'accord explicite de l'utilisateur sur cette variante précise. L'accord du 9 octobre pour les 192 originaux ne valide pas automatiquement les remplacements.
7. **Canary uniquement**, après nouveau feu vert explicite : réactiver séparément, par modification de code vérifiée, le workflow de test Djilsi volontairement verrouillé. Ne jamais déclencher une vague entière automatiquement, même si le formulaire revient.
8. **Vérification après envoi** : contrôler retour du formulaire, image réellement publiée/acceptée, unicité et conformité. Si soumission de statut incertain : ne pas réessayer à l'aveugle ; noter l'état et investiguer en lecture seule.
9. **Progression progressive soumise à contrôle humain et à la modération**. Conserver les logs, les justificatifs exacts et les hashes ; aucune suppression de masse.

## Règles TheTVDB à respecter

- Image représentative de l'épisode exact, de préférence officielle, sans spoiler, nudité, gore ou vulgarité.
- Image d'origine au moins **640×360 px**, JPEG de bonne qualité ; rapport d'aspect **original de la série**, pas d'étirement ; poids initial inférieur à **10 Mo**.
- Éviter textes, cartes de titre, sous-titres incrustés, logos éditoriaux, marques ajoutées, filigranes de réseaux sociaux, chronomètres, pictogrammes et incrustations de montage.
- Si la meilleure capture contient un élément interdit, trouver un **autre véritable plan de la vidéo** plutôt que masquer, effacer ou inventer un contenu.
- Éviter images identiques ou quasi identiques entre épisodes ; comparer aussi les visuels déjà présents sur TheTVDB.
- Ne pas contourner de challenge YouTube / TheTVDB, pas de compte alternatif et pas de rafales de tentatives après refus HTTP.

## Vérification automatisée sans aucune connexion TheTVDB

Le workflow [V25 staging safety checks](https://github.com/LoBa-30/thetvdb-automation/actions/workflows/artwork-ready-v25-guard.yml) exécute `node src/artwork-ready-v25-queue-guard.mjs` sur les seuls fichiers GitHub. Il échoue si une sélection, un hash, un ID, un refus ou un verrou de soumission est modifié sans justification. Son succès **ne signifie jamais** que les images peuvent être envoyées.

## Interdictions présentes dans les workflows

- L'ancien workflow de canary `artwork-user192-canary-djilsi-s2018e02-v23-2.yml` est **désactivé** (`if: false`, déclenchement manuel uniquement). Son script historique a été conservé en vue d'un futur examen **après** la levée de restriction, et ne doit pas être exécuté pour l'instant.
- Aucun workflow du dossier V25 ne possède de secret TheTVDB, d'appel HTTP POST à TheTVDB, de bouton de suppression ou de possibilité d'envoi massif.
- Ce dossier GitHub ne contient ni mot de passe, ni cookie, ni jeton de session de TheTVDB.

## État final de cette préparation

**192 conservées · 25 refus préservés · 1 cas Raska bloqué · 10 propositions conditionnelles · 25 captures à refaire · 0 upload · 0 suppression · 0 re-test agressif de la restriction.**
