# Private waitlist Sheet

The landing form remains email-only. Neon is the authoritative waitlist store; the beta Container mirrors accepted entries to the private Google Sheet with ID `1CDA4yMhNErfyx8NFETd2mZg9IjrWBHT2H3_XLqDurac`. The sync runs at Container startup and every minute, so it backfills earlier signups. A Google outage does not reject a signup; the next successful run retries from Neon. No public read endpoint is added.

The isolated Google Cloud project `envoi-waitlist-20261003-ca13a4` has the Sheets API enabled and service account `envoi-waitlist-sync@envoi-waitlist-20261003-ca13a4.iam.gserviceaccount.com`. Its JSON key was streamed directly to the beta Worker's encrypted `ENVOI_WAITLIST_GOOGLE_SERVICE_ACCOUNT_JSON` secret on 2026-10-03; no key material belongs in this repository. The service account still needs Editor access to the Sheet, and the sync code has not yet been deployed.

## One-time Google setup

1. The isolated Google Cloud project, Sheets API, service account, and encrypted Cloudflare key are complete. Do not create another key or send the existing one in chat.
2. Open the [private waitlist Sheet](https://docs.google.com/spreadsheets/d/1CDA4yMhNErfyx8NFETd2mZg9IjrWBHT2H3_XLqDurac/edit?gid=0#gid=0). Share it with `envoi-waitlist-sync@envoi-waitlist-20261003-ca13a4.iam.gserviceaccount.com` as **Editor**. Restrict human access to the intended operators; do not enable public link access.
3. The tab with `gid=0` must be empty, or its first row must be exactly `email`, `joined_at`, `source` in columns A–C. The sync will create these headers if the tab is empty; it refuses to overwrite other headers.
4. The non-secret `ENVOI_WAITLIST_SHEET_ID` is set in `wrangler.jsonc` for beta and forwarded to the Container. Deploy the reviewed build and restart the Container so it receives the new secret.

## Verification

Check the Container logs for `Waitlist Sheet sync completed` with an aggregate `appended` count, or `Waitlist Sheet sync failed` (neither logs email addresses). Existing waitlist rows should backfill at startup. Submit one authorized test email through the live landing form and confirm it appears once in the Sheet within about a minute, with its UTC timestamp and `landing` source. Re-submit the same email and confirm no second row appears. If the Sheet is unavailable, the signup remains in Neon and sync retries automatically.

The Google Drive connector in Codex is a **separate** connection for reading the Sheet in chat. Connecting it does not give the Envoi server permission to write; the service account above provides that permission.
