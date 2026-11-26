"""Opt-in real-native maintenance regressions, using only temporary synthetic DBs.

Run with the selected pinned native Python and ENVOI_HERMES_NATIVE_ROOT.
No native gateway, provider, credential, real profile or hosted SQL is used.
"""
import asyncio
from dataclasses import asdict
from datetime import datetime
from contextlib import closing
import importlib.util
import json
import os
from pathlib import Path
import sys
import tempfile
import time
from types import SimpleNamespace
import unittest
from unittest.mock import patch
import uuid

ROOT = Path(os.environ['ENVOI_HERMES_NATIVE_ROOT']).resolve(strict=True)
sys.path.insert(0, str(ROOT))
spec = importlib.util.spec_from_file_location('cleanup_native', Path(__file__).with_name('cleanup-native.py'))
cleanup = importlib.util.module_from_spec(spec)
spec.loader.exec_module(cleanup)


class NativeCleanupTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='envoi-cleanup-native-')
        self.home = Path(self.temp.name).resolve()
        self.env = patch.dict(os.environ, {'HERMES_HOME': str(self.home), 'PYTHONDONTWRITEBYTECODE': '1'})
        self.env.start()
        (self.home / 'config.yaml').write_text('model:\n  default: fake-test-model\n', encoding='utf8')
        from gateway.config import GatewayConfig, Platform
        from gateway.session import SessionStore, SessionEntry
        from gateway.session_local_recovery import local_source
        from gateway.session_policy import LocalSessionPolicy
        from hermes_state import SessionDB
        from hermes_state_runtime import begin_runtime_epoch, admit_session_input, claim_session_input
        from hermes_state_keys import local_identity
        from hermes_state_local import commit_local_session
        db = SessionDB(self.home / 'state.db')
        epoch = begin_runtime_epoch(db, instance_id='synthetic-prior-owner')
        config = GatewayConfig(sessions_dir=self.home / 'sessions')
        store = SessionStore(config.sessions_dir, config)
        store._db = db
        runner = SimpleNamespace(_draining=False, config=config, session_store=store, adapters={}, _profile_adapters={})
        authority = cleanup.maintenance_authority(runner, db, str(self.home), 'synthetic-prior-owner', epoch)
        request_id, input_id = str(uuid.uuid4()), str(uuid.uuid4())
        sid = local_identity(str(self.home), 'synthetic-operator', request_id)
        source = local_source(authority, sid, 'synthetic-operator')
        route = store._generate_session_key(source)
        policy = LocalSessionPolicy('acp', 'acp', str(self.home), 'fake-test-model', ('no_mcp',), '{}', '{}', json.dumps({'TERMINAL_CWD':str(self.home)}))
        now = datetime.now()
        entry = SessionEntry(route, sid, now, now, origin=source, platform=Platform.LOCAL)
        commit_local_session(db, epoch=epoch, receipt={'profile_id': str(self.home), 'principal_id': 'synthetic-operator',
            'request_id': request_id, 'session_id': sid, 'route': route, 'entry': entry.to_dict(), 'policy': asdict(policy)})
        row = admit_session_input(db, epoch=epoch, principal_id='synthetic-operator', session_id=sid,
                                  request_id=input_id, payload={'text': 'SYNTHETIC RETAINED TURN'})
        row = claim_session_input(db, epoch=epoch, session_id=sid)
        db.append_message(sid, 'user', 'SYNTHETIC RETAINED TURN')
        db.append_message(sid, 'assistant', 'SYNTHETIC UNFINISHED TOOL', tool_calls=[{'id':'synthetic-call', 'type':'function',
            'function':{'name':'envoi_case_reply', 'arguments':'{}'}}])
        successor = admit_session_input(db, epoch=epoch, principal_id='synthetic-operator', session_id=sid,
                                        request_id='synthetic-successor', payload={'text': 'MUST NOT EXECUTE'})
        self.admission, self.successor, self.sid = row['admission_id'], successor['admission_id'], sid
        self.generation, self.old_epoch = row['generation'], epoch
        state = {'kind': 'hermes-scoped-v1', 'requestId': request_id, 'inputId': input_id, 'sessionId': sid,
                 'admissionId': self.admission, 'text': 'SYNTHETIC RETAINED TURN'}
        journal = json.dumps({'version': 1, 'workId': 'msg_synthetic_retained', 'model': 'hermes-profile:' + json.dumps([str(self.home), str(self.home)]),
                              'completed': False, 'providerCalls': 1, 'pending': [], 'input': [state]})
        self.request = {'purpose': 'retained-hermes-native-cleanup-v1', 'cleanupApproved': True,
            'discardUnknownApproved': True, 'operatorDecisionSha256': 'a' * 64, 'deadlineMs': int(time.time() * 1000) + 60000,
            'home': str(self.home), 'cwd': str(self.home), 'journalRawBytes': journal, 'journalSha256': cleanup.digest(journal.encode()),
            'workId': 'msg_synthetic_retained', 'executionGeneration': self.generation}
        db.close()

    def tearDown(self):
        # Native registry descriptors are released before this owned temporary tree.
        from hermes_state_registry import close_all
        close_all()
        self.env.stop()
        self.temp.cleanup()

    def read_rows(self):
        from hermes_state import SessionDB
        from hermes_state_runtime import get_session_admission
        with SessionDB(self.home / 'state.db') as db:
            return get_session_admission(db, admission_id=self.admission), get_session_admission(db, admission_id=self.successor)

    async def test_started_becomes_unknown_then_explicitly_interrupted_without_draining_successor(self):
        before = self.request['journalRawBytes']
        with cleanup.deny_external_execution():
            proof = await cleanup.clean_one(self.request)
        self.assertEqual((proof['originalStatus'], proof['beforeReceipt']['status'], proof['outcome']), ('started', 'unknown', 'interrupted'))
        self.assertEqual(proof['operation'], 'prompt.resolve_unknown')
        self.assertFalse(proof['normalGatewayStarted'])
        self.assertEqual(proof['modelPromptsSubmitted'], 0)
        self.assertEqual(json.loads(proof['receiptRawBytes'])['result'], proof['receipt'])
        self.assertGreater(proof['suppressedSchedules'], 0)
        target, successor = self.read_rows()
        self.assertEqual((target['status'], target['outcome']), ('terminal', 'interrupted'))
        self.assertEqual((successor['status'], successor['generation']), ('queued', None))
        self.assertEqual(before, self.request['journalRawBytes'])
        from hermes_state import SessionDB
        with SessionDB(self.home / 'state.db', read_only=True) as db:
            rows = db.get_messages(self.sid)
        self.assertEqual(len(rows), 3)
        self.assertEqual(rows[0]['content'], 'SYNTHETIC RETAINED TURN')
        self.assertEqual(rows[-1]['display_kind'], 'failed_turn')
        self.assertFalse(any(row['role']=='tool' for row in rows))

    async def test_refuses_unknown_discard_without_separate_permission_before_epoch_recovery(self):
        self.request['discardUnknownApproved'] = False
        with self.assertRaisesRegex(cleanup.CleanupRefused, 'EXPLICIT_UNKNOWN_DISCARD_REQUIRED'):
            await cleanup.clean_one(self.request)
        target, successor = self.read_rows()
        self.assertEqual((target['status'], target['owner_epoch'], successor['status']), ('started', self.old_epoch, 'queued'))

    async def test_refuses_wrong_generation_without_touching_original(self):
        self.request['executionGeneration'] += 1
        with self.assertRaisesRegex(cleanup.CleanupRefused, 'EXACT_GENERATION_REQUIRED'):
            await cleanup.clean_one(self.request)
        self.assertEqual(self.read_rows()[0]['status'], 'started')

    async def test_preserves_actual_completed_terminal_outcome(self):
        from hermes_state import SessionDB
        from hermes_state_runtime import settle_session_input
        with SessionDB(self.home / 'state.db') as db:
            settle_session_input(db, epoch=self.old_epoch, admission_id=self.admission, generation=self.generation, outcome='completed')
        proof = await cleanup.clean_one(self.request)
        self.assertEqual((proof['operation'], proof['outcome']), ('none', 'completed'))
        self.assertEqual(self.read_rows()[1]['status'], 'queued')

    async def test_refuses_tampered_journal_before_native_ownership(self):
        self.request['journalRawBytes'] += ' '
        with self.assertRaisesRegex(cleanup.CleanupRefused, 'EXACT_RETAINED_JOURNAL_REQUIRED'):
            await cleanup.clean_one(self.request)
        self.assertEqual(self.read_rows()[0]['status'], 'started')

    async def test_no_network_or_subprocess_facility(self):
        import socket, subprocess
        with cleanup.deny_external_execution():
            with self.assertRaisesRegex(cleanup.CleanupRefused, 'EXTERNAL_EXECUTION_DISABLED'):
                socket.create_connection(('127.0.0.1', 1))
            with self.assertRaisesRegex(cleanup.CleanupRefused, 'EXTERNAL_EXECUTION_DISABLED'):
                subprocess.Popen(['never-executed'])

    async def test_ownership_conflict_does_not_open_or_change_native_turn(self):
        from gateway.runtime_ownership import ProfileOwnership, OwnershipConflict
        owner = ProfileOwnership()
        owner.reserve([self.home], purpose='synthetic-test-owner')
        try:
            with self.assertRaises(OwnershipConflict):
                await cleanup.clean_one(self.request)
        finally:
            owner.close()
        self.assertEqual(self.read_rows()[0]['status'], 'started')

    async def test_another_started_admission_prevents_global_epoch_recovery(self):
        from hermes_state import SessionDB
        from hermes_state_runtime import admit_session_input, claim_session_input
        with SessionDB(self.home / 'state.db') as db:
            db.create_session('synthetic-other-session', source='test')
            admit_session_input(db, epoch=self.old_epoch, principal_id='synthetic-other', session_id='synthetic-other-session',
                                request_id='other-started', payload={'text':'DO NOT TOUCH'})
            claim_session_input(db, epoch=self.old_epoch, session_id='synthetic-other-session')
        with self.assertRaisesRegex(cleanup.CleanupRefused, 'OTHER_NATIVE_RECOVERY_REQUIRED'):
            await cleanup.clean_one(self.request)
        self.assertEqual(self.read_rows()[0]['status'], 'started')

    async def test_expired_request_preserves_original(self):
        self.request['deadlineMs'] = int(time.time()*1000)-1
        with self.assertRaisesRegex(cleanup.CleanupRefused, 'CLEANUP_DEADLINE_REQUIRED'):
            await cleanup.clean_one(self.request)
        self.assertEqual(self.read_rows()[0]['status'], 'started')

    async def test_missing_original_text_is_not_equal_to_a_missing_payload(self):
        journal = json.loads(self.request['journalRawBytes'])
        del journal['input'][0]['text']
        self.request['journalRawBytes'] = json.dumps(journal)
        self.request['journalSha256'] = cleanup.digest(self.request['journalRawBytes'].encode())
        with self.assertRaisesRegex(cleanup.CleanupRefused, 'BOUNDED_ORIGINAL_TEXT_REQUIRED'):
            await cleanup.clean_one(self.request)
        self.assertEqual(self.read_rows()[0]['status'], 'started')

    async def test_old_schema_is_refused_without_migration(self):
        import sqlite3
        with closing(sqlite3.connect(self.home / 'state.db')) as conn:
            conn.execute('UPDATE schema_version SET version=31')
            conn.commit()
        with self.assertRaisesRegex(cleanup.CleanupRefused, 'CURRENT_NATIVE_SCHEMA_REQUIRED'):
            await cleanup.clean_one(self.request)
        with closing(sqlite3.connect((self.home / 'state.db').as_uri()+'?mode=ro', uri=True)) as conn:
            self.assertEqual(conn.execute('SELECT version FROM schema_version').fetchone()[0], 31)

    async def test_invalid_header_is_refused_without_quarantine_or_replacement(self):
        from hermes_state_registry import close_all
        close_all()
        raw = b'SYNTHETIC INVALID SQLITE HEADER'
        (self.home / 'state.db').write_bytes(raw)
        prior = set(self.home.glob('*.quarantine*'))
        with self.assertRaises(Exception):
            await cleanup.clean_one(self.request)
        self.assertEqual((self.home / 'state.db').read_bytes(), raw)
        self.assertFalse(list(self.home.glob('*.corrupt*')))
        self.assertEqual(set(self.home.glob('*.quarantine*')), prior)

    async def test_preflight_expiry_prevents_first_native_write(self):
        actual = cleanup.existing_database
        def expired(*args):
            db = actual(*args)
            self.request['deadlineMs'] = 0
            return db
        with patch.object(cleanup, 'existing_database', expired):
            with self.assertRaisesRegex(cleanup.CleanupRefused, 'CLEANUP_DEADLINE_EXPIRED'):
                await cleanup.clean_one(self.request)
        target, _ = self.read_rows()
        self.assertEqual((target['status'], target['owner_epoch']), ('started', self.old_epoch))

    async def test_real_maintenance_child_uses_pinned_native_source_then_exits(self):
        import subprocess
        files = ['gateway/session_authority.py', 'gateway/session_local_recovery.py', 'gateway/session_runtime_workers.py',
                 'gateway/session_results.py', 'gateway/session_ingress.py', 'gateway/runtime_ownership.py',
                 'hermes_state_runtime.py', 'hermes_state.py', 'hermes_state_local.py', 'hermes_state_local_lineage.py']
        self.request['nativeFileSha256'] = {name:cleanup.digest((ROOT/name).read_bytes()) for name in files}
        raw = json.dumps(self.request).encode()
        result = subprocess.run([sys.executable, str(Path(__file__).with_name('cleanup-native.py')), '--native-root', str(ROOT), cleanup.digest(raw)],
                                input=raw, capture_output=True, timeout=30, env=dict(os.environ))
        self.assertEqual(result.returncode, 0, result.stdout.decode(errors='replace')+result.stderr.decode(errors='replace'))
        proof = json.loads(result.stdout)
        self.assertEqual((proof['beforeReceipt']['status'], proof['outcome']), ('unknown', 'interrupted'))
        self.assertFalse(proof['normalGatewayStarted'])
        self.assertEqual(self.read_rows()[1]['status'], 'queued')


if __name__ == '__main__':
    unittest.main()
