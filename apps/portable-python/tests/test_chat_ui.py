import os
import unittest
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, ".."))
REPO_ROOT = os.path.abspath(os.path.join(ROOT, "..", ".."))
sys.path.insert(0, ROOT)

from gui.chat import (  # noqa: E402
    CHAT_PAGE,
    MAX_CHAT_HISTORY_MESSAGES,
    chat_status_text,
    is_outgoing_chat,
    should_draw_chat_message,
)


class ChatDedupeTests(unittest.TestCase):
    def test_same_message_id_is_drawn_once(self):
        seen = set()
        first = {"messageId": "m1", "text": "тест", "direction": "out"}
        second = {"messageId": "m1", "text": "тест", "direction": "out", "state": "delivered"}
        self.assertTrue(should_draw_chat_message(seen, first))
        self.assertFalse(should_draw_chat_message(seen, second))
        self.assertTrue(should_draw_chat_message(seen, {"messageId": "m2", "text": "тест"}))

    def test_missing_id_is_not_dropped(self):
        seen = set()
        self.assertTrue(should_draw_chat_message(seen, {"text": "тест", "direction": "out"}))
        self.assertTrue(should_draw_chat_message(seen, {"text": "тест", "direction": "out"}))


class ChatBubbleLayoutTests(unittest.TestCase):
    def test_outgoing_and_incoming_are_opposite_sides(self):
        self.assertTrue(is_outgoing_chat({"direction": "out"}))
        self.assertFalse(is_outgoing_chat({"direction": "in"}))
        self.assertFalse(is_outgoing_chat({}))

    def test_status_is_short_and_only_for_pending_or_failed(self):
        self.assertEqual(chat_status_text({"state": "delivered"}), "")
        self.assertEqual(chat_status_text({"state": "queued-offline"}), "очередь")
        self.assertEqual(chat_status_text({"state": "failed"}), "ошибка")

    def test_transcript_has_no_sender_captions(self):
        path = os.path.join(ROOT, "gui", "chat.py")
        with open(path, encoding="utf-8") as fh:
            chat = fh.read()
        self.assertNotIn("Устройство", chat)
        self.assertNotIn("удаленн", chat)
        self.assertNotIn("входящее", chat)
        self.assertNotIn("исходящее", chat)
        self.assertNotIn('who = "Вы"', chat)
        self.assertIn('justify="left"', chat)
        self.assertIn('justify="right"', chat)
        self.assertIn('"in",', chat)
        self.assertIn('"out",', chat)


class ChatHistoryWindowTests(unittest.TestCase):
    def test_history_uses_small_cursor_pages_across_full_store(self):
        self.assertEqual(CHAT_PAGE, 40)
        self.assertEqual(MAX_CHAT_HISTORY_MESSAGES, 5000)

    def test_history_request_uses_cursor_not_cumulative_tail(self):
        path = os.path.join(ROOT, "gui", "chat.py")
        with open(path, encoding="utf-8") as fh:
            chat = fh.read()
        self.assertIn('{"peerId": peer_id, "limit": CHAT_PAGE}', chat)
        self.assertIn('payload["before"] = cursor', chat)
        self.assertIn('self._history_cursor = result.get("nextCursor") or None', chat)
        self.assertIn('bool(result.get("hasMore"))', chat)
        self.assertNotIn('_history_limit', chat)
        self.assertIn("def _load_older(self):", chat)
        self.assertIn("def _sync_more_button(self):", chat)
        with open(os.path.join(ROOT, "gui", "i18n.py"), encoding="utf-8") as fh:
            strings = fh.read()
        self.assertIn('"chat_more": "ещё"', strings)


class ChatBadgeSourceTests(unittest.TestCase):
    def test_send_ack_keeps_message_id_for_event_dedupe(self):
        path = os.path.join(ROOT, "gui", "chat.py")
        with open(path, encoding="utf-8") as fh:
            chat = fh.read()
        self.assertIn('"messageId": (result or {}).get("messageId")', chat)
        self.assertIn("should_draw_chat_message(self._seen_ids, msg)", chat)

    def test_unread_dot_only_when_chat_is_collapsed(self):
        main_path = os.path.join(ROOT, "gui", "main_window.py")
        panel_path = os.path.join(ROOT, "gui", "panel.py")
        button_path = os.path.join(ROOT, "gui", "button.py")
        with open(main_path, encoding="utf-8") as fh:
            main = fh.read()
        with open(panel_path, encoding="utf-8") as fh:
            panel = fh.read()
        with open(button_path, encoding="utf-8") as fh:
            button = fh.read()
        self.assertIn("def _chat_is_visible(self):", main)
        self.assertIn("not self._chat_is_visible()", main)
        self.assertIn('get("direction") or "in") != "out"', main)
        self.assertIn("self.right.set_chat_unread(True)", main)
        self.assertIn("def set_chat_unread(self, unread):", panel)
        self.assertIn("bool(unread) and not self._chat_active", panel)
        self.assertIn("if self._chat_active:", panel)
        self.assertIn("self._chat_unread = False", panel)
        self.assertIn("def _sync_badge(self):", button)
        self.assertIn('tags="badge"', button)

    def test_unread_dot_is_painted_before_transcript_append(self):
        path = os.path.join(ROOT, "gui", "main_window.py")
        with open(path, encoding="utf-8") as fh:
            main = fh.read()
        handler = main[main.index("def _on_chat_message"): main.index("def _on_sync_progress")]
        self.assertLess(
            handler.index("self.right.set_chat_unread(True)"),
            handler.index("self.chat.append(payload)"),
        )
        self.assertIn("self._ui_tasks = queue.SimpleQueue()", main)
        self.assertIn("def post_ui(self, callback, *args, **kwargs):", main)
        self.assertIn("had_work = bool(self._drain_ui_tasks()) or had_work", main)
        self.assertNotIn("self._wake_chat_event()", main)
        self.assertIn("self._put_bounded_event(self._chat_events, queued, chat=True)", main)
        self.assertIn("queued = (owner, frame)", main)
        self.assertIn("def _handle_owned_event(self, queued):", main)
        self.assertIn("self.chat.would_draw(payload)", main)
        with open(os.path.join(ROOT, "gui", "chat.py"), encoding="utf-8") as fh:
            chat = fh.read()
        self.assertIn("def would_draw(self, msg):", chat)

    def test_core_emits_inbound_chat_before_disk_flush(self):
        chat_path = os.path.join(REPO_ROOT, "packages", "core", "src", "portable", "chat.ts")
        core_path = os.path.join(REPO_ROOT, "packages", "core", "src", "portable", "portable-core.ts")
        with open(chat_path, encoding="utf-8") as fh:
            chat = fh.read()
        with open(core_path, encoding="utf-8") as fh:
            core = fh.read()
        accepted = chat.index("onAccepted?.()")
        persist = chat.index("await this._appendEventUnlocked(key, { v: 1, type: 'message', message: msg })")
        self.assertLess(accepted, persist)
        self.assertIn("{ sync: false }", chat)
        self.assertIn("onAccepted?: () => void", chat)
        emit = core.index("this._emit('chat.message'")
        record = core.index("await this.chat.record(")
        self.assertGreater(emit, record)
        self.assertIn("() => this._emit('chat.message'", core)


if __name__ == "__main__":
    unittest.main()
