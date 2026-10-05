import os
import unittest
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, ".."))
REPO_ROOT = os.path.abspath(os.path.join(ROOT, "..", ".."))
sys.path.insert(0, ROOT)

from gui.i18n import error_code, error_text, is_offline_error, t  # noqa: E402
from gui.peer_alias import peer_device_name, peer_display_name, set_peer_alias  # noqa: E402
from gui.peer_refresh import PeerListRefresher  # noqa: E402
from gui.main_window import (  # noqa: E402
    MainWindow,
    apply_presence_to_peers,
    peer_row_label,
    should_reload_remote_roots,
)


class ErrorTextTests(unittest.TestCase):
    def test_offline_code_is_translated(self):
        self.assertEqual(error_code({"code": "OFFLINE", "message": "peer offline"}), "OFFLINE")
        self.assertEqual(error_text({"code": "OFFLINE", "message": "peer offline"}), "Устройство не в сети")
        self.assertTrue(is_offline_error({"code": "OFFLINE", "message": "peer offline"}))

    def test_nested_error_object(self):
        self.assertEqual(error_text({"error": {"code": "OFFLINE", "message": "peer offline"}}), "Устройство не в сети")

    def test_io_code_is_translated(self):
        self.assertEqual(error_text({"code": "IO", "message": "write stalled"}), "Ошибка файловой операции")

    def test_core_stopped_uses_status_copy(self):
        self.assertEqual(error_text({"code": "IO", "message": "core stopped"}), t("core_stopped"))

    def test_unknown_code_keeps_message(self):
        self.assertEqual(error_text({"code": "WEIRD", "message": "core exploded"}), "WEIRD core exploded")


class RemoteRootsReloadTests(unittest.TestCase):
    def test_duplicate_online_presence_does_not_reload(self):
        peer = {"id": "abc", "online": True}
        self.assertTrue(should_reload_remote_roots(None, False, peer))
        self.assertTrue(should_reload_remote_roots("abc", False, peer))
        self.assertFalse(should_reload_remote_roots("abc", True, peer))

    def test_peer_change_reloads(self):
        self.assertTrue(should_reload_remote_roots("aaa", True, {"id": "bbb", "online": True}))
        self.assertTrue(should_reload_remote_roots("aaa", False, {"id": "bbb", "online": False}))

    def test_going_offline_does_not_reload(self):
        self.assertFalse(should_reload_remote_roots("abc", True, {"id": "abc", "online": False}))

    def test_presence_updates_existing_peer_without_dropping_others(self):
        peers = [
            {"id": "aaa", "name": "A", "online": False},
            {"id": "bbb", "name": "B", "online": True},
        ]
        self.assertTrue(apply_presence_to_peers(peers, "AAA", True, "direct"))
        self.assertTrue(peers[0]["online"])
        self.assertEqual(peers[0]["connectionType"], "direct")
        self.assertTrue(peers[1]["online"])
        self.assertFalse(apply_presence_to_peers(peers, "missing", True))

    def test_peer_row_label_uses_live_status(self):
        self.assertIn(t("offline"), peer_row_label({"id": "abc", "name": "Кабинет", "online": False}))
        self.assertIn(t("online"), peer_row_label({"id": "abc", "name": "Кабинет", "online": True}))
        self.assertIn("Кабинет", peer_row_label({"id": "abc", "name": "RLMOS-0571", "online": True}, {"abc": "Кабинет"}))


