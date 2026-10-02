# Beta landing waitlist

The signed-out hosted app now opens on the landing page. The **Sign in** link uses the WorkOS sign-in route; invited users continue through the existing authentication flow. Local development's phone sign-in remains unchanged.

The waitlist form posts to `POST /api/waitlist` on the same origin. A 200 response means the address was stored (or was already present); the UI never reports success on a failed request. The endpoint validates and lowercases emails, de-duplicates by SHA-256 key, applies a per-IP limit of 10 requests per hour, drops honeypot submissions, limits JSON bodies to 2 KiB, and never exposes a public list. Entries are private `waitlist/` documents in the existing Sinaloa data store: Neon PostgreSQL for hosted beta, local files for development. No Google Sheet, third-party form, browser-held write secret, or new API key is required.

For a spreadsheet-compatible copy, use a **private** machine with read access to the beta database and run `npm run waitlist:export -- C:\private\sinaloa-waitlist.csv` with `DATABASE_URL` set in that process environment. The export refuses to overwrite an existing file and escapes CSV formulas. Restrict access to the exported file, do not commit it, and remove it after use. The live database remains the source of truth. Use the beta database URL only; never export from production by mistake.

Before publicly distributing the landing page, publish a privacy policy covering waitlist purpose, retention, and deletion requests, then link it beside the form. No policy URL has been supplied yet.
