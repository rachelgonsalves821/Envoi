"""One approved retained-admission maintenance operation; never a gateway run.

Uses the selected, pinned Hermes source and its real SessionAuthority/store.
No normal startup, listener, session creation, prompt, model, tool, cron, hooks,
viewer recovery or delivery adapter is started. The caller owns the child from
spawn through verified exit and must validate the actual human decision first.
"""
from __future__ import annotations

import asyncio
from contextlib import contextmanager
from dataclasses import asdict
import hashlib
import json
import os
from pathlib import Path
import re
import socket
import sqlite3
import subprocess
import sys
import threading
import time
from types import SimpleNamespace
import uuid


class CleanupRefused(Exception):
    pass


def require(value, code):
    if not value:
        raise CleanupRefused(code)


def digest(raw):
    return hashlib.sha256(raw).hexdigest()


def canonical(path):
    return os.path.normcase(str(Path(path).resolve(strict=True)))


def validate_request(request, now_ms=None):
    now_ms = time.time() * 1000 if now_ms is None else now_ms
    require(isinstance(request, dict) and request.get('purpose') == 'retained-hermes-native-cleanup-v1', 'CLEANUP_REQUEST_REQUIRED')
    require(request.get('cleanupApproved') is True and re.fullmatch(r'[a-f0-9]{64}', request.get('operatorDecisionSha256', '')),
            'EXPLICIT_CLEANUP_DECISION_REQUIRED')
    require(type(request.get('deadlineMs')) is int and 0 < request['deadlineMs'] - now_ms <= 75000, 'CLEANUP_DEADLINE_REQUIRED')
    raw = request.get('journalRawBytes')
    require(isinstance(raw, str) and len(raw.encode()) <= 1000000 and digest(raw.encode()) == request.get('journalSha256'),
            'EXACT_RETAINED_JOURNAL_REQUIRED')
    run = json.loads(raw)
    require(run.get('completed') is False and run.get('pending') == [] and not run.get('admission')
            and run.get('workId') == request.get('workId') and re.fullmatch(r'msg_[A-Za-z0-9_-]+', run.get('workId', ''))
            and isinstance(run.get('input'), list) and len(run['input']) == 1, 'EXACT_UNFINISHED_ADMISSION_REQUIRED')
    state = run['input'][0]
    require(state.get('kind') == 'hermes-scoped-v1' and all(isinstance(state.get(k), str) and 0 < len(state[k]) <= 256
            for k in ('sessionId', 'admissionId', 'inputId', 'requestId')), 'EXACT_NATIVE_IDENTITIES_REQUIRED')
    require(isinstance(state.get('text'), str) and 0 < len(state['text'].encode()) <= 262144, 'BOUNDED_ORIGINAL_TEXT_REQUIRED')
    require(type(request.get('executionGeneration')) is int and request['executionGeneration'] >= 1, 'EXACT_GENERATION_REQUIRED')
    home, cwd = canonical(request['home']), canonical(request['cwd'])
    require(run.get('model', '').startswith('hermes-profile:'), 'CURRENT_PROFILE_JOURNAL_REQUIRED')
    profile = json.loads(run['model'][len('hermes-profile:'):])
    require(isinstance(profile, list) and len(profile) == 2 and canonical(profile[0]) == home and canonical(profile[1]) == cwd,
            'EXACT_PROFILE_REQUIRED')
    require(bool(os.environ.get('HERMES_HOME')) and canonical(os.environ['HERMES_HOME']) == home, 'SELECTED_HOME_ENV_REQUIRED')
    require((Path(home) / 'state.db').is_file(), 'EXISTING_NATIVE_DATABASE_REQUIRED')
    return run, state, home


def active(request):
    require(time.time() * 1000 < request['deadlineMs'], 'CLEANUP_DEADLINE_EXPIRED')


