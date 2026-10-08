# Sinaloa Python SDK

`SinaloaClient` uses a finite 30-second timeout by default. Override it with `SinaloaClient(base_url, access_token, timeout=10)`; accepted values are greater than zero and no more than 300 seconds. Direct `rotate_agent_token(base_url, refresh_token, rotation_id, timeout=10)` callers must save a stable `rotation_id` before sending the request and reuse it after a timeout. Token rotation accepts the same keyword timeout.

Every identifier is encoded as one URL path segment. Transport failures raise `SinaloaError` with a sanitized status/message and never include access tokens or raw HTML/provider error bodies.

Run focused tests from `sdk/python` with `python -m unittest discover -s tests -v`.
