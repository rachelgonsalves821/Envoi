import io
import json
import socket
import unittest
from unittest.mock import patch
from urllib import error

from sinaloa_protocol import SinaloaClient, SinaloaError


class Response:
    def __init__(self, body=b"{}", status=200):
        self.body = body
        self.status = status

    def __enter__(self): return self
    def __exit__(self, *_args): return False
    def read(self): return self.body


class ClientTests(unittest.TestCase):
    @patch("sinaloa_protocol.request.urlopen")
    def test_path_segments_encode_slashes_and_timeout_is_forwarded(self, urlopen):
        urlopen.return_value = Response(json.dumps({"events": []}).encode())
        client = SinaloaClient("https://api.example", "secret-token", timeout=7)
        client.delta("inbox/../../other")
        call = urlopen.call_args.args[0]
        self.assertIn("/api/inboxes/inbox%2F..%2F..%2Fother/events/delta", call.full_url)
        self.assertEqual(urlopen.call_args.kwargs["timeout"], 7)

    @patch("sinaloa_protocol.request.urlopen")
    def test_json_http_error_is_sanitized(self, urlopen):
        urlopen.side_effect = error.HTTPError("https://api.example", 409, "Conflict", {}, io.BytesIO(b'{"error":"Conflict","code":"REUSED"}'))
        with self.assertRaises(SinaloaError) as raised:
            SinaloaClient("https://api.example", "do-not-leak").delta("inbox")
        self.assertEqual(str(raised.exception), "Conflict")
        self.assertEqual(raised.exception.status, 409)
        self.assertNotIn("do-not-leak", str(raised.exception))

    @patch("sinaloa_protocol.request.urlopen")
    def test_html_and_timeout_errors_do_not_expose_remote_bodies(self, urlopen):
        urlopen.side_effect = error.HTTPError("https://api.example", 502, "Bad Gateway", {}, io.BytesIO(b"<html>provider secret</html>"))
        with self.assertRaisesRegex(SinaloaError, "HTTP 502"):
            SinaloaClient("https://api.example", "token").delta("inbox")
        urlopen.side_effect = socket.timeout()
        with self.assertRaisesRegex(SinaloaError, "timed out"):
            SinaloaClient("https://api.example", "token").delta("inbox")

    def test_timeout_is_bounded(self):
        with self.assertRaises(ValueError): SinaloaClient("https://api.example", "token", timeout=0)
        with self.assertRaises(ValueError): SinaloaClient("https://api.example", "token", timeout=301)


if __name__ == "__main__": unittest.main()