def existing_database(path, request):
    """Native reads/writes, with general creation/repair/migration unavailable."""
    from hermes_state import SessionDB
    class MaintenanceDB(SessionDB):
        def _open_writer(self):
            raise CleanupRefused('NORMAL_NATIVE_WRITER_OPEN_DISABLED')

        def _init_schema(self):
            raise CleanupRefused('NATIVE_SCHEMA_MAINTENANCE_DISABLED')

        def _reopen_after_close_locked(self, **_kwargs):
            raise CleanupRefused('NATIVE_AUTOMATIC_REOPEN_DISABLED')

        def _enter_fts_fail_open(self, *_args, **_kwargs):
            return False

        def _execute_write(self, fn, patience_s=None):
            active(request)
            def guarded(conn):
                active(request)  # every native transaction retry, before its first mutation
                return fn(conn)
            return super()._execute_write(guarded, patience_s=patience_s)

        def enable_maintenance_writes(self):
            active(request)
            self._close_connection_quietly(self._conn)
            self._conn = None
            # Native connection setup, not normal _open_writer/_init_schema.
            # Preflight requires the existing WAL format, so it is not migrated.
            self._conn = self._open_writer_conn()
            self.read_only = False
            forbidden = {getattr(sqlite3, name) for name in (
                'SQLITE_CREATE_INDEX','SQLITE_CREATE_TABLE','SQLITE_CREATE_TRIGGER','SQLITE_CREATE_VIEW','SQLITE_CREATE_VTABLE',
                'SQLITE_DROP_INDEX','SQLITE_DROP_TABLE','SQLITE_DROP_TRIGGER','SQLITE_DROP_VIEW','SQLITE_DROP_VTABLE',
                'SQLITE_ALTER_TABLE','SQLITE_ATTACH','SQLITE_DETACH')}
            self._conn.set_authorizer(lambda code, arg1, arg2, *_rest: sqlite3.SQLITE_DENY
                if code in forbidden or code == sqlite3.SQLITE_PRAGMA and arg2 is not None else sqlite3.SQLITE_OK)
            self._record_db_file_identity()

    active(request)
    db = MaintenanceDB(path, read_only=True)  # no quarantine, creation, repair or schema initialization
    try:
        from hermes_state_common import SCHEMA_VERSION
        from hermes_state_schema import schema_read_probe_statements
        db._conn.set_progress_handler(lambda: int(time.time() * 1000 >= request['deadlineMs']), 1000)
        require(db._read_one('PRAGMA quick_check(1)')[0] == 'ok', 'HEALTHY_EXISTING_NATIVE_DATABASE_REQUIRED')
        versions = db._read_all('SELECT version FROM schema_version')
        require(len(versions) == 1 and versions[0][0] == SCHEMA_VERSION, 'CURRENT_NATIVE_SCHEMA_REQUIRED')
        for statement in schema_read_probe_statements():
            db._read_one(statement)
        require(db._read_one('PRAGMA journal_mode')[0] == 'wal', 'EXISTING_NATIVE_WAL_REQUIRED')
        active(request)
        return db
    except BaseException:
        db.close()
        raise


@contextmanager
def deny_external_execution():
    """Defense in depth: this process has no network or child-process facility."""
    from unittest.mock import patch
    def deny(*_args, **_kwargs):
        raise CleanupRefused('CLEANUP_EXTERNAL_EXECUTION_DISABLED')
    with patch.object(socket.socket, 'connect', deny), patch.object(socket.socket, 'connect_ex', deny), \
         patch.object(socket.socket, 'bind', deny), patch.object(socket.socket, 'sendto', deny), \
         patch.object(socket, 'create_connection', deny), patch.object(subprocess, 'Popen', deny), patch.object(os, 'system', deny):
        yield


def maintenance_authority(runner, db, home, instance, epoch):
    from gateway.session_authority import SessionAuthority
    class MaintenanceAuthority(SessionAuthority):
        # Existing native terminal writes are unchanged. Publication and successor
        # execution are unavailable, including those requested by resolve_unknown.
        def _schedule(self, _ref):
            self.suppressed_schedules += 1

        def _publish_pending(self, _ref):
            self.suppressed_publications += 1

        async def _drain(self, _ref):
            raise CleanupRefused('CLEANUP_DRAIN_DISABLED')

        async def _execute_claimed(self, *_args, **_kwargs):
            raise CleanupRefused('CLEANUP_EXECUTION_DISABLED')

    authority = MaintenanceAuthority(runner, profile_id=home, instance_id=instance, db=db, epoch=epoch)
    authority.suppressed_schedules = authority.suppressed_publications = 0
    return authority


