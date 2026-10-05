import os
import unittest
import sys
import tempfile
import hashlib
from unittest import mock

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, ".."))
sys.path.insert(0, ROOT)

from runtime import updater as updater_mod  # noqa: E402
from runtime.updater import (  # noqa: E402
    best_available_update,
    comparable_app_version,
    compare_release_revisions,
    is_newer_release,
    is_newer_version,
    parse_build_label,
    parse_release_revision,
    release_label,
    update_check_summary,
    verify_staged_update,
)


def _peer(
    peer_id, version, build, online=True, available=True, compatible=True,
    signature_verified=True, signature_required=True, trusted_source=True,
    revision=None,
):
    update = {
        "appVersion": version,
        "buildLabel": build,
        "available": available,
        "compatible": compatible,
        "signatureVerified": signature_verified,
        "signatureRequired": signature_required,
        "trustedSource": trusted_source,
    }
    if revision is not None:
        update["releaseRevision"] = revision
    return {
        "id": peer_id,
        "online": online,
        "update": update,
    }


class UpdateVersionTests(unittest.TestCase):
    def test_semver_still_wins(self):
        self.assertTrue(is_newer_version("1.0.1", "1.0.0"))
        self.assertFalse(is_newer_version("1.0.0", "1.0.0"))

    def test_old_core_sees_date_inside_app_version(self):
        self.assertEqual(comparable_app_version("0.0.0", "140926"), "0.0.0.20260914")
        self.assertEqual(comparable_app_version("0.0.0", "010126"), "0.0.0.20260101")
        self.assertTrue(is_newer_version("0.0.0.20260914", "0.0.0"))
        self.assertTrue(is_newer_version("0.0.0.20260914", "0.0.0.20260911"))
        self.assertFalse(is_newer_version("0.0.0.20260911", "0.0.0.20260914"))

    def test_legacy_label_is_parseable_but_isolated_from_peersync(self):
        self.assertEqual(parse_build_label("n-140926"), (2026, 9, 14))
        self.assertFalse(is_newer_release("2.0.0", "n-220926", "0.0.0", "230926"))
        self.assertFalse(is_newer_release("0.0.0", "230926", "2.0.0", "n-220926"))

    def test_public_release_label_is_date_only(self):
        self.assertEqual(release_label("0.0.0.20260923", "230926"), "230926")
        self.assertEqual(release_label("2.0.0", "n-220926"), "2.0.0 n-220926")

    def test_same_app_version_uses_build_label_date(self):
        self.assertEqual(parse_build_label("140926"), (2026, 9, 14))
        self.assertTrue(is_newer_release("0.0.0", "150926", "0.0.0", "140926"))
        self.assertFalse(is_newer_release("0.0.0", "140926", "0.0.0", "150926"))
        self.assertTrue(is_newer_release("0.0.0", "010126", "0.0.0", "311225"))

    def test_higher_app_version_beats_older_build_date(self):
        self.assertTrue(is_newer_release("1.0.1", "010101", "1.0.0", "140926"))


