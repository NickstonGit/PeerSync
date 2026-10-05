"""Side chat thread bound to the selected peer."""

import collections
import tkinter as tk

from gui.i18n import t, error_text
from gui import theme as ui_theme
from gui.components import (
    AppButton, AppFrame, AppLabel, AppEntry, AppCard, ToolTip, load_button_icon, load_icon,
)
from gui import design


CHAT_PAGE = 40
MAX_CHAT_SEEN_IDS = 8192
MAX_CHAT_HISTORY_MESSAGES = 5000
MAX_CHAT_TEXT_LINES = 12000


class BoundedIdSet:
    def __init__(self, limit):
        self.limit = max(1, int(limit))
        self._set = set()
        self._order = collections.deque()

    def __contains__(self, value):
        return value in self._set

    def add(self, value):
        if value in self._set:
            return
        self._set.add(value)
        self._order.append(value)
        while len(self._order) > self.limit:
            self._set.discard(self._order.popleft())

    def clear(self):
        self._set.clear()
        self._order.clear()


def should_draw_chat_message(seen_ids, msg):
    """Keep one bubble per Core messageId; events and send-ack share the id."""
    mid = str((msg or {}).get("messageId") or "")
    if not mid:
        return True
    if mid in seen_ids:
        return False
    seen_ids.add(mid)
    return True


def is_outgoing_chat(msg):
    return str((msg or {}).get("direction") or "in") == "out"


def chat_status_text(msg):
    state = str((msg or {}).get("state") or "")
    if state in ("queued", "queued-offline"):
        return t("chat_queued")
    if state == "failed":
        return t("chat_failed")
    return ""

