"""Explicit recovery UI for an interrupted overwrite finalize transaction."""

import tkinter as tk

from gui.components import AppButton, AppFrame, AppLabel
from gui.i18n import t


def show_finalize_recovery(parent, info):
    """Return keep-new / restore-backup / save-both, or None when dismissed."""
    result = {"action": None}
    dlg = tk.Toplevel(parent)
    dlg.title(t("recovery_title"))
    dlg.transient(parent)
    dlg.resizable(False, False)
    try:
        dlg.grab_set()
    except tk.TclError:
        pass

    body = AppFrame(dlg, surface="surface")
    body.pack(fill="both", expand=True, padx=18, pady=16)
    AppLabel(body, text=t("recovery_interrupted"), variant="surface_section").pack(anchor="w")
    AppLabel(
        body,
        text=t("recovery_hint"),
        variant="surface_muted",
        wraplength=560,
        justify="left",
    ).pack(anchor="w", pady=(6, 10))

    target = str((info or {}).get("targetPath") or "")
    backup = str((info or {}).get("backupPath") or "")
    AppLabel(body, text=t("recovery_current", path=target or "—"), variant="surface").pack(anchor="w")
    AppLabel(body, text=t("recovery_backup", path=backup or "—"), variant="surface").pack(anchor="w", pady=(2, 12))

    def choose(action):
        result["action"] = action
        dlg.destroy()

    buttons = AppFrame(body, surface="surface")
    buttons.pack(fill="x")
    AppButton(buttons, text=t("recovery_keep_new"), command=lambda: choose("keep-new")).pack(side="left")
    AppButton(buttons, text=t("recovery_restore_old"), command=lambda: choose("restore-backup")).pack(side="left", padx=(8, 0))
    AppButton(buttons, text=t("recovery_save_both"), command=lambda: choose("save-both")).pack(side="left", padx=(8, 0))
    AppButton(buttons, text=t("recovery_later"), command=dlg.destroy).pack(side="right")

    dlg.protocol("WM_DELETE_WINDOW", dlg.destroy)
    try:
        dlg.update_idletasks()
        x = parent.winfo_rootx() + max(0, (parent.winfo_width() - dlg.winfo_reqwidth()) // 2)
        y = parent.winfo_rooty() + max(0, (parent.winfo_height() - dlg.winfo_reqheight()) // 2)
        dlg.geometry("+%d+%d" % (x, y))
    except tk.TclError:
        pass
    parent.wait_window(dlg)
    return result["action"]