class ReleaseRevisionTests(unittest.TestCase):
    """Two official builds of one calendar date must stay distinguishable."""

    def test_parses_only_bounded_non_negative_integers(self):
        self.assertEqual(parse_release_revision(0), 0)
        self.assertEqual(parse_release_revision(184), 184)
        self.assertEqual(parse_release_revision("184"), 184)
        self.assertEqual(parse_release_revision(None), 0)
        self.assertEqual(parse_release_revision(-1), 0)
        self.assertEqual(parse_release_revision(""), 0)
        self.assertEqual(parse_release_revision("1e3"), 0)
        self.assertEqual(parse_release_revision(True), 0)
        self.assertEqual(parse_release_revision(1.5), 0)
        self.assertEqual(parse_release_revision(10 ** 9), 0)

    def test_same_day_builds_are_ordered_by_revision(self):
        self.assertTrue(is_newer_release("0.0.0", "031026", "0.0.0", "031026", 184, 183))
        self.assertFalse(is_newer_release("0.0.0", "031026", "0.0.0", "031026", 183, 184))
        self.assertEqual(compare_release_revisions(184, 184), 0)

    def test_a_pre_revision_same_day_peer_never_replaces_a_revisioned_build(self):
        self.assertFalse(is_newer_release("0.0.0", "031026", "0.0.0", "031026", 0, 5))
        self.assertTrue(is_newer_release("0.0.0", "031026", "0.0.0", "031026", 5, 0))

    def test_revision_never_overrides_a_different_calendar_date(self):
        self.assertTrue(is_newer_release("0.0.0", "041026", "0.0.0", "031026", 1, 9999))
        self.assertFalse(is_newer_release("0.0.0", "031026", "0.0.0", "041026", 9999, 1))

    def test_revision_never_orders_the_legacy_lineage(self):
        self.assertFalse(is_newer_release("0.0.0", "n-031026", "0.0.0", "n-031026", 9999, 1))

    def test_best_offer_uses_the_highest_revision_of_the_same_date(self):
        peers = [
            _peer("a", "0.0.0", "031026", revision=183),
            _peer("b", "0.0.0", "031026", revision=184),
            _peer("c", "0.0.0", "031026"),
        ]
        best = best_available_update(peers, "0.0.0", "031026", current_revision=182)
        self.assertEqual(best["peerId"], "b")
        self.assertEqual(best["releaseRevision"], 184)

    def test_no_offer_for_the_same_date_at_the_same_revision(self):
        peers = [_peer("a", "0.0.0", "031026", revision=184)]
        self.assertIsNone(best_available_update(peers, "0.0.0", "031026", current_revision=184))

    def test_summary_orders_same_day_reports_by_revision(self):
        peers = [
            _peer("a", "0.0.0", "031026", revision=183),
            _peer("b", "0.0.0", "031026", revision=184),
        ]
        kind, info = update_check_summary(peers, "0.0.0", "031026", current_revision=185)
        self.assertEqual(kind, "none")
        self.assertEqual(info["peerId"], "b")
        self.assertEqual(info["releaseRevision"], 184)