async def clean_one(request):
    _run, state, home = validate_request(request)
    # Imports resolve only inside the independently pinned native source root.
    from gateway.config import GatewayConfig
    from gateway.runtime_ownership import ProfileOwnership
    from gateway.session import SessionStore
    from gateway.session_authorities import SessionAuthorities
    from gateway.session_contract import Principal, SessionRef
    from hermes_state_runtime import begin_runtime_epoch, recover_session_inputs, get_session_admission, STEERING
    from hermes_state_local import local_receipt
    from hermes_state_local_lineage import adoptable_compression

    ownership, db, authority = ProfileOwnership(), None, None
    try:
        ownership.reserve([Path(home)], purpose='envoi-retained-admission-cleanup')
        db = existing_database(Path(home) / 'state.db', request)
        original = get_session_admission(db, admission_id=state['admissionId'])
        require(original is not None and original['target_session_id'] == state['sessionId']
                and original['request_id'] == state['inputId'] and original['payload'].get('text') == state.get('text'), 'EXACT_STORED_ADMISSION_REQUIRED')
        require(original['generation'] == request['executionGeneration'], 'EXACT_GENERATION_REQUIRED')
        require(original['status'] in ('started', 'unknown', 'terminal'), 'QUEUED_NATIVE_INPUT_PRESERVED')
        require(original['outcome'] != STEERING, 'TRANSFERRED_NATIVE_INPUT_PRESERVED')
        # The standard native epoch recovery must have no other started input,
        # transferred steer or active worker to stamp. Queued successors are kept.
        with db._read_ctx() as conn:
            require(not conn.execute("SELECT 1 FROM session_admissions WHERE admission_id!=? AND (status='started' OR outcome=?) LIMIT 1",
                                     (state['admissionId'], STEERING)).fetchone(), 'OTHER_NATIVE_RECOVERY_REQUIRED')
            require(not conn.execute("SELECT 1 FROM worker_executions WHERE status IN ('registered','running') LIMIT 1").fetchone(),
                    'ACTIVE_NATIVE_WORKER_REFUSED')
        local = local_receipt(db, state['sessionId'])
        require(canonical(local['profile_id']) == home and local['principal_id'] == original['principal_id']
                and local['policy']['source'] == 'acp' and canonical(local['policy']['cwd']) == canonical(request['cwd']), 'EXACT_LOCAL_OWNER_REQUIRED')
        profile_id = local['profile_id']
        with db._read_ctx() as conn:
            require(adoptable_compression(conn, local) is None, 'NATIVE_LINEAGE_ADOPTION_REQUIRED')
        if original['status'] in ('started', 'unknown'):
            require(request.get('discardUnknownApproved') is True, 'EXPLICIT_UNKNOWN_DISCARD_REQUIRED')
        active(request)
        db.enable_maintenance_writes()
        instance = uuid.uuid4().hex
        active(request)
        epoch = begin_runtime_epoch(db, instance_id=instance)
        active(request)
        recover_session_inputs(db, epoch=epoch)  # native started -> unknown, never replay
        config = GatewayConfig(sessions_dir=Path(home) / 'sessions')
        class MaintenanceStore(SessionStore):
            def _open_session_db_for_active_scope(self, db_path=None):
                require(db_path is None or canonical(db_path) == canonical(db.db_path), 'EXACT_NATIVE_STORE_REQUIRED')
                return db  # no secondary normal SessionDB constructor/repair path
        store = MaintenanceStore(config.sessions_dir, config)
        store._db = db
        runner = SimpleNamespace(_draining=False, session_store=store, config=config, adapters={}, _profile_adapters={})
        authority = maintenance_authority(runner, db, profile_id, instance, epoch)
        registry = SessionAuthorities(Path(home))
        registry.add(Path(home), authority)
        runner.session_authorities, runner.session_authority = registry, authority
        ref = SessionRef(profile_id, state['sessionId'])
        actor = Principal(original['principal_id'], profile_id, frozenset({'session:read', 'session:submit', 'session:control', 'session:operator'}), instance)
        before = await authority.receipt(actor, ref, state['admissionId'])
        operation = 'none'
        require(not authority.pending_results and not authority.pending_deliveries and not getattr(authority, 'unsettled_deliveries', {}),
                'CAPTURED_NATIVE_DELIVERY_REFUSED')
        if before.status == 'unknown':
            require(request.get('discardUnknownApproved') is True, 'EXPLICIT_UNKNOWN_DISCARD_REQUIRED')
            active(request)
            operation = 'prompt.resolve_unknown'
            await authority.resolve_unknown(actor, ref, state['admissionId'], request['executionGeneration'])
        elif before.status != 'terminal':
            raise CleanupRefused('NATIVE_EXECUTION_STILL_ACTIVE')
        after = await authority.receipt(actor, ref, state['admissionId'])
        require(after.status == 'terminal' and after.outcome in ('completed', 'failed', 'interrupted', 'cancelled', 'rejected'),
                'NATIVE_TERMINAL_RECEIPT_REQUIRED')
        require(not any(live.task is not None for live in authority.sessions.values()), 'NATIVE_DRAIN_WAS_STARTED')
        raw = json.dumps({'jsonrpc': '2.0', 'id': 1, 'result': asdict(after)}, separators=(',', ':'))
        return {'purpose': 'retained-hermes-native-cleanup-v1', 'operatorDecisionSha256': request['operatorDecisionSha256'],
                'workId': request['workId'], 'journalSha256': request['journalSha256'], 'journalModified': False,
                'sessionId': state['sessionId'], 'admissionId': state['admissionId'], 'journalInputId': state['inputId'],
                'originalStatus': original['status'], 'beforeReceipt': asdict(before), 'receiptRawBytes': raw,
                'receipt': asdict(after), 'outcome': after.outcome, 'operation': operation, 'profileId': profile_id, 'instanceId': instance,
                'nativeAuthority': 'gateway.session_authority.SessionAuthority', 'normalGatewayStarted': False,
                'nativeDrainingEnabled': False, 'modelPromptsSubmitted': 0, 'providerRequests': 0, 'toolsInvoked': 0,
                'cleanupDeadlineMs': request['deadlineMs'], 'checkedAtMs': int(time.time() * 1000),
                'suppressedSchedules': authority.suppressed_schedules, 'suppressedPublications': authority.suppressed_publications}
    finally:
        # No untracked execution task is launched. A caller timeout must still
        # await native tracked writes/physical process exit before continuation.
        if authority is not None:
            from gateway.session_runtime_workers import mutation_tasks
            pending = mutation_tasks(authority)
            if pending:
                await asyncio.shield(asyncio.gather(*pending, return_exceptions=True))
        if db is not None:
            db.close()
        ownership.close()


