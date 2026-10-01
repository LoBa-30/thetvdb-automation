# TheTVDB Automation

Cloud-based Playwright audit project for comparing YouTube channels with TheTVDB.

## Current safety mode

The repository currently runs in **READ_ONLY_AUDIT** mode.

It does **not**:
- log in to TheTVDB;
- edit episodes;
- create episodes;
- delete episodes;
- submit forms.

It only checks configured targets and produces `reports/audit.json`.

## Run in GitHub

Open **Actions** → **TheTVDB read-only audit** → **Run workflow**.

A downloadable artifact named `thetvdb-audit-report` is produced at the end of the run.

## Next implementation steps

1. Configure the YouTube/TheTVDB target list.
2. Implement exhaustive YouTube long-form video collection.
3. Collect all seasons/episodes from TheTVDB.
4. Match each YouTube video to an episode.
5. Generate a detailed discrepancy report.
6. Only after validation, add an explicit write mode with safeguards and manual approval controls.

## Credentials

Never commit credentials, cookies, tokens or passwords into this public repository. Future authentication data must be stored in GitHub Actions Secrets.