class PeerStatusRefreshTests(unittest.TestCase):
    def test_periodic_refresh_is_single_flight_and_applies_current_snapshot(self):
        calls = []

        class Bridge:
            def call(self, method, payload=None, on_ok=None, on_err=None, timeout=60.0):
                calls.append((method, payload, on_ok, on_err, timeout))

        class Window:
            _core_ready = True
            _next_peer_refresh_at = 0.0
            _next_peer_poke_at = 0.0
            _peer_id = "abc"

            def __init__(self):
                self.bridge = Bridge()
                self.applied = None
                self._peer_refresher = PeerListRefresher(self._issue_peer_list)

            def _issue_peer_list(self, _stamp, _settle, on_ok, on_err):
                self.bridge.call("peer.list", {}, on_ok=on_ok, on_err=on_err, timeout=15.0)

            def _apply_peers(self, result):
                self.applied = result
                self.peers = (result or {}).get("peers") or []

            def _peer_online(self, peer_id):
                return any(peer.get("id") == peer_id and peer.get("online") for peer in self.peers)

            def _poke_selected_peer(self):
                MainWindow._poke_selected_peer(self)

            def _request_peers(self, poke_selected=False):
                def on_ok(result):
                    self._apply_peers(result)
                    if poke_selected and self._peer_id and not self._peer_online(self._peer_id):
                        self._poke_selected_peer()

                def on_err(_error):
                    pass

                return self._peer_refresher.request(on_ok=on_ok, on_err=on_err)

        window = Window()
        MainWindow._poll_peer_status(window)
        MainWindow._poll_peer_status(window)

        self.assertEqual(len(calls), 1)
        method, payload, _on_ok, _on_err, timeout = calls[0]
        self.assertEqual(method, "peer.list")
        self.assertEqual(payload, {})
        self.assertEqual(timeout, 15.0)
        self.assertTrue(window._peer_refresher.inflight)

        snapshot = {"peers": [{"id": "abc", "online": False}]}
        calls[0][2](snapshot)
        self.assertEqual(window.applied, snapshot)
        self.assertIn("peer.poke", [call[0] for call in calls])
        self.assertFalse(window._peer_refresher.inflight)

        calls[0][3](RuntimeError("offline"))
        self.assertFalse(window._peer_refresher.inflight)


    def test_core_loss_marks_saved_peers_offline(self):
        class Right:
            def __init__(self):
                self.roots = [{"rootId": "remote"}]

            def set_roots(self, roots):
                self.roots = roots

        class Window:
            _peers_stamp = 0
            _next_peer_refresh_at = 10.0
            _remote_roots_generation = 0

            def __init__(self):
                self.peers = [{"id": "abc", "online": True, "connectionType": "direct"}]
                self.right = Right()
                self.refreshed = False
                self._peer_refresher = PeerListRefresher(lambda *_a, **_k: None)
                # Start from a settled refresher, then make one in flight.
                self._peer_refresher._inflight = True

            def _cancel_remote_roots_retry(self):
                pass

            def _refresh_peer_box(self):
                self.refreshed = True

        window = Window()
        MainWindow._set_peers_offline(window)

        self.assertFalse(window.peers[0]["online"])
        self.assertIsNone(window.peers[0]["connectionType"])
        self.assertEqual(window.right.roots, [])
        self.assertEqual(window._peers_stamp, 1)
        self.assertFalse(window._peer_refresher.inflight)
        self.assertTrue(window.refreshed)


class PeerAliasTests(unittest.TestCase):
    def test_empty_alias_falls_back_to_computer_name(self):
        peer = {"id": "abc", "name": "RLMOS-0571"}
        self.assertEqual(peer_display_name(peer), "RLMOS-0571")
        self.assertEqual(peer_display_name(peer, {"abc": "Кабинет"}), "Кабинет")
        self.assertEqual(peer_device_name(peer), "RLMOS-0571")

    def test_clearing_or_repeating_computer_name_drops_alias(self):
        aliases = {"abc": "Кабинет"}
        self.assertEqual(set_peer_alias(aliases, "abc", "  ", device_name="RLMOS-0571"), {})
        self.assertEqual(set_peer_alias(aliases, "abc", "RLMOS-0571", device_name="RLMOS-0571"), {})
        self.assertEqual(set_peer_alias({}, "abc", "Кабинет", device_name="RLMOS-0571")["abc"], "Кабинет")

    def test_clearing_selection_reloads(self):
        self.assertTrue(should_reload_remote_roots("abc", True, None))
        self.assertFalse(should_reload_remote_roots(None, False, None))


