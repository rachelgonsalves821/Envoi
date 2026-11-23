# Malware scanner

Envoi scans uploads with a separate scanner Worker per environment. The Workers keep their original names:

| Environment | Config | Worker | Container | Scan URL |
| --- | --- | --- | --- | --- |
| Staging | `scanner/wrangler.jsonc` | `sinaloa-scanner-staging` | `sinaloa-clamav-staging` | `https://sinaloa-scanner-staging.rachelgonsalves821.workers.dev/scan` |
| Production | `scanner/wrangler.beta.jsonc` | `sinaloa-scanner-beta` | `sinaloa-clamav-beta` | `https://sinaloa-scanner-beta.rachelgonsalves821.workers.dev/scan` |

Each scanner Worker accepts authenticated `POST /scan` binary bodies and `GET /health` probes. It connects over a private Container TCP port to the official ClamAV daemon using ClamD's `INSTREAM` protocol. The public Worker never exposes ClamD's TCP port. Cloudflare's `startAndWaitForPorts()` sends an HTTP probe, so this raw-TCP service instead uses `start()` and verifies the TCP connection directly. A five-minute cron and ten-minute inactivity timeout keep the 4 GiB scanner warm. Review its billed runtime.

Cloudflare pulls `docker.io/clamav/clamav:stable` directly, so local Docker is not required for this scanner. The image includes signature databases and updates them with FreshClam. Pin a tested digest for production and monitor signature freshness; a scanner health response proves ClamD answers but does not prove the database is current.

## Staging

Run `node --test scanner/clamd-protocol.test.js` and `wrangler deploy --dry-run --config scanner/wrangler.jsonc` before a real deployment. Deploy only this scanner with `npm run cf:deploy:scanner:staging`, which first checks that the Worker has `ENVOI_SCANNER_TOKEN` (the scanner reads no other name). Store a random, independent `ENVOI_SCANNER_TOKEN` as an encrypted secret on this Worker, then store the same token as `ENVOI_MALWARE_SCANNER_TOKEN` on the `sinaloa-staging` app Worker. Set its `ENVOI_MALWARE_SCANNER_URL` to the staging scan URL above. Never place the token in code, CLI arguments, documentation, or chat.

On 2026-09-29 the deployed staging scanner returned `200 {"ready":true}` for health, `clean` for a harmless sample, `infected` with `Eicar-Test-Signature` for the EICAR test string, `401` without a token, `422` for a bad checksum, and `413` for a body one byte over 25 MiB. A passing direct scanner probe does not prove the full application quarantine and signed-download flow; test that on the deployed staging release. Also verify a cold-start failure produces a negative health result.

## Production

Run `wrangler deploy --dry-run --containers-rollout=none --config scanner/wrangler.beta.jsonc` before `npm run cf:deploy:scanner:production` (an alias of `cf:deploy:scanner:beta`), which runs the same name check. The production scanner has its own `ENVOI_SCANNER_TOKEN` encrypted secret, matched by `ENVOI_MALWARE_SCANNER_TOKEN` on the production application Worker. Never reuse the staging scanner credential. The production app Wrangler environment points only to this scanner.