async def main():
    require(len(sys.argv) == 4 and sys.argv[1] == '--native-root', 'CLEANUP_CLI_INVALID')
    root, expected = Path(sys.argv[2]).resolve(strict=True), sys.argv[3]
    raw = sys.stdin.buffer.read(1000001)
    require(len(raw) <= 1000000 and digest(raw) == expected, 'EXACT_CLEANUP_REQUEST_REQUIRED')
    request = json.loads(raw)
    validate_request(request)
    pins = request.get('nativeFileSha256', {})
    required = {'gateway/session_authority.py', 'gateway/session_local_recovery.py', 'gateway/session_runtime_workers.py',
                'gateway/session_results.py', 'gateway/session_ingress.py', 'gateway/runtime_ownership.py',
                'hermes_state_runtime.py', 'hermes_state.py', 'hermes_state_local.py', 'hermes_state_local_lineage.py'}
    require(isinstance(pins, dict) and required <= pins.keys(), 'PINNED_NATIVE_CLEANUP_SOURCE_REQUIRED')
    for relative, sha in pins.items():
        file = (root / relative).resolve(strict=True)
        require(file.is_relative_to(root) and file.is_file() and digest(file.read_bytes()) == sha, 'NATIVE_CLEANUP_SOURCE_CHANGED')
    sys.path.insert(0, str(root))
    with deny_external_execution():
        remaining = (request['deadlineMs'] - time.time() * 1000) / 1000
        require(remaining > 0, 'CLEANUP_DEADLINE_EXPIRED')
        result = await asyncio.wait_for(clean_one(request), remaining)
    result['requestSha256'], result['entrySha256'] = expected, digest(Path(__file__).read_bytes())
    result['receiptProvenance'] = 'actual-native-authority-maintenance-projection-v1'
    print(json.dumps(result, separators=(',', ':')), flush=True)


if __name__ == '__main__':
    # An unresponsive native/DB worker cannot keep this maintenance child alive.
    # The external owner must additionally enforce its own spawn-to-exit bound.
    watchdog = threading.Timer(90, lambda: os._exit(124))
    watchdog.daemon = True
    watchdog.start()
    try:
        asyncio.run(main())
    except Exception as exc:
        code = str(exc) if isinstance(exc, CleanupRefused) else 'NATIVE_CLEANUP_FAILED_PRESERVE_EVIDENCE'
        print(json.dumps({'error': code}), flush=True)
        sys.exit(1)
    finally:
        watchdog.cancel()
