"""Run one real-SDK operation through a strict, offline synthetic transport."""

import argparse
import json
from io import BytesIO
from urllib.error import HTTPError
import socket
import sys
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from envoi_protocol import EnvoiClient, EnvoiError, rotate_agent_token

BASE = "https://offline.invalid"
ACCESS = "synthetic-access-private"
REFRESH = "synthetic-refresh-private"
INBOX = "inbox_demo"
MESSAGE = "msg_demo"
SEND_KEY = "send-demo-0001"
ACK_KEY = "ack-demo-0001"
ROTATION_ID = "rotation-demo-0001"


class Response:
    status = 200

    def __init__(self, data):
        self.data = data

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return False

    def read(self):
        return json.dumps(self.data).encode()


class OfflineTransport:
    def __init__(self, operation):
        self.operation = operation
        self.calls = []

    def __call__(self, request, *, timeout):
        assert timeout == 5
        body = json.loads(request.data) if request.data else None
        method = request.get_method()
        url = request.full_url
        headers = dict(request.header_items())
        self.calls.append((method, url, headers, body))
        assert url.startswith(BASE + "/")
        assert len(self.calls) <= (2 if self.operation in ("send_message", "rotate_agent_token") else 1)
        if self.operation == "send_message":
            assert (method, url, headers["Idempotency-key"]) == ("POST", BASE + f"/api/inboxes/{INBOX}/messages", SEND_KEY)
            assert headers["Authorization"] == f"Bearer {ACCESS}"
            assert body == {"senderAgentId": "agent_demo", "recipientEmail": "peer@agents.envoi-agents.com", "text": "Offline hello"}
            result = {"id": MESSAGE, "state": "queued"}
        elif self.operation == "native_acknowledgement_refused":
            assert (method, url, headers["Idempotency-key"]) == ("POST", BASE + f"/api/inboxes/{INBOX}/messages/{MESSAGE}/acknowledgements", ACK_KEY)
            assert headers["Authorization"] == f"Bearer {ACCESS}" and body == {"state": "processed"}
            payload = {"error": "REQUEST_FAILED", "message": "Agent work messages require a fenced work claim and /api/agent/work/:workId settlement"}
            raise HTTPError(url, 410, "Gone", {}, BytesIO(json.dumps(payload).encode()))
        elif self.operation == "delta":
            assert (method, url, body) == ("GET", BASE + f"/api/inboxes/{INBOX}/events/delta?limit=2&cursor=cursor_demo", None)
            assert headers["Authorization"] == f"Bearer {ACCESS}"
            result = {"events": [], "nextCursor": "cursor_next"}
        elif self.operation == "rotate_agent_token":
            assert (method, url) == ("POST", BASE + "/api/agent-token")
            assert "Authorization" not in headers
            assert body == {"grantType": "refresh_token", "agentRefreshToken": REFRESH, "rotationId": ROTATION_ID}
            result = {"agentApiToken": "next-access-private", "agentRefreshToken": "next-refresh-private", "agentTokenExpiresAt": "2030-01-01T00:00:00Z", "agentRefreshTokenExpiresAt": "2030-02-01T00:00:00Z"}
        else:
            raise AssertionError("unexpected operation")
        if self.operation in ("send_message", "rotate_agent_token") and len(self.calls) == 1:
            raise socket.timeout("synthetic timeout")
        return Response(result)


def run_example(operation):
    transport = OfflineTransport(operation)
    with patch("envoi_protocol.request.urlopen", side_effect=transport):
        client = EnvoiClient(BASE, ACCESS, timeout=5)
        if operation == "send_message":
            message = {"senderAgentId": "agent_demo", "recipientEmail": "peer@agents.envoi-agents.com", "text": "Offline hello"}
            try:
                client.send_message(INBOX, SEND_KEY, message)
            except EnvoiError as exc:
                assert "timed out" in str(exc)
            else:
                raise AssertionError("expected timeout")
            result = client.send_message(INBOX, SEND_KEY, message)
            summary = f"send_message: {result['state']} after same-key retry"
        elif operation == "native_acknowledgement_refused":
            try:
                client.acknowledge(INBOX, MESSAGE, "processed", ACK_KEY)
            except EnvoiError as exc:
                assert exc.status == 410
                summary = "native_acknowledgement_refused: HTTP 410; native work requires the trusted connector's fenced settlement"
            else:
                raise AssertionError("native work must not get a legacy processed receipt")
        elif operation == "delta":
            result = client.delta(INBOX, cursor="cursor_demo", limit=2)
            summary = f"delta: {len(result['events'])} events, next cursor received"
        elif operation == "rotate_agent_token":
            try:
                rotate_agent_token(BASE, REFRESH, ROTATION_ID, timeout=5)
            except EnvoiError as exc:
                assert "timed out" in str(exc)
            else:
                raise AssertionError("expected timeout")
            result = rotate_agent_token(BASE, REFRESH, ROTATION_ID, timeout=5)
            summary = f"rotate_agent_token: same-ID retry succeeded; expiry {result.agent_token_expires_at}"
        else:
            raise ValueError("unknown operation")
    return summary, transport.calls


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("operation", choices=("send_message", "native_acknowledgement_refused", "delta", "rotate_agent_token"))
    print(run_example(parser.parse_args().operation)[0])
