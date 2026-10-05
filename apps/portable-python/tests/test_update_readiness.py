import builtins
import hashlib
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from runtime import updater

# Age the pending record past the readiness grace window, i.e. simulate a
# machine that came back from a reboot long after the update was committed.
_PENDING_GRACE_AFTER_REBOOT = updater._PENDING_GRACE_SECONDS + 1


class UpdateRecoveryTests(unittest.TestCase):
    def fixture(self, directory):
        current = Path(directory) / "PSN.exe"
        staged = Path(directory) / "data/update/PSN.next.exe"
        staged.parent.mkdir(parents=True)
        current.write_bytes(b"old")
        staged.write_bytes(b"new")
        return current, staged, ["helper", "--apply-update", "123", str(current), str(staged),
                                "3", hashlib.sha256(b"new").hexdigest()]

    def test_kill_after_backup_keeps_public_launcher(self):
        with tempfile.TemporaryDirectory() as directory:
            current, _, args = self.fixture(directory)
            copy = updater._copy_durable

            def copy_then_kill(source, target):
                copy(source, target)
                raise SystemExit("kill after durable backup")

            with mock.patch.object(updater, "_wait_for_parent", return_value=str(current)), \
                    mock.patch.object(updater, "_copy_durable", side_effect=copy_then_kill):
                with self.assertRaises(SystemExit):
                    updater.apply_update_cli(args)
            self.assertEqual(current.read_bytes(), b"old")
            self.assertEqual(Path(str(current) + ".bak").read_bytes(), b"old")

    def test_failed_install_keeps_old_launcher_without_unlink(self):
        with tempfile.TemporaryDirectory() as directory:
            current, staged, args = self.fixture(directory)
            replace = updater._replace_retry

            def fail_commit(source, target, *a, **kw):
                if source == str(staged):
                    raise OSError("AV sharing violation")
                return replace(source, target, *a, **kw)

            with mock.patch.object(updater, "_wait_for_parent", return_value=str(current)), \
                    mock.patch.object(updater, "arm_independent_recovery", return_value=True), \
                    mock.patch.object(updater, "_replace_retry", side_effect=fail_commit), \
                    mock.patch.object(updater.subprocess, "Popen"), \
                    mock.patch.object(updater, "_updater_log"):
                self.assertEqual(updater.apply_update_cli(args), 1)
            self.assertEqual(current.read_bytes(), b"old")

    def test_failed_readiness_restores_and_restarts_old_version(self):
        with tempfile.TemporaryDirectory() as directory:
            current, _, args = self.fixture(directory)
            with mock.patch.object(updater, "_wait_for_parent", return_value=str(current)), \
                    mock.patch.object(updater, "arm_independent_recovery", return_value=True), \
                    mock.patch.object(updater, "_start_verified_update", side_effect=RuntimeError("early exit")), \
                    mock.patch.object(updater.subprocess, "Popen") as restart, \
                    mock.patch.object(updater, "_updater_log"):
                self.assertEqual(updater.apply_update_cli(args), 1)
            self.assertEqual(current.read_bytes(), b"old")
            restart.assert_called_once_with([str(current)], cwd=directory, close_fds=True)

    def test_unconfirmed_candidate_retirement_does_not_start_another_generation(self):
        with tempfile.TemporaryDirectory() as directory:
            current, _, args = self.fixture(directory)
            with mock.patch.object(updater, "_wait_for_parent", return_value=str(current)), \
                    mock.patch.object(updater, "arm_independent_recovery", return_value=True), \
                    mock.patch.object(updater, "_start_verified_update", side_effect=updater.UpdateProcessStillRunningError()), \
                    mock.patch.object(updater.subprocess, "Popen") as restart, \
                    mock.patch.object(updater, "_updater_log"):
                self.assertEqual(updater.apply_update_cli(args), 1)
            restart.assert_not_called()
            self.assertEqual(current.read_bytes(), b"new")
            self.assertEqual(Path(str(current) + ".bak").read_bytes(), b"old")