class BestAvailableUpdateTests(unittest.TestCase):
    def test_picks_newest_among_several_clients(self):
        peers = [
            _peer("a", "0.0.0", "130926"),
            _peer("b", "0.0.0", "150926"),
            _peer("c", "0.0.0", "140926"),
        ]
        best = best_available_update(peers, "0.0.0", "120926")
        self.assertEqual(best["peerId"], "b")
        self.assertEqual(best["buildLabel"], "150926")

    def test_skips_offline_incompatible_and_older(self):
        peers = [
            _peer("old", "0.0.0", "110926"),
            _peer("off", "0.0.1", "150926", online=False),
            _peer("bad", "0.0.1", "150926", compatible=False),
            _peer("ok", "0.0.0", "140926"),
        ]
        best = best_available_update(peers, "0.0.0", "120926")
        self.assertEqual(best["peerId"], "ok")

    def test_prefers_selected_peer_when_versions_match(self):
        peers = [
            _peer("a", "0.0.0", "150926"),
            _peer("b", "0.0.0", "150926"),
        ]
        best = best_available_update(peers, "0.0.0", "120926", preferred_peer_id="b")
        self.assertEqual(best["peerId"], "b")

    def test_returns_none_when_nobody_is_newer(self):
        peers = [
            _peer("a", "0.0.0", "110926"),
            _peer("b", "0.0.0", "120926"),
        ]
        self.assertIsNone(best_available_update(peers, "0.0.0", "120926"))

    def test_summary_reports_remote_version_when_not_newer(self):
        peers = [_peer("a", "0.0.0", "130926")]
        kind, info = update_check_summary(peers, "0.0.0", "140926")
        self.assertEqual(kind, "none")
        self.assertEqual(info["buildLabel"], "130926")

    def test_summary_reports_missing_hello(self):
        peers = [{"id": "a", "online": True, "update": None}]
        kind, info = update_check_summary(peers, "0.0.0", "140926")
        self.assertEqual(kind, "no_info")
        self.assertIsNone(info)

    def test_summary_reports_newer_without_installer(self):
        peers = [_peer("a", "0.0.0", "150926", available=False)]
        kind, info = update_check_summary(peers, "0.0.0", "140926")
        self.assertEqual(kind, "newer_unavailable")
        self.assertEqual(info["peerId"], "a")


    def test_unsigned_update_is_allowed_when_signature_is_optional(self):
        peers = [
            _peer("unsigned", "0.0.0", "160926", signature_verified=False, signature_required=False),
            _peer("other", "0.0.0", "170926", trusted_source=False),
        ]
        best = best_available_update(peers, "0.0.0", "120926")
        self.assertEqual(best["peerId"], "unsigned")

    def test_signature_gate_still_works_when_enabled(self):
        peers = [
            _peer("unsigned", "0.0.0", "160926", signature_verified=False, signature_required=True),
            _peer("signed", "0.0.0", "150926", signature_verified=True, signature_required=True),
        ]
        best = best_available_update(peers, "0.0.0", "120926")
        self.assertEqual(best["peerId"], "signed")

    def test_summary_explains_unverified_when_signature_is_required(self):
        peers = [_peer(
            "unsigned", "0.0.0", "150926",
            signature_verified=False, signature_required=True,
        )]
        kind, info = update_check_summary(peers, "0.0.0", "140926")
        self.assertEqual(kind, "unverified")
        self.assertEqual(info["peerId"], "unsigned")

    def test_gui_requests_best_source_not_only_selected_peer(self):
        path = os.path.join(ROOT, "gui", "main_window.py")
        with open(path, encoding="utf-8") as fh:
            src = fh.read()
        self.assertIn("best_available_update", src)
        self.assertIn("self._update_source_peer_id", src)
        self.assertNotIn("def _selected_update", src)

    def test_unsigned_p2p_updates_are_enabled_for_frozen_builds(self):
        with open(os.path.join(ROOT, "app.py"), encoding="utf-8") as fh:
            app_src = fh.read()
        app_root = os.path.abspath(os.path.join(ROOT, "..", ".."))
        with open(os.path.join(app_root, "packages", "core", "src", "portable", "peers.ts"), encoding="utf-8") as fh:
            peers_src = fh.read()
        with open(os.path.join(app_root, "packages", "core", "src", "portable", "update-signature.ts"), encoding="utf-8") as fh:
            signature_src = fh.read()
        with open(os.path.join(app_root, "scripts", "build-portable-win.ps1"), encoding="utf-8") as fh:
            build_src = fh.read()
        self.assertIn('ALLOW_UNSIGNED_UPDATE", True', app_src)
        self.assertIn('if allow_unsigned_update() or signature:', app_src)
        self.assertIn('payload.get("signatureRequired") is True', app_src)
        self.assertIn("rememberedPeer?.isMine", peers_src)
        self.assertIn("this._updateSignatureRequired && !info.signatureVerified", peers_src)
        self.assertIn("!!normalizeUpdatePublicKey(publicKeyHex) && !allowUnsignedDevelopment", signature_src)
        self.assertIn("ALLOW_UNSIGNED_UPDATE = True", build_src)
        self.assertIn("unsigned P2P update mode enabled", build_src)
        self.assertNotIn("sign-portable-update.mjs", build_src)
        self.assertNotIn("UPDATE_SIGNING_SEED must", build_src)
        self.assertNotIn("PEERSYNC_ALLOW_UNSIGNED_UPDATE is not supported", build_src)



