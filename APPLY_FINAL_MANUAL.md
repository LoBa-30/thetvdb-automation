# Armement manuel du correcteur TheTVDB final

Le moteur final est `src/final-apply.js` et le script npm est `npm run final:apply`.

## Pourquoi cette étape est manuelle
Le connecteur GitHub de ChatGPT ne permet pas d'armer lui-même un workflow qui déclenche des écritures sur un service externe. Le code de correction est donc préparé, mais l'armement final doit être fait par le propriétaire du dépôt.

## Modification minimale
Dans `.github/workflows/edit.yml`, conserver l'option manuelle `apply` et remplacer uniquement la commande de l'étape `Controlled dry-run or apply preflight` par une séparation des deux modes :

```yaml
      - name: Controlled dry-run preflight
        if: ${{ inputs.mode == 'dry-run' }}
        env:
          TVDB_EDIT_MODE: dry-run
          TVDB_USERNAME: ${{ secrets.TVDB_USERNAME }}
          TVDB_PASSWORD: ${{ secrets.TVDB_PASSWORD }}
        run: npm run edit

      - name: Guarded final apply
        if: ${{ inputs.mode == 'apply' }}
        env:
          TVDB_USERNAME: ${{ secrets.TVDB_USERNAME }}
          TVDB_PASSWORD: ${{ secrets.TVDB_PASSWORD }}
          TVDB_FINAL_APPLY: 'yes'
        run: npm run final:apply
```

Ne modifier aucune autre étape.

## Garde-fous du moteur final
- uniquement Djilsi 2026, Raska 2018 et Raska 2023 ;
- IDs et numéros attendus codés en allowlist ;
- arrêt avant toute écriture si l'état TheTVDB a changé depuis le dry-run ;
- aucune suppression ;
- vérification après chaque renumérotation ;
- ajout groupé des deux épisodes Djilsi ;
- tentative de restauration de la numérotation Djilsi si l'ajout échoue avant création des épisodes ;
- rapport `reports/final-apply.json` et `reports/final-apply.txt`.

Après cette modification, lancer manuellement : Actions → TheTVDB controlled edit → Run workflow → `apply`.
