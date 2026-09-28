"""Sinaloa Protocol v1 client using only the Python standard library."""

from dataclasses import dataclass
import json
import socket
from typing import Any, Dict, Optional
from urllib import error, parse, request

PROTOCOL_VERSION = "1.0"
DEFAULT_TIMEOUT_SECONDS = 30.0


class SinaloaError(RuntimeError):
    """A sanitized transport or protocol error returned by Sinaloa."""

    def __init__(self, message: str, *, status: Optional[int] = None, code: Optional[str] = None):
        super().__init__(message)
        self.status = status
        self.code = code


@dataclass
class AgentTokens:
    agent_api_token: str
    agent_refresh_token: str
    agent_token_expires_at: str
    agent_refresh_token_expires_at: str


def _positive_timeout(value: float) -> float:
    timeout = float(value)
    if timeout <= 0 or timeout > 300:
        raise ValueError("timeout must be greater than zero and no more than 300 seconds")
    return timeout


def _safe_error(raw: bytes, status: int) -> SinaloaError:
    try:
        payload = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError):
        payload = None
    if isinstance(payload, dict):
        message = payload.get("error") or payload.get("message")
        code = payload.get("code")
        if isinstance(message, str) and 0 < len(message) <= 500:
            return SinaloaError(message, status=status, code=code if isinstance(code, str) else None)
    return SinaloaError(f"Sinaloa request failed with HTTP {status}", status=status)


def _request_json(call: request.Request, timeout: float) -> Any:
    try:
        with request.urlopen(call, timeout=_positive_timeout(timeout)) as response:
            raw = response.read()
            if not raw:
                raise SinaloaError("Sinaloa returned an empty response", status=response.status)
            try:
                return json.loads(raw.decode("utf-8"))
            except (UnicodeDecodeError, json.JSONDecodeError) as exc:
                raise SinaloaError("Sinaloa returned an invalid JSON response", status=response.status) from exc
    except error.HTTPError as exc:
        raise _safe_error(exc.read(16_384), exc.code) from None
    except (TimeoutError, socket.timeout) as exc:
        raise SinaloaError("Sinaloa request timed out") from exc
    except error.URLError as exc:
        if isinstance(exc.reason, (TimeoutError, socket.timeout)):
            raise SinaloaError("Sinaloa request timed out") from exc
        raise SinaloaError("Sinaloa could not be reached") from exc


class SinaloaClient:
    def __init__(self, base_url: str, access_token: str, *, timeout: float = DEFAULT_TIMEOUT_SECONDS):
        self.base_url = base_url.rstrip("/")
        self.access_token = access_token
        self.timeout = _positive_timeout(timeout)

    def _request(self, path: str, method: str = "GET", body: Optional[Dict[str, Any]] = None, headers: Optional[Dict[str, str]] = None) -> Any:
        payload = json.dumps(body).encode("utf-8") if body is not None else None
        all_headers = {"Accept": "application/json", "Authorization": f"Bearer {self.access_token}", **(headers or {})}
        if payload is not None:
            all_headers["Content-Type"] = "application/json"
        call = request.Request(f"{self.base_url}{path}", data=payload, headers=all_headers, method=method)
        return _request_json(call, self.timeout)

    def send_message(self, inbox_id: str, idempotency_key: str, message: Dict[str, Any]) -> Dict[str, Any]:
        """Send by platform email address. message must include senderAgentId, recipientEmail, and text."""
        if not message.get("recipientEmail"):
            raise ValueError("recipientEmail is required; raw recipient agent IDs are not accepted")
        return self._request(
            f"/api/inboxes/{parse.quote(inbox_id, safe='')}/messages",
            method="POST",
            body=message,
            headers={"Idempotency-Key": idempotency_key},
        )

    def acknowledge(self, inbox_id: str, message_id: str, state: str, idempotency_key: str) -> Dict[str, Any]:
        return self._request(
            f"/api/inboxes/{parse.quote(inbox_id, safe='')}/messages/{parse.quote(message_id, safe='')}/acknowledgements",
            method="POST",
            body={"state": state},
            headers={"Idempotency-Key": idempotency_key},
        )

    def delta(self, inbox_id: str, cursor: Optional[str] = None, limit: int = 100) -> Dict[str, Any]:
        query = parse.urlencode({"limit": limit, **({"cursor": cursor} if cursor else {})})
        return self._request(f"/api/inboxes/{parse.quote(inbox_id, safe='')}/events/delta?{query}")


def rotate_agent_token(base_url: str, agent_refresh_token: str, *, timeout: float = DEFAULT_TIMEOUT_SECONDS) -> AgentTokens:
    payload = json.dumps({"grantType": "refresh_token", "agentRefreshToken": agent_refresh_token}).encode("utf-8")
    call = request.Request(
        f"{base_url.rstrip('/')}/api/agent-token",
        data=payload,
        headers={"Content-Type": "application/json", "Accept": "application/json"},
        method="POST",
    )
    value = _request_json(call, timeout)
    return AgentTokens(
        agent_api_token=value["agentApiToken"],
        agent_refresh_token=value["agentRefreshToken"],
        agent_token_expires_at=value["agentTokenExpiresAt"],
        agent_refresh_token_expires_at=value["agentRefreshTokenExpiresAt"],
    )