class ApplyUpdateLifecycleTests(unittest.TestCase):
    def test_integrity_failure_after_parent_exit_restarts_existing_launcher(self):
        with tempfile.TemporaryDirectory() as tmp:
            current = os.path.join(tmp, "PSN.exe")
            staged = os.path.join(tmp, "PSN.next.exe")
            with open(current, "wb") as fh:
                fh.write(b"old-launcher")
            with open(staged, "wb") as fh:
                fh.write(b"bad-new-launcher")

            args = [
                "updater",
                "--apply-update",
                "123",
                current,
                staged,
                str(len(b"expected")),
                hashlib.sha256(b"expected").hexdigest(),
            ]
            with mock.patch.object(updater_mod, "_wait_for_parent", return_value=None), \
                    mock.patch.object(updater_mod, "_updater_log"), \
                    mock.patch.object(updater_mod.subprocess, "Popen") as popen:
                self.assertEqual(updater_mod.apply_update_cli(args), 1)

            popen.assert_called_once()
            self.assertEqual(popen.call_args.args[0], [current])
            with open(current, "rb") as fh:
                self.assertEqual(fh.read(), b"old-launcher")



    def test_apply_installs_update_manifest_with_executable(self):
        with tempfile.TemporaryDirectory() as tmp:
            current = os.path.join(tmp, "PSN.exe")
            staging = os.path.join(tmp, "data", "update")
            os.makedirs(staging)
            staged = os.path.join(staging, "PSN.next.exe")
            staged_manifest = staged + ".update.json"
            with open(current, "wb") as fh:
                fh.write(b"old")
            with open(staged, "wb") as fh:
                fh.write(b"new")
            digest = hashlib.sha256(b"new").hexdigest()
            manifest = {
                "schema": "peersync-update-v1",
                "appVersion": "0.0.0.20260922",
                "buildLabel": "220926",
                "platform": "win-x64",
                "size": 3,
                "sha256": digest,
                "signature": "ab" * 64,
                "publicKey": "cd" * 32,
            }
            import json
            with open(staged_manifest, "w", encoding="utf-8") as fh:
                json.dump(manifest, fh)

            args = [
                "updater", "--apply-update", "123", current, staged,
                "3", digest, "", staged_manifest,
            ]
            with mock.patch.object(updater_mod, "_wait_for_parent", return_value=None), \
                    mock.patch.object(updater_mod, "_updater_log"), \
                    mock.patch.object(updater_mod, "arm_independent_recovery", return_value=True), \
                    mock.patch.object(updater_mod, "_start_verified_update"), \
                    mock.patch.object(updater_mod.subprocess, "Popen"):
                self.assertEqual(updater_mod.apply_update_cli(args), 0)

            with open(current, "rb") as fh:
                self.assertEqual(fh.read(), b"new")
            with open(current + ".update.json", encoding="utf-8") as fh:
                self.assertEqual(json.load(fh), manifest)

    def test_apply_unsigned_update_without_manifest(self):
        with tempfile.TemporaryDirectory() as tmp:
            current = os.path.join(tmp, "PSN.exe")
            current_manifest = current + ".update.json"
            staging = os.path.join(tmp, "data", "update")
            os.makedirs(staging)
            staged = os.path.join(staging, "PSN.next.exe")
            with open(current, "wb") as fh:
                fh.write(b"old")
            with open(current_manifest, "w", encoding="utf-8") as fh:
                fh.write("stale signed metadata")
            with open(staged, "wb") as fh:
                fh.write(b"new")
            digest = hashlib.sha256(b"new").hexdigest()

            args = [
                "updater", "--apply-update", "123", current, staged,
                "3", digest, "", "",
            ]
            with mock.patch.object(updater_mod, "_wait_for_parent", return_value=None), \
                    mock.patch.object(updater_mod, "_updater_log"), \
                    mock.patch.object(updater_mod, "arm_independent_recovery", return_value=True), \
                    mock.patch.object(updater_mod, "_start_verified_update"), \
                    mock.patch.object(updater_mod.subprocess, "Popen"):
                self.assertEqual(updater_mod.apply_update_cli(args), 0)

            with open(current, "rb") as fh:
                self.assertEqual(fh.read(), b"new")
            self.assertFalse(os.path.exists(current_manifest))

    def test_apply_rejects_target_that_is_not_the_parent_image(self):
        with tempfile.TemporaryDirectory() as tmp:
            current = os.path.join(tmp, "PSN.exe")
            requested = os.path.join(tmp, "other.exe")
            staging = os.path.join(tmp, "data", "update")
            os.makedirs(staging)
            staged = os.path.join(staging, "PSN.next.exe")
            for path, payload in ((current, b"old"), (requested, b"other"), (staged, b"new")):
                with open(path, "wb") as fh:
                    fh.write(payload)
            args = [
                "updater", "--apply-update", "123", requested, staged,
                str(len(b"new")), hashlib.sha256(b"new").hexdigest(),
            ]
            with mock.patch.object(updater_mod, "_wait_for_parent", return_value=current), \
                    mock.patch.object(updater_mod, "_updater_log"), \
                    mock.patch.object(updater_mod.subprocess, "Popen") as popen:
                self.assertEqual(updater_mod.apply_update_cli(args), 1)
            popen.assert_not_called()
            with open(current, "rb") as fh:
                self.assertEqual(fh.read(), b"old")
            with open(requested, "rb") as fh:
                self.assertEqual(fh.read(), b"other")

    def test_failed_rollback_never_moves_the_only_launcher_out_of_current(self):
        with tempfile.TemporaryDirectory() as tmp:
            current = os.path.join(tmp, "PSN.exe")
            staging = os.path.join(tmp, "data", "update")
            os.makedirs(staging)
            staged = os.path.join(staging, "PSN.next.exe")
            with open(current, "wb") as fh:
                fh.write(b"old")
            with open(staged, "wb") as fh:
                fh.write(b"new")
            digest = hashlib.sha256(b"new").hexdigest()
            import json
            with open(staged + ".update.json", "w", encoding="utf-8") as fh:
                json.dump({
                    "schema": "altersend-update-v1",
                    "appVersion": "0.0.0.20260922",
                    "buildLabel": "220926",
                    "platform": "win-x64",
                    "size": 3,
                    "sha256": digest,
                    "signature": "ab" * 64,
                    "publicKey": "cd" * 32,
                }, fh)

            real_replace = updater_mod._replace_retry
            def replace(source, target, attempts=25, delay=0.2):
                if source.endswith(".bak") and target == current:
                    raise OSError("simulated rollback failure")
                return real_replace(source, target, attempts=1, delay=0)

            args = [
                "updater", "--apply-update", "123", current, staged,
                str(len(b"new")), digest, "", staged + ".update.json",
            ]
            with mock.patch.object(updater_mod, "_wait_for_parent", return_value=None), \
                    mock.patch.object(updater_mod, "_updater_log"), \
                    mock.patch.object(updater_mod, "arm_independent_recovery", return_value=True), \
                    mock.patch.object(updater_mod, "_replace_retry", side_effect=replace), \
                    mock.patch.object(updater_mod.subprocess, "Popen", side_effect=OSError("launch failed")):
                self.assertEqual(updater_mod.apply_update_cli(args), 1)

            self.assertTrue(os.path.isfile(current))
            with open(current, "rb") as fh:
                self.assertEqual(fh.read(), b"new")