class FailClosedRecoveryArmingTests(unittest.TestCase):
    """No independent recovery executor means no destructive replace at all."""

    def fixture(self, directory):
        current = Path(directory) / "PSN.exe"
        staged = Path(directory) / "data/update/PSN.next.exe"
        staged.parent.mkdir(parents=True)
        current.write_bytes(b"old")
        staged.write_bytes(b"new")
        Path(str(current) + ".bak").write_bytes(b"old")
        marker = Path(updater.pending_marker_path(str(current)))
        helper = Path(directory) / "data/runtime/PSNUpdater.exe"
        helper.parent.mkdir(parents=True, exist_ok=True)
        helper.write_bytes(b"helper")
        args = ["helper", "--apply-update", "123", str(current), str(staged),
                "3", hashlib.sha256(b"new").hexdigest()]
        return current, staged, args, marker

    def test_commit_is_aborted_when_watchdog_is_not_armed(self):
        with tempfile.TemporaryDirectory() as directory:
            current, staged, args, marker = self.fixture(directory)
            with mock.patch.object(updater, "_wait_for_parent", return_value=str(current)), \
                    mock.patch.object(updater, "arm_independent_recovery", return_value=False), \
                    mock.patch.object(updater, "_replace_retry", wraps=updater._replace_retry) as replace, \
                    mock.patch.object(updater, "_start_verified_update") as start, \
                    mock.patch.object(updater.subprocess, "Popen") as restart, \
                    mock.patch.object(updater, "_updater_log"):
                self.assertEqual(updater.apply_update_cli(args), 1)

            # The staged image was never published and the known-good launcher
            # is still in place, so the abort costs only a restart.
            self.assertEqual(
                [call.args for call in replace.call_args_list if call.args and call.args[0] == str(staged)],
                [],
            )
            start.assert_not_called()
            self.assertEqual(current.read_bytes(), b"old")
            self.assertEqual(staged.read_bytes(), b"new")
            self.assertFalse(marker.exists())
            restart.assert_called_once_with([str(current)], cwd=directory, close_fds=True)


    def test_acknowledged_watchdog_allows_commit(self):
        with tempfile.TemporaryDirectory() as directory:
            current, _, args, marker = self.fixture(directory)
            with mock.patch.object(updater, "_wait_for_parent", return_value=str(current)), \
                    mock.patch.object(updater, "arm_independent_recovery", return_value=True), \
                    mock.patch.object(updater, "_record_candidate_pid", return_value=True), \
                    mock.patch.object(updater, "_start_verified_update"), \
                    mock.patch.object(updater, "_updater_log"):
                self.assertEqual(updater.apply_update_cli(args), 0)
            self.assertEqual(current.read_bytes(), b"new")
            self.assertFalse(marker.exists())


    def test_update_arming_works_with_registry_access_forbidden(self):
        real_import = builtins.__import__

        def forbid_registry(name, *args, **kwargs):
            if name == "winreg":
                raise AssertionError("Portable updates must not access the registry")
            return real_import(name, *args, **kwargs)

        with tempfile.TemporaryDirectory() as directory:
            current, _, _, marker = self.fixture(directory)
            token = "a" * 32
            updater._write_pending_transaction(str(marker), {
                "schema": updater._PENDING_SCHEMA, "token": token, "createdAt": 0,
                "current": str(current), "backup": str(current) + ".bak",
                "previousSha256": hashlib.sha256(b"old").hexdigest(),
                "candidateSha256": hashlib.sha256(b"new").hexdigest(), "candidatePid": 0,
            })
            helper = str(Path(directory) / "data/runtime/PSNUpdater.exe")
            proc = mock.Mock()
            proc.poll.return_value = None

            def acknowledge(_helper, marker_path, token, **_kwargs):
                updater._confirm_recovery_armed(
                    marker_path, updater._watchdog_armed_path(marker_path, token), token)
                return proc

            with mock.patch.object(builtins, "__import__", side_effect=forbid_registry), \
                    mock.patch.object(updater, "start_recovery_watchdog", side_effect=acknowledge):
                self.assertTrue(updater.arm_independent_recovery(helper, str(marker), token))

    def test_watchdog_arming_requires_a_durable_acknowledgement(self):
        with tempfile.TemporaryDirectory() as directory:
            _, _, _, marker = self.fixture(directory)
            helper = str(Path(directory) / "data/runtime/PSNUpdater.exe")
            token = "a" * 32
            updater._write_pending_transaction(str(marker), {
                "schema": updater._PENDING_SCHEMA,
                "token": token,
                "createdAt": 0,
                "current": str(Path(directory) / "PSN.exe"),
                "backup": str(Path(directory) / "PSN.exe.bak"),
                "previousSha256": hashlib.sha256(b"old").hexdigest(),
                "candidateSha256": hashlib.sha256(b"new").hexdigest(),
                "candidatePid": 0,
            })
            armed_path = updater._watchdog_armed_path(str(marker), token)
            proc = mock.Mock()
            proc.poll.return_value = None

            # A watchdog that starts but never acknowledges is not armed.
            with mock.patch.object(updater, "start_recovery_watchdog", return_value=proc):
                self.assertFalse(updater.arm_recovery_watchdog(helper, str(marker), token, timeout=0.1))
            self.assertFalse(os.path.exists(armed_path))

            # A watchdog that dies immediately is not armed either.
            dead = mock.Mock()
            dead.poll.return_value = 1
            with mock.patch.object(updater, "start_recovery_watchdog", return_value=dead):
                self.assertFalse(updater.arm_recovery_watchdog(helper, str(marker), token, timeout=0.1))
            self.assertFalse(os.path.exists(armed_path))

            # A watchdog that acknowledged this exact transaction is armed.
            def acknowledge(_helper, _marker, _timeout=None, armed_path=None, token=None, **_kw):
                updater._confirm_recovery_armed(str(marker), armed_path, token)
                return proc

            with mock.patch.object(updater, "start_recovery_watchdog", side_effect=acknowledge):
                self.assertTrue(updater.arm_recovery_watchdog(helper, str(marker), token, timeout=0.5))
            self.assertTrue(os.path.exists(armed_path))

            # Settling the transaction drops the acknowledgement.
            updater._settle_pending_transaction(str(marker))
            self.assertFalse(os.path.exists(armed_path))

    def test_recovery_helper_refuses_to_acknowledge_a_foreign_transaction(self):
        with tempfile.TemporaryDirectory() as directory:
            _, _, _, marker = self.fixture(directory)
            updater._write_pending_transaction(str(marker), {
                "schema": updater._PENDING_SCHEMA,
                "token": "a" * 32,
                "createdAt": 0,
                "current": str(Path(directory) / "PSN.exe"),
                "backup": str(Path(directory) / "PSN.exe.bak"),
                "previousSha256": hashlib.sha256(b"old").hexdigest(),
                "candidateSha256": hashlib.sha256(b"new").hexdigest(),
                "candidatePid": 0,
            })
            armed_path = updater._watchdog_armed_path(str(marker), "b" * 32)
            # Wrong token: the helper must not claim a transaction it does
            # not own, and must not start waiting on it either.
            self.assertEqual(updater.recover_pending_cli(
                ["helper", "--recover-pending", str(marker), "0", armed_path, "b" * 32]), 2)
            self.assertFalse(os.path.exists(armed_path))
            # Correct token: the transaction is acknowledged and then acted on.
            with mock.patch.object(updater, "candidate_generation_alive", return_value=False), \
                    mock.patch.object(updater.subprocess, "Popen"):
                self.assertEqual(updater.recover_pending_cli(
                    ["helper", "--recover-pending", str(marker), "0",
                     updater._watchdog_armed_path(str(marker), "a" * 32), "a" * 32]), 0)

    def test_acknowledgement_cannot_be_written_outside_the_runtime_directory(self):
        with tempfile.TemporaryDirectory() as directory:
            _, _, _, marker = self.fixture(directory)
            outside = str(Path(directory) / "escaped.json")
            self.assertFalse(updater._confirm_recovery_armed(str(marker), outside, "a" * 32))
            self.assertFalse(os.path.exists(outside))