class ChatPanel(AppCard):
    def __init__(self, parent, bridge, on_status=None, on_hide=None):
        super().__init__(parent)
        self.bridge = bridge
        self.on_status = on_status
        self.peer_id = None
        self._generation = 0
        self._compact_mode = False
        self._icon_images = {}
        self._seen_ids = BoundedIdSet(MAX_CHAT_SEEN_IDS)
        self._history_cursor = None
        self._history_loaded_count = 0
        self._shown_count = 0
        self._has_more = False
        self._loading_history = False

        self._caption = AppFrame(self, surface="surface")
        self._caption_icon = AppLabel(self._caption, variant="surface")
        self._caption_icon.pack(side="left", padx=(5, 4))
        AppLabel(self._caption, text=t("chat"), variant="surface_section").pack(side="left", padx=(0, 5))
        self.configure(labelwidget=self._caption)

        head = AppFrame(self, surface="surface")
        head.pack(fill="x", pady=(2, 6))
        self.peer_hint = AppLabel(head, text=t("chat_no_peer"), variant="surface_muted")
        self.peer_hint.pack(side="left", fill="x", expand=True)
        self._hide_btn = None
        if on_hide:
            self._hide_btn = AppButton(head, text="", variant="icon", width=3, command=on_hide)
            ToolTip(self._hide_btn, "Вернуться к файлам")

        self.footer = AppFrame(self, surface="surface")
        self.footer.pack(side="bottom", fill="x", pady=(7, 2))
        self.entry = AppEntry(self.footer, state="disabled")
        self.entry.pack(side="left", fill="x", expand=True)
        self.entry.bind("<Return>", self._send)
        self.send_btn = AppButton(
            self.footer,
            text=t("send"),
            variant="primary",
            compound="left",
            command=self._send,
            state="disabled",
        )
        self.send_btn.pack(side="right", padx=(6, 0))

        self._more_btn = AppButton(
            self,
            text=t("chat_more"),
            compact=True,
            command=self._load_older,
        )

        self.text = tk.Text(
            self,
            wrap="word",
            height=12,
            width=1,
            relief="flat",
            borderwidth=0,
            background=ui_theme.color("FIELD"),
            foreground=ui_theme.color("INK"),
            insertbackground=ui_theme.color("INK"),
            highlightthickness=1,
            highlightbackground=ui_theme.color("BORDER"),
            highlightcolor=ui_theme.color("BORDER"),
            takefocus=0,
            padx=10,
            pady=8,
            font=design.UI_FONT,
            spacing1=2,
            spacing3=2,
        )
        self.text.pack(fill="both", expand=True)
        self._configure_message_tags()
        self.text.bind("<Key>", self._readonly_key)
        self.text.bind("<<Paste>>", lambda _e: "break")
        self.apply_theme(ui_theme.is_dark_theme(self.winfo_toplevel()))

    def apply_theme(self, dark=False):
        try:
            self.text.configure(
                background=ui_theme.color("FIELD"),
                foreground=ui_theme.color("INK"),
                insertbackground=ui_theme.color("INK"),
                highlightbackground=ui_theme.color("BORDER"),
                highlightcolor=ui_theme.color("BORDER"),
            )
            self._configure_message_tags()
            chat_icon = load_icon(self, "chat", dark=bool(dark))
            self._icon_images["chat"] = chat_icon
            self._caption_icon.configure(image=chat_icon)
            if self._hide_btn is not None:
                back_normal, back_disabled, back_spec = load_button_icon(self, "chevron_left", dark=bool(dark))
                self._icon_images["back"] = (back_normal, back_disabled)
                self._hide_btn.configure(image=back_spec, text="")
            send_normal, send_disabled, send_spec = load_button_icon(self, "send", dark=bool(dark))
            self._icon_images["send"] = (send_normal, send_disabled)
            self.send_btn.configure(image=send_spec, compound="left")
        except (tk.TclError, OSError):
            pass

    def _sync_more_button(self):
        try:
            managed = bool(self._more_btn.winfo_manager())
            if self._has_more and self.peer_id:
                if not managed:
                    self._more_btn.pack(fill="x", pady=(0, 4), before=self.text)
                self._more_btn.configure(state="disabled" if self._loading_history else "normal")
            elif managed:
                self._more_btn.pack_forget()
        except tk.TclError:
            pass

    def _configure_message_tags(self):
        ink = ui_theme.color("INK")
        muted = ui_theme.color("MUTED")
        accent = ui_theme.color("ACCENT")
        danger = ui_theme.color("DANGER")
        self.text.tag_configure(
            "in",
            foreground=ink,
            font=design.UI_FONT,
            justify="left",
            lmargin1=2,
            lmargin2=8,
            rmargin=56,
            spacing1=5,
            spacing3=6,
        )
        self.text.tag_configure(
            "out",
            foreground=accent,
            font=design.UI_FONT,
            justify="right",
            lmargin1=56,
            lmargin2=56,
            rmargin=2,
            spacing1=5,
            spacing3=6,
        )
        self.text.tag_configure(
            "in_meta",
            foreground=muted,
            font=design.TINY_FONT,
            justify="left",
            lmargin1=2,
            rmargin=56,
            spacing3=4,
        )
        self.text.tag_configure(
            "out_meta",
            foreground=muted,
            font=design.TINY_FONT,
            justify="right",
            lmargin1=56,
            rmargin=2,
            spacing3=4,
        )
        self.text.tag_configure(
            "in_fail",
            foreground=danger,
            font=design.TINY_FONT,
            justify="left",
            lmargin1=2,
            rmargin=56,
            spacing3=4,
        )
        self.text.tag_configure(
            "out_fail",
            foreground=danger,
            font=design.TINY_FONT,
            justify="right",
            lmargin1=56,
            rmargin=2,
            spacing3=4,
        )

    def set_compact_mode(self, compact):
        """In narrow mode chat replaces file panes, so a back action is required."""
        self._compact_mode = bool(compact)
        if self._hide_btn is None:
            return
        try:
            managed = bool(self._hide_btn.winfo_manager())
            if self._compact_mode and not managed:
                self._hide_btn.pack(side="right", padx=(7, 0))
            elif not self._compact_mode and managed:
                self._hide_btn.pack_forget()
        except tk.TclError:
            pass

    def set_peer(self, peer_id, name=None):
        changed = peer_id != self.peer_id
        self.peer_id = peer_id
        if not peer_id:
            if changed:
                self._generation += 1
                self._seen_ids.clear()
                self._history_cursor = None
                self._history_loaded_count = 0
                self._shown_count = 0
                self._has_more = False
                self._loading_history = False
            self.peer_hint.configure(text=t("chat_no_peer"))
            self.entry.configure(state="disabled")
            self.send_btn.configure(state="disabled")
            self._set_body("")
            self._sync_more_button()
            return
        peer_label = name or peer_id[:12]
        self.peer_hint.configure(text=peer_label)
        self.entry.configure(state="normal")
        self.send_btn.configure(state="normal")
        if not changed:
            return
        self._generation += 1
        self._seen_ids.clear()
        self._history_cursor = None
        self._history_loaded_count = 0
        self._shown_count = 0
        self._has_more = False
        self._loading_history = False
        self._set_body("")
        self._sync_more_button()
        self._request_history(None, stick_bottom=True, replace=True)

    def _load_older(self):
        if not self.peer_id or self._loading_history or not self._has_more:
            return
        if self._history_loaded_count >= MAX_CHAT_HISTORY_MESSAGES or not self._history_cursor:
            self._has_more = False
            self._sync_more_button()
            return
        self._request_history(self._history_cursor, stick_bottom=False, replace=False)

    def reload_history(self):
        """Reconcile the visible chat from Core after a bounded UI queue overflow."""
        if not self.peer_id or self._loading_history:
            return
        self._history_cursor = None
        self._history_loaded_count = 0
        self._request_history(None, stick_bottom=True, replace=True)

    def _request_history(self, cursor, stick_bottom, replace):
        peer_id = self.peer_id
        generation = self._generation
        if not peer_id:
            return
        self._loading_history = True
        self._sync_more_button()
        payload = {"peerId": peer_id, "limit": CHAT_PAGE}
        if cursor:
            payload["before"] = cursor

        def ok(result):
            if generation != self._generation or self.peer_id != peer_id:
                return
            self._loading_history = False
            result = result or {}
            if result.get("staleCursor") and cursor:
                # The 5000-message retention window advanced past our cursor.
                # Reconcile from the current tail instead of silently duplicating
                # pages or pretending there is no history.
                self._history_cursor = None
                self._history_loaded_count = 0
                self._request_history(None, stick_bottom=True, replace=True)
                return
            messages = result.get("messages") or []
            if replace:
                self._set_history_page(messages, stick_bottom=stick_bottom)
            else:
                self._prepend_history_page(messages)
            self._history_cursor = result.get("nextCursor") or None
            self._has_more = bool(result.get("hasMore")) and bool(self._history_cursor)
            if self._history_loaded_count >= MAX_CHAT_HISTORY_MESSAGES:
                self._has_more = False
            self._sync_more_button()

        def err(error):
            if generation != self._generation or self.peer_id != peer_id:
                return
            self._loading_history = False
            self._sync_more_button()
            if self.on_status:
                self.on_status("Не удалось загрузить чат: %s" % error_text(error), "error")

        self.bridge.call(
            "chat.history",
            payload,
            on_ok=ok,
            on_err=err,
        )

    def would_draw(self, msg):
        incoming_peer = str((msg or {}).get("peerId") or "").lower()
        current_peer = str(self.peer_id or "").lower()
        if not msg or (incoming_peer and current_peer and incoming_peer != current_peer):
            return False
        mid = str((msg or {}).get("messageId") or "")
        if not mid:
            return True
        return mid not in self._seen_ids

    def append(self, msg):
        if not self.would_draw(msg):
            return False
        if not should_draw_chat_message(self._seen_ids, msg):
            return False
        self._write_line(msg)
        self._shown_count += 1
        self._trim_rendered_chat()
        self.text.see("end")
        return True

    def _trim_rendered_chat(self):
        try:
            line_count = int(str(self.text.index("end-1c")).split(".", 1)[0])
        except (tk.TclError, ValueError):
            return
        if line_count <= MAX_CHAT_TEXT_LINES:
            return
        cut_to = line_count - MAX_CHAT_TEXT_LINES + 1
        self.text.delete("1.0", "%d.0" % cut_to)
        self._shown_count = min(self._shown_count, MAX_CHAT_TEXT_LINES)

    def _readonly_key(self, event):
        ctrl = bool(event.state & 0x4)
        if ctrl and event.keysym.lower() in ("c", "a"):
            return None
        return "break"

    def _set_history_page(self, messages, stick_bottom):
        source = list(messages or [])[-MAX_CHAT_HISTORY_MESSAGES:]
        self._seen_ids.clear()
        self._set_body("")
        drawn = 0
        for message in source:
            if should_draw_chat_message(self._seen_ids, message):
                self._write_line(message)
                drawn += 1
        self._history_loaded_count = drawn
        self._shown_count = drawn
        if stick_bottom:
            self.text.see("end")
        else:
            self.text.see("1.0")

    def _prepend_history_page(self, messages):
        drawn = 0
        # Insert newest-to-oldest at index 1.0 so the resulting visual order is
        # still chronological (oldest at the top).
        for message in reversed(list(messages or [])):
            if should_draw_chat_message(self._seen_ids, message):
                self._prepend_line(message)
                drawn += 1
        self._history_loaded_count += drawn
        self._shown_count += drawn
        self.text.see("1.0")

    def _prepend_line(self, message):
        outgoing = is_outgoing_chat(message)
        body_tag = "out" if outgoing else "in"
        status = chat_status_text(message)
        if status:
            failed = str((message or {}).get("state") or "") == "failed"
            if failed:
                meta_tag = "out_fail" if outgoing else "in_fail"
            else:
                meta_tag = "out_meta" if outgoing else "in_meta"
            self.text.insert("1.0", "%s\n" % status, meta_tag)
        self.text.insert("1.0", "%s\n" % ((message or {}).get("text") or ""), body_tag)

    def _set_body(self, value):
        self.text.delete("1.0", "end")
        if value:
            self.text.insert("end", value)

    def _write_line(self, message):
        outgoing = is_outgoing_chat(message)
        body_tag = "out" if outgoing else "in"
        self.text.insert("end", "%s\n" % ((message or {}).get("text") or ""), body_tag)
        status = chat_status_text(message)
        if status:
            failed = str((message or {}).get("state") or "") == "failed"
            if failed:
                meta_tag = "out_fail" if outgoing else "in_fail"
            else:
                meta_tag = "out_meta" if outgoing else "in_meta"
            self.text.insert("end", "%s\n" % status, meta_tag)

    def _send(self, _evt=None):
        text = self.entry.get().strip()
        peer_id = self.peer_id
        generation = self._generation
        if not peer_id:
            if self.on_status:
                self.on_status(t("no_peer"), "warning")
            return "break"
        raw = text.encode("utf-8")
        if not raw:
            return "break"
        if len(raw) > 8192:
            if self.on_status:
                self.on_status(t("chat_too_long"), "warning")
            return "break"
        self.entry.delete(0, "end")

        def ok(result):
            if generation != self._generation or self.peer_id != peer_id:
                return
            self.append({
                "peerId": peer_id,
                "messageId": (result or {}).get("messageId"),
                "direction": "out",
                "text": text,
                "state": (result or {}).get("state"),
            })

        def err(error):
            if generation == self._generation and self.peer_id == peer_id and self.on_status:
                self.on_status("Не удалось отправить сообщение: %s" % error_text(error), "error")

        self.bridge.call(
            "chat.send",
            {"peerId": peer_id, "text": text},
            on_ok=ok,
            on_err=err,
        )
        return "break"