class UpdateUiShiftWiringTests(unittest.TestCase):
    def test_shift_click_uses_fast_update_path_and_restart_installer(self):
        with open(os.path.join(ROOT, "gui", "main_window.py"), encoding="utf-8") as fh:
            main = fh.read()
        with open(os.path.join(ROOT, "app.py"), encoding="utf-8") as fh:
            app = fh.read()

        request = main[main.index("    def _request_update(self):"):main.index("    def _selected_peer_name(self):")]
        self.assertIn("quick_restart = shift_is_down()", request)
        self.assertIn("if not quick_restart and not show_update_request(", request)
        self.assertIn("После установки PeerSync перезапустится", request)
        self.assertIn('ToolTip(self._update_btn, t("tip_update"))', main)

        # Both normal and Shift paths still converge on the hardened updater:
        # verify/stage first, then exit the old launcher so the helper can
        # atomically replace it and start the new executable.
        self.assertIn("launch_staged_update(", app)
        self.assertIn("win.post_ui(win.request_exit)", app)
        self.assertNotIn("root.after(50, win.request_exit)", app)

    def test_update_tooltip_documents_shift_behavior(self):
        from gui.i18n import t

        tip = t("tip_update")
        self.assertIn("Shift", tip)
        self.assertIn("перезапустить", tip)


class StagedUpdateBoundaryTests(unittest.TestCase):
    def test_rejects_symlink_escape_from_staging_directory(self):
        with tempfile.TemporaryDirectory() as tmp:
            data_root = os.path.join(tmp, "data")
            staging = os.path.join(data_root, "update")
            outside = os.path.join(tmp, "outside")
            os.makedirs(staging)
            os.makedirs(outside)
            payload = b"installer"
            outside_file = os.path.join(outside, "PSN.exe")
            with open(outside_file, "wb") as fh:
                fh.write(payload)
            link = os.path.join(staging, "escape")
            try:
                os.symlink(outside, link, target_is_directory=True)
            except (OSError, NotImplementedError) as exc:
                self.skipTest("directory symlink unavailable: %s" % exc)

            old_data_root = updater_mod.paths.data_root
            updater_mod.paths.data_root = lambda: data_root
            try:
                staged = os.path.join(link, "PSN.exe")
                with self.assertRaisesRegex(RuntimeError, "вне каталога staging"):
                    verify_staged_update(staged, len(payload), hashlib.sha256(payload).hexdigest())
            finally:
                updater_mod.paths.data_root = old_data_root


class CalendarValidationTests(unittest.TestCase):
    def test_impossible_dates_cannot_advertise_a_future_update(self):
        for label in ("310226", "290225", "000126", "n-310226"):
            with self.subTest(label=label):
                self.assertIsNone(parse_build_label(label))
                self.assertFalse(is_newer_release("9.0.0", label, "0.0.0", "031026"))
        self.assertEqual(parse_build_label("290224"), (2024, 2, 29))


if __name__ == "__main__":
    unittest.main()