class UpdateTransactionRecoveryTests(unittest.TestCase):
    """A hard interruption after the commit replace must stay recoverable.

    ``SystemExit``/``kill`` after ``staged -> current`` cannot run the helper's
    ``except``/``finally`` blocks, so recovery has to be owned by a component
    that does not depend on the freshly installed candidate starting.
    """

    def fixture(self, directory):
        current = Path(directory) / "PSN.exe"
        staged = Path(directory) / "data/update/PSN.next.exe"
        staged.parent.mkdir(parents=True)
        current.write_bytes(b"old")
        staged.write_bytes(b"new")
        marker = Path(updater.pending_marker_path(str(current)))
        helper = Path(directory) / "data/runtime/PSNUpdater.exe"
        helper.parent.mkdir(parents=True, exist_ok=True)
        helper.write_bytes(b"helper")
        args = ["helper", "--apply-update", "123", str(current), str(staged),
                "3", hashlib.sha256(b"new").hexdigest()]
        return current, staged, args, marker

    def test_hard_kill_after_commit_is_healed_without_the_candidate(self):
        with tempfile.TemporaryDirectory() as directory:
            current, _, args, marker = self.fixture(directory)
            with mock.patch.object(updater, "_wait_for_parent", return_value=str(current)), \
                    mock.patch.object(updater, "_updater_log"), \
                    mock.patch.object(updater, "arm_independent_recovery", return_value=True), \
                    mock.patch.object(updater, "_start_verified_update", side_effect=SystemExit("power loss")):
                with self.assertRaises(SystemExit):
                    updater.apply_update_cli(args)

            # Committed but unconfirmed: the candidate owns the public path and
            # the known-good image exists only as PSN.exe.bak.
            self.assertEqual(current.read_bytes(), b"new")
            self.assertEqual(Path(str(current) + ".bak").read_bytes(), b"old")
            record = updater.read_pending_transaction(str(marker))
            self.assertIsNotNone(record)
            self.assertEqual(record["candidateSha256"], hashlib.sha256(b"new").hexdigest())
            self.assertEqual(record["previousSha256"], hashlib.sha256(b"old").hexdigest())

            # The independent recovery helper heals the launcher's availability.
            with mock.patch.object(updater, "candidate_generation_alive", return_value=False), \
                    mock.patch.object(updater.subprocess, "Popen") as restart:
                self.assertEqual(updater.recover_pending_cli(
                    ["helper", "--recover-pending", str(marker), "0"]), 0)
            self.assertEqual(current.read_bytes(), b"old")
            self.assertFalse(marker.exists())
            restart.assert_called_once_with([str(current)], cwd=directory, close_fds=True)

    def test_manual_helper_recovers_after_a_power_loss(self):
        # Power loss inside the readiness window destroys the detached watchdog;
        # durable files retain the transaction until the user explicitly starts
        # the known-good recovery helper. No OS autostart is registered.
        with tempfile.TemporaryDirectory() as directory:
            current, _, args, marker = self.fixture(directory)
            with mock.patch.object(updater, "_wait_for_parent", return_value=str(current)), \
                    mock.patch.object(updater, "_updater_log"), \
                    mock.patch.object(updater, "arm_independent_recovery", return_value=True), \
                    mock.patch.object(updater, "_start_verified_update", side_effect=SystemExit("power loss")):
                with self.assertRaises(SystemExit):
                    updater.apply_update_cli(args)
            self.assertEqual(current.read_bytes(), b"new")
            self.assertTrue(marker.exists())

            # The machine came back after the readiness window had already
            # elapsed, so the manually launched helper acts immediately.
            with mock.patch.object(updater, "_pending_age", return_value=_PENDING_GRACE_AFTER_REBOOT), \
                    mock.patch.object(updater, "candidate_generation_alive", return_value=False), \
                    mock.patch.object(updater.subprocess, "Popen") as restart:
                self.assertEqual(updater.recover_pending_cli(
                    ["helper", "--recover-pending", str(marker)]), 0)
            self.assertEqual(current.read_bytes(), b"old")
            self.assertFalse(marker.exists())
            restart.assert_called_once_with([str(current)], cwd=directory, close_fds=True)

    def test_recovery_never_rolls_back_a_live_candidate_generation(self):
        with tempfile.TemporaryDirectory() as directory:
            current, _, args, marker = self.fixture(directory)
            with mock.patch.object(updater, "_wait_for_parent", return_value=str(current)), \
                    mock.patch.object(updater, "_updater_log"), \
                    mock.patch.object(updater, "arm_independent_recovery", return_value=True), \
                    mock.patch.object(updater, "_start_verified_update", side_effect=SystemExit("helper killed")):
                with self.assertRaises(SystemExit):
                    updater.apply_update_cli(args)
            record = updater.read_pending_transaction(str(marker))
            self.assertEqual(record["current"], str(current))
            with mock.patch.object(updater, "candidate_generation_alive", return_value=True), \
                    mock.patch.object(updater.subprocess, "Popen") as restart:
                self.assertEqual(updater.recover_pending_cli(
                    ["helper", "--recover-pending", str(marker), "0"]), 0)
            self.assertEqual(current.read_bytes(), b"new")
            self.assertTrue(marker.exists())
            restart.assert_not_called()

    def test_watchdog_stays_out_once_the_transaction_is_confirmed(self):
        with tempfile.TemporaryDirectory() as directory:
            current, _, args, marker = self.fixture(directory)
            with mock.patch.object(updater, "_wait_for_parent", return_value=str(current)), \
                    mock.patch.object(updater, "_updater_log"), \
                    mock.patch.object(updater, "arm_independent_recovery", return_value=True), \
                    mock.patch.object(updater, "_record_candidate_pid", return_value=True) as record_pid, \
                    mock.patch.object(updater, "_start_verified_update") as start:
                self.assertEqual(updater.apply_update_cli(args), 0)
                # The candidate pid is published so an independent recovery can
                # tell a live generation from a dead one.
                start.call_args.kwargs["on_spawn"](4242)
            self.assertEqual(current.read_bytes(), b"new")
            self.assertFalse(marker.exists())
            record_pid.assert_called_once_with(str(marker), 4242)
            with mock.patch.object(updater.subprocess, "Popen") as restart:
                self.assertEqual(updater.recover_pending_cli(
                    ["helper", "--recover-pending", str(marker), "0"]), 0)
            restart.assert_not_called()

    def test_failed_readiness_restores_the_image_and_settles_the_transaction(self):
        with tempfile.TemporaryDirectory() as directory:
            current, _, args, marker = self.fixture(directory)
            with mock.patch.object(updater, "_wait_for_parent", return_value=str(current)), \
                    mock.patch.object(updater, "_updater_log"), \
                    mock.patch.object(updater, "arm_independent_recovery", return_value=True), \
                    mock.patch.object(updater, "_start_verified_update", side_effect=RuntimeError("early exit")), \
                    mock.patch.object(updater.subprocess, "Popen"):
                self.assertEqual(updater.apply_update_cli(args), 1)
            self.assertEqual(current.read_bytes(), b"old")
            self.assertFalse(marker.exists())

    def test_failed_replace_settles_the_transaction_without_recovery(self):
        with tempfile.TemporaryDirectory() as directory:
            current, staged, args, marker = self.fixture(directory)
            replace = updater._replace_retry

            def fail_commit(source, target, *a, **kw):
                if source == str(staged):
                    raise OSError("AV sharing violation")
                return replace(source, target, *a, **kw)

            with mock.patch.object(updater, "_wait_for_parent", return_value=str(current)), \
                    mock.patch.object(updater, "_replace_retry", side_effect=fail_commit), \
                    mock.patch.object(updater, "arm_independent_recovery", return_value=True), \
                    mock.patch.object(updater.subprocess, "Popen"), \
                    mock.patch.object(updater, "_updater_log"):
                self.assertEqual(updater.apply_update_cli(args), 1)
            self.assertEqual(current.read_bytes(), b"old")
            self.assertFalse(marker.exists())

    def test_startup_alone_never_retires_an_unconfirmed_candidate(self):
        with tempfile.TemporaryDirectory() as directory:
            current, _, args, marker = self.fixture(directory)
            with mock.patch.object(updater, "_wait_for_parent", return_value=str(current)), \
                    mock.patch.object(updater, "_updater_log"), \
                    mock.patch.object(updater, "arm_independent_recovery", return_value=True), \
                    mock.patch.object(updater, "_start_verified_update", side_effect=SystemExit("reboot")):
                with self.assertRaises(SystemExit):
                    updater.apply_update_cli(args)
            with mock.patch.object(updater, "start_recovery_watchdog") as rearm:
                self.assertEqual(updater.reconcile_pending_update(str(current)), "pending")
            # A candidate that dies after startup is still recoverable, so only
            # the readiness confirmation retires the record.
            self.assertTrue(marker.exists())
            # The power cut destroyed the update-time watchdog, so this generation
            # re-arms one for itself instead of being the last executor.
            rearm.assert_called_once()
            self.assertEqual(
                [Path(arg).name for arg in rearm.call_args.args[:1]],
                ["PSNUpdater.exe"],
            )
            self.assertEqual(
                updater.read_pending_transaction(str(marker))["candidatePid"], os.getpid())
            runtime_dir = str(Path(directory) / "data/runtime")
            with mock.patch.object(updater.paths, "runtime_dir", return_value=runtime_dir), \
                    mock.patch.object(updater.sys, "executable", str(current)):
                updater.notify_update_ready(["app", "--update-ready=" + "a" * 64])
            self.assertFalse(marker.exists())
            self.assertEqual(current.read_bytes(), b"new")

    def test_manual_restart_confirms_readiness_without_an_update_token(self):
        with tempfile.TemporaryDirectory() as directory:
            current, _, args, marker = self.fixture(directory)
            with mock.patch.object(updater, "_wait_for_parent", return_value=str(current)), \
                    mock.patch.object(updater, "arm_independent_recovery", return_value=True), \
                    mock.patch.object(updater, "_start_verified_update", side_effect=SystemExit("power loss")):
                with self.assertRaises(SystemExit):
                    updater.apply_update_cli(args)
            with mock.patch.object(updater, "start_recovery_watchdog"), \
                    mock.patch.object(updater.sys, "executable", str(current)):
                self.assertEqual(updater.reconcile_pending_update(), "pending")
                self.assertTrue(marker.exists())
                updater.notify_update_ready(["app"])
            self.assertFalse(marker.exists())
            self.assertEqual(current.read_bytes(), b"new")

    def test_readiness_does_not_confirm_an_unexpected_launcher(self):
        with tempfile.TemporaryDirectory() as directory:
            current, _, args, marker = self.fixture(directory)
            with mock.patch.object(updater, "_wait_for_parent", return_value=str(current)), \
                    mock.patch.object(updater, "arm_independent_recovery", return_value=True), \
                    mock.patch.object(updater, "_start_verified_update", side_effect=SystemExit("power loss")):
                with self.assertRaises(SystemExit):
                    updater.apply_update_cli(args)
            current.write_bytes(b"unexpected")
            with mock.patch.object(updater.sys, "executable", str(current)):
                updater.notify_update_ready(["app"])
            self.assertTrue(marker.exists())

    def test_startup_does_not_re_arm_a_helper_started_candidate(self):
        # The normal update path already has a live watchdog; spawning a second
        # onefile helper for every successful update would be pure cost.
        with tempfile.TemporaryDirectory() as directory:
            current, _, _, marker = self.fixture(directory)
            current.write_bytes(b"new")
            updater._write_pending_transaction(str(marker), {
                "schema": updater._PENDING_SCHEMA,
                "token": "a" * 32,
                "createdAt": 0,
                "current": str(current),
                "backup": str(current) + ".bak",
                "previousSha256": hashlib.sha256(b"old").hexdigest(),
                "candidateSha256": hashlib.sha256(b"new").hexdigest(),
                "candidatePid": os.getpid(),
            })
            with mock.patch.object(updater, "_updater_log"), \
                    mock.patch.object(updater, "start_recovery_watchdog") as rearm:
                self.assertEqual(updater.reconcile_pending_update(str(current)), "pending")
            rearm.assert_not_called()

    def test_startup_recovery_is_not_re_armed_without_the_previous_helper_copy(self):
        with tempfile.TemporaryDirectory() as directory:
            current, _, _, marker = self.fixture(directory)
            Path(str(Path(directory) / "data/runtime/PSNUpdater.exe")).unlink()
            current.write_bytes(b"new")
            updater._write_pending_transaction(str(marker), {
                "schema": updater._PENDING_SCHEMA,
                "token": "a" * 32,
                "createdAt": 0,
                "current": str(current),
                "backup": str(current) + ".bak",
                "previousSha256": hashlib.sha256(b"old").hexdigest(),
                "candidateSha256": hashlib.sha256(b"new").hexdigest(),
                "candidatePid": 0,
            })
            with mock.patch.object(updater, "_updater_log"), \
                    mock.patch.object(updater, "start_recovery_watchdog") as rearm:
                self.assertEqual(updater.reconcile_pending_update(str(current)), "pending")
            rearm.assert_not_called()
            self.assertTrue(marker.exists())

    def test_startup_reconcile_clears_a_completed_rollback(self):
        with tempfile.TemporaryDirectory() as directory:
            current, _, args, marker = self.fixture(directory)
            with mock.patch.object(updater, "_wait_for_parent", return_value=str(current)), \
                    mock.patch.object(updater, "_updater_log"), \
                    mock.patch.object(updater, "arm_independent_recovery", return_value=True), \
                    mock.patch.object(updater, "_start_verified_update", side_effect=SystemExit("reboot")):
                with self.assertRaises(SystemExit):
                    updater.apply_update_cli(args)
            updater._replace_retry(str(current) + ".bak", str(current))
            self.assertEqual(updater.reconcile_pending_update(str(current)), "rolled-back")
            self.assertFalse(marker.exists())

    def test_startup_reconcile_reports_an_unexpected_image_without_touching_it(self):
        with tempfile.TemporaryDirectory() as directory:
            current, _, args, marker = self.fixture(directory)
            with mock.patch.object(updater, "_wait_for_parent", return_value=str(current)), \
                    mock.patch.object(updater, "_updater_log"), \
                    mock.patch.object(updater, "arm_independent_recovery", return_value=True), \
                    mock.patch.object(updater, "_start_verified_update", side_effect=SystemExit("reboot")):
                with self.assertRaises(SystemExit):
                    updater.apply_update_cli(args)
            current.write_bytes(b"other")
            self.assertEqual(updater.reconcile_pending_update(str(current)), "diverged")
            # A running launcher cannot replace itself on Windows; the recovery
            # helper owns the file replacement decision.
            self.assertEqual(current.read_bytes(), b"other")
            self.assertTrue(marker.exists())

    def test_recovery_refuses_a_marker_for_another_launcher(self):
        with tempfile.TemporaryDirectory() as directory:
            current, _, _, marker = self.fixture(directory)
            record = {
                "schema": updater._PENDING_SCHEMA,
                "token": "a" * 32,
                "createdAt": 0,
                "current": str(current),
                "backup": str(current) + ".bak",
                "previousSha256": hashlib.sha256(b"old").hexdigest(),
                "candidateSha256": hashlib.sha256(b"new").hexdigest(),
                "candidatePid": 0,
            }
            updater._write_pending_transaction(str(marker), record)
            self.assertIsNotNone(updater.read_pending_transaction(str(marker)))
            updater._write_pending_transaction(str(marker), dict(record, backup=str(current) + ".other"))
            self.assertIsNone(updater.read_pending_transaction(str(marker)))
            updater._write_pending_transaction(str(marker), dict(record, current=str(current) + ".other"))
            self.assertIsNone(updater.read_pending_transaction(str(marker)))
            updater._write_pending_transaction(str(marker), dict(record, token="../../escape"))
            self.assertIsNone(updater.read_pending_transaction(str(marker)))

    def test_recovery_keeps_the_new_image_when_the_backup_fails_integrity(self):
        with tempfile.TemporaryDirectory() as directory:
            current, _, args, marker = self.fixture(directory)
            with mock.patch.object(updater, "_wait_for_parent", return_value=str(current)), \
                    mock.patch.object(updater, "_updater_log"), \
                    mock.patch.object(updater, "arm_independent_recovery", return_value=True), \
                    mock.patch.object(updater, "_start_verified_update", side_effect=SystemExit("power loss")):
                with self.assertRaises(SystemExit):
                    updater.apply_update_cli(args)
            Path(str(current) + ".bak").write_bytes(b"corrupted")
            with mock.patch.object(updater, "candidate_generation_alive", return_value=False), \
                    mock.patch.object(updater.subprocess, "Popen") as restart:
                self.assertEqual(updater.recover_pending_cli(
                    ["helper", "--recover-pending", str(marker), "0"]), 1)
            self.assertEqual(current.read_bytes(), b"new")
            self.assertTrue(marker.exists())
            restart.assert_not_called()


