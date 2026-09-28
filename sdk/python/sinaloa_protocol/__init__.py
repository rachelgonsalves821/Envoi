"""Sinaloa Protocol v1 client using only the Python standard library."""

from dataclasses import dataclass
import json
from typing import Any, Dict, Optional
from urllib import parse, request

PROTOCOL_VERSION = "1.0"


@dataclass
class AgentTokens:
    agent_api_token: str
    agent_refresh_token: str
    agent_token_expires_at: str
    agent_refresh_token_expires_at: str


class SinaloaClient:
    def __init__(self, base_url: str, access_token: str):
        self.base_url = base_url.rstrip("/")
        self.access_token = access_token

    def _request(self, path: str, method: str = "GET", body: Optional[Dict[str, Any]] = None, headers: Optional[Dict[str, str]] = None) -> Any:
        payload = json.dumps(body).encode("utf-8") if body is not None else None
        all_headers = {"Accept": "application/json", "Authorization": f"Bearer {self.access_token}", **(headers or {})}
        if payload is not None:
            all_headers["Content-Type"] = "application/json"
        call = request.Request(f"{self.base_url}{path}", data=payload, headers=all_headers, method=method)
        with request.urlopen(call) as response:
            return json.loads(response.read().decode("utf-8"))

    def send_message(self, inbox_id: str, idempotency_key: str, message: Dict[str, Any]) -> Dict[str, Any]:
        """Send by platform email address. message must include senderAgentId, recipientEmail, and text."""
        if not message.get("recipientEmail"):
            raise ValueError("recipientEmail is required; raw recipient agent IDs are not accepted")
        return self._request(
            f"/api/inboxes/{parse.quote(inbox_id)}/messages",
            method="POST",
            body=message,
            headers={"Idempotency-Key": idempotency_key},
        )

    def acknowledge(self, inbox_id: str, message_id: str, state: str, idempotency_key: str) -> Dict[str, Any]:
        return self._request(
            f"/api/inboxes/{parse.quote(inbox_id)}/messages/{parse.quote(message_id)}/acknowledgements",
            method="POST",
            body={"state": state},
            headers={"Idempotency-Key": idempotency_key},
        )

    def delta(self, inbox_id: str, cursor: Optional[str] = None, limit: int = 100) -> Dict[str, Any]:
        query = parse.urlencode({"limit": limit, **({"cursor": cursor} if cursor else {})})
        return self._request(f"/api/inboxes/{parse.quote(inbox_id)}/events/delta?{query}")


def rotate_agent_token(base_url: str, agent_refresh_token: str) -> AgentTokens:
    payload = json.dumps({"grantType": "refresh_token", "agentRefreshToken": agent_refresh_token}).encode("utf-8")
    call = request.Request(
        f"{base_url.rstrip('/')}/api/agent-token",
        data=payload,
        headers={"Content-Type": "application/json", "Accept": "application/json"},
        method="POST",
    )
    with request.urlopen(call) as response:
        value = json.loads(response.read().decode("utf-8"))
    return AgentTokens(
        agent_api_token=value["agentApiToken"],
        agent_refresh_token=value["agentRefreshToken"],
        agent_token_expires_at=value["agentTokenExpiresAt"],
        agent_refresh_token_expires_at=value["agentRefreshTokenExpiresAt"],
    )
