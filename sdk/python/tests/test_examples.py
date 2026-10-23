"""Verify the documented commands and strict offline request/retry behavior."""

import socket
import subprocess
import sys
import unittest
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "examples"))
from offline_quickstart import run_example  # noqa: E402


class ExampleTests(unittest.TestCase):
    def test_requests_and_retry_identifiers_without_network(self):
        for operation, count in (("send_message", 2), ("acknowledge", 1), ("delta", 1), ("rotate_agent_token", 2)):
            with self.subTest(operation=operation), patch.object(socket.socket, "connect", side_effect=AssertionError("network attempted")):
                summary, calls = run_example(operation)
                self.assertEqual(len(calls), count)
                self.assertIn(operation, summary)
                if count == 2:
                    self.assertEqual(calls[0], calls[1], "retry must reuse identical request and identifier")
                self.assertNotIn("private", summary)

    def test_every_documented_example_command(self):
        for operation in ("send_message", "acknowledge", "delta", "rotate_agent_token"):
            with self.subTest(operation=operation):
                result = subprocess.run([sys.executable, str(ROOT / "examples" / "offline_quickstart.py"), operation], cwd=ROOT, capture_output=True, text=True, check=True)
                self.assertIn(operation, result.stdout)
                self.assertEqual(result.stderr, "")
                self.assertNotIn("private", result.stdout)


if __name__ == "__main__":
    unittest.main()