class RemoteRootsSourceTests(unittest.TestCase):
    def _read(self, *parts):
        with open(os.path.join(ROOT, *parts), encoding="utf-8") as fh:
            return fh.read()

    def test_success_clears_stale_offline_status(self):
        main = self._read("gui", "main_window.py")
        self.assertIn("def _clear_transient_peer_status", main)
        self.assertIn("self._clear_transient_peer_status()", main)
        self.assertIn('t("remote_folders_failed")', main)
        self.assertIn('t("device_offline")', main)
        self.assertIn("REMOTE_ROOTS_RETRY_MS", main)
        self.assertIn("if not self._peer_online(peer_id)", main)
        self.assertIn("if self.right.roots:", main)
        self.assertIn("reload_roots=should_reload_remote_roots", main)
        # Stale-response rejection now lives in PeerListRefresher, which owns
        # the stamp and is covered by behavioural tests in test_peer_refresh.py.
        self.assertIn("from gui.peer_refresh import PeerListRefresher", main)
        self.assertIn("def _on_peer_presence(self, payload):", main)
        self.assertIn("apply_presence_to_peers(self.peers, peer_id, online, connection_type)", main)
        self.assertIn("self._require_selected_peer_online()", main)
        self.assertIn("peer_online = self._peer_online(self._peer_id)", main)
        self.assertIn("not self._sync_busy and not self._copy_busy and peer_online", main)
        self.assertNotIn(
            'self._note("Не удалось получить папки устройства: %s" % self._err_text(error), "error")',
            main,
        )

    def test_peer_status_reconciles_periodically(self):
        main = self._read("gui", "main_window.py")
        start = main.index("def _poll_peer_status")
        block = main[start : main.index("def _reload_peers", start)]
        self.assertIn("PEER_STATUS_REFRESH_SECONDS", block)
        # The RPC now lives in one shared issuer; the poll and the presence
        # handler both go through the coalescing refresher.
        self.assertIn("self._request_peers", block)
        self.assertIn('self.bridge.call("peer.list"', main)
        self.assertIn("def _issue_peer_list", main)
        self.assertIn("PeerListRefresher", main)
        self.assertIn("self._poll_peer_status()", main)
        # The poke is now conditional: only a poll or an explicit reload re-arms
        # the reconnect, a plain presence-driven refresh must not.
        self.assertIn("poke_selected and self._peer_id and not self._peer_online(self._peer_id)", main)
        self.assertIn("PEER_RECONNECT_POKE_SECONDS = 15.0", main)
        # Superseded responses are dropped inside the refresher, not by a
        # hand-rolled stamp comparison duplicated across two fetch paths.
        self.assertEqual(main.count('self.bridge.call("peer.list"'), 1)

    def test_listing_success_clears_load_failed(self):
        panel = self._read("gui", "panel.py")
        self.assertIn("def _begin_rename(self", panel)
        self.assertIn("on_rename_peer", panel)
        self.assertIn('self.on_status(t("status_ready"), "success")', panel)
        i18n = self._read("gui", "i18n.py")
        self.assertIn('"device_offline": "Устройство не в сети"', i18n)
        self.assertEqual(t("remote_folders_failed"), "Не удалось получить папки устройства")

    def test_core_replaces_live_session_before_closing_previous(self):
        path = os.path.join(REPO_ROOT, "packages", "core", "src", "portable", "peers.ts")
        with open(path, encoding="utf-8") as fh:
            src = fh.read()
        block = src[src.index("private _onPersistentConnection"): src.index("private _classifyConnection")]
        self.assertLess(
            block.index("this._sessions.set(remotePk, session)"),
            block.index("prev.socket.destroy()"),
        )
        self.assertLess(
            block.index("socket.on('close'"),
            block.index("this._sessions.set(remotePk, session)"),
        )
        self.assertGreater(
            block.index("this._onPresence(remotePk, true"),
            block.index("this._sessions.set(remotePk, session)"),
        )


if __name__ == "__main__":
    unittest.main()
