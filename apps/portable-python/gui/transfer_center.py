"""Compact transfer status surface with optional operation details."""

import tkinter as tk

from gui.i18n import t
from gui.theme import DANGER, SUCCESS, WARNING
from gui.components import AppButton, AppFrame, AppLabel, AppCard, AppProgress, AppTree

_TERMINAL = {"done", "failed", "cancelled", "stale", "recovery-blocked"}


def _fmt_bytes(value):
    try:
        n = max(0, int(value or 0))
    except (TypeError, ValueError):
        n = 0
    units = ("B", "КБ", "МБ", "ГБ", "ТБ")
    amount = float(n)
    for unit in units:
        if amount < 1024.0 or unit == units[-1]:
            if unit == "B":
                return "%d %s" % (int(amount), unit)
            return "%.1f %s" % (amount, unit)
        amount /= 1024.0
    return "%d B" % n


class TransferCenter(AppCard):
    def __init__(self, parent, on_cancel=None):
        super().__init__(parent, title=t("transfers"), padding=(8, 5))
        self.on_cancel = on_cancel
        self._ops = {}
        self._details_visible = False
        self._current_id = None

        row = AppFrame(self, surface="surface")
        row.pack(fill="x")
        self.summary_var = tk.StringVar(value=t("transfer_none"))
        self.summary = AppLabel(row, textvariable=self.summary_var, variant="surface")
        self.summary.pack(side="left")

        self.toggle_btn = AppButton(row, text=t("details"), compact=True, command=self._toggle)
        self.toggle_btn.pack(side="right")
        self.cancel_btn = AppButton(row, text=t("cancel"), compact=True, command=self._cancel, state="disabled")
        self.cancel_btn.pack(side="right", padx=(0, 6))

        self.progress = AppProgress(self, orient="horizontal", mode="determinate", maximum=100)

        self.details = AppFrame(self, surface="surface")
        cols = ("file", "state", "progress")
        self.tree = AppTree(self.details, columns=cols, show="headings", height=4, selectmode="browse")
        self.tree.heading("file", text="Файл")
        self.tree.heading("state", text="Состояние")
        self.tree.heading("progress", text="Прогресс")
        self.tree.column("file", width=360, minwidth=120, stretch=True)
        self.tree.column("state", width=120, minwidth=90, stretch=False)
        self.tree.column("progress", width=140, minwidth=100, stretch=False)
        self.tree.pack(fill="both", expand=True, pady=(6, 0))
        self.tree.tag_configure("done", foreground=SUCCESS)
        self.tree.tag_configure("failed", foreground=DANGER)
        self.tree.tag_configure("stale", foreground=WARNING)
        self.tree.bind("<<TreeviewSelect>>", self._selection_changed)

    def update_state(self, payload):
        op_id = str(payload.get("operationId") or "")
        if not op_id:
            return
        row = self._ops.setdefault(op_id, {})
        row.update(payload)
        self._current_id = op_id
        self._render()

    def update_progress(self, payload):
        op_id = str(payload.get("operationId") or "")
        if not op_id:
            return
        row = self._ops.setdefault(op_id, {})
        row.update(payload)
        if not row.get("state"):
            row["state"] = "active"
        self._current_id = op_id
        self._render()

    def _state_text(self, state):
        mapping = {
            "queued": "В очереди",
            "active": "Передача",
            "waiting-peer": t("transfer_waiting"),
            "finalizing": "Завершение",
            "done": "Готово",
            "failed": "Ошибка",
            "cancelled": "Отменено",
            "cancel-pending": "Отмена…",
            "stale": "Изменён источник",
            "recovery-blocked": "Требуется действие",
        }
        return mapping.get(str(state or ""), str(state or ""))

    def _render(self):
        if self._ops:
            if not self.progress.winfo_manager():
                self.progress.pack(fill="x", pady=(5, 0))
        elif self.progress.winfo_manager():
            self.progress.pack_forget()
        active = []
        for op_id, row in self._ops.items():
            if str(row.get("state") or "") not in _TERMINAL:
                active.append((op_id, row))

        current = self._ops.get(self._current_id or "")
        if current is None and active:
            self._current_id, current = active[-1]
        if current is None and self._ops:
            self._current_id = next(reversed(self._ops))
            current = self._ops[self._current_id]

        if not self._ops:
            self.summary_var.set(t("transfer_none"))
            self.summary.configure(variant="surface")
            self.progress["value"] = 0
        elif active:
            row = current if current and str(current.get("state") or "") not in _TERMINAL else active[-1][1]
            name = row.get("relativePath") or "Передача файла"
            done = int(row.get("bytesDone") or 0)
            total = int(row.get("bytesTotal") or row.get("size") or 0)
            self.summary.configure(variant="surface")
            if total > 0:
                pct = min(100, max(0, int(done * 100 / total)))
                if pct >= 100 and str(row.get("state") or "") not in _TERMINAL and str(row.get("state") or "") != "finalizing":
                    pct = 99
                self.progress["value"] = pct
                self.summary_var.set("%s — %s / %s (%d%%)" % (name, _fmt_bytes(done), _fmt_bytes(total), pct))
            else:
                self.progress["value"] = 0
                self.summary_var.set("%s — %s" % (name, self._state_text(row.get("state"))))
        else:
            state = str((current or {}).get("state") or "")
            if state == "done":
                self.summary_var.set(t("transfer_done"))
                self.summary.configure(variant="surface_success")
                self.progress["value"] = 100
            elif state in ("failed", "stale", "recovery-blocked"):
                self.summary_var.set(t("transfer_failed"))
                self.summary.configure(variant="surface_error")
            else:
                self.summary_var.set(self._state_text(state) or t("transfer_none"))
                self.summary.configure(variant="surface")

        self.cancel_btn.configure(state="normal" if active and self._current_id else "disabled")
        self._render_tree()
        self._trim_terminal()

    def _row_tags(self, state):
        state = str(state or "")
        if state == "done":
            return ("done",)
        if state in ("failed", "stale", "recovery-blocked"):
            return ("failed",) if state in ("failed", "recovery-blocked") else ("stale",)
        return ()

    def _render_tree(self):
        existing = set(self.tree.get_children())
        for op_id, row in list(self._ops.items())[-200:]:
            name = row.get("relativePath") or op_id[:12]
            state = self._state_text(row.get("state"))
            done = int(row.get("bytesDone") or 0)
            total = int(row.get("bytesTotal") or row.get("size") or 0)
            progress = "%s / %s" % (_fmt_bytes(done), _fmt_bytes(total)) if total else ""
            values = (name, state, progress)
            tags = self._row_tags(row.get("state"))
            if op_id in existing:
                self.tree.item(op_id, values=values, tags=tags)
                existing.discard(op_id)
            else:
                self.tree.insert("", "end", iid=op_id, values=values, tags=tags)
        for iid in existing:
            self.tree.delete(iid)
        if self._current_id and self.tree.exists(self._current_id):
            self.tree.selection_set(self._current_id)

    def _trim_terminal(self):
        if len(self._ops) <= 240:
            return
        for op_id in list(self._ops):
            if len(self._ops) <= 180:
                break
            if str(self._ops[op_id].get("state") or "") in _TERMINAL:
                self._ops.pop(op_id, None)

    def _toggle(self):
        self._details_visible = not self._details_visible
        if self._details_visible:
            self.details.pack(fill="both", expand=True)
            self.toggle_btn.configure(text=t("hide_details"))
        else:
            self.details.pack_forget()
            self.toggle_btn.configure(text=t("details"))

    def _selection_changed(self, _evt=None):
        selection = self.tree.selection()
        if selection:
            self._current_id = selection[0]
            self._render()

    def _cancel(self):
        if self.on_cancel and self._current_id:
            self.on_cancel(self._current_id)