class UpdateReadinessTests(unittest.TestCase):
    def test_early_exit_is_not_success_even_with_ready_file(self):
        with tempfile.TemporaryDirectory() as directory:
            ready = Path(directory) / "ready.json"
            ready.write_text(json.dumps({"token": "a" * 64, "exe": sys.executable}))
            proc = mock.Mock()
            proc.poll.return_value = 1
            with self.assertRaisesRegex(RuntimeError, "завершилась"):
                updater._wait_for_update_ready(proc, str(ready), "a" * 64, sys.executable)

    def test_wrong_token_or_image_cannot_confirm_readiness(self):
        with tempfile.TemporaryDirectory() as directory:
            ready = Path(directory) / "ready.json"
            proc = mock.Mock()
            proc.poll.return_value = None
            for record in ({"token": "b" * 64, "exe": sys.executable},
                           {"token": "a" * 64, "exe": "other.exe"}):
                ready.write_text(json.dumps(record))
                with self.assertRaisesRegex(RuntimeError, "готовность"):
                    updater._wait_for_update_ready(proc, str(ready), "a" * 64, sys.executable, timeout=0.01)

    def test_ready_requires_matching_token_image_and_live_stabilization(self):
        with tempfile.TemporaryDirectory() as directory:
            ready = Path(directory) / "ready.json"
            token = "a" * 64
            with mock.patch.object(updater.paths, "runtime_dir", return_value=directory):
                updater.notify_update_ready(["app", "--update-ready=" + token])
            ready = Path(directory) / ("update-start-" + token + ".json")
            proc = mock.Mock()
            proc.poll.return_value = None
            updater._wait_for_update_ready(proc, str(ready), token, sys.executable, timeout=2)
            self.assertGreater(proc.poll.call_count, 1)

    def test_ready_token_cannot_choose_an_arbitrary_path(self):
        with self.assertRaises(RuntimeError):
            updater.notify_update_ready(["app", "--update-ready=../../outside"])

    @unittest.skipUnless(os.name == "nt", "Windows Job Object")
    def test_candidate_failure_terminates_job_before_rollback(self):
        from windows import process_tree

        with tempfile.TemporaryDirectory() as directory, \
                mock.patch.object(updater.secrets, "token_hex", return_value="a" * 64), \
                mock.patch.object(updater.subprocess, "Popen") as spawn, \
                mock.patch.object(process_tree, "create_kill_on_close_job", return_value=123), \
                mock.patch.object(process_tree, "assign_process"), \
                mock.patch.object(process_tree, "resume_suspended_process"), \
                mock.patch.object(process_tree, "terminate_job_and_wait", return_value=True) as stop, \
                mock.patch.object(process_tree, "close_job"), \
                mock.patch.object(updater, "_wait_for_update_ready", side_effect=RuntimeError("timeout")):
            spawn.return_value.poll.return_value = None
            with self.assertRaisesRegex(RuntimeError, "timeout"):
                updater._start_verified_update(str(Path(directory) / "PSN.exe"))
            stop.assert_called_once_with(123, timeout=10.0)
            spawn.return_value.wait.assert_called_once_with(timeout=10.0)
