"""Purpose-built pairing and access dialogs for long security-sensitive values."""

import re
import tkinter as tk
from tkinter import filedialog, messagebox

from gui.i18n import t
from gui.copy_collision import collision_prompt
from gui import theme as ui_theme
from gui.theme import apply_window_chrome
from gui import design
from gui.components import (
    AppButton, AppFrame, AppLabel, AppEntry, AppCheckBox, AppDialogFrame,
)

_HEX64_RE = re.compile(r"(?i)(?<![0-9a-f])([0-9a-f]{64})(?![0-9a-f])")


def copy_text(widget, text):
    widget.clipboard_clear()
    widget.clipboard_append(text)
    widget.update_idletasks()


def _is_ctrl_paste(event):
    """Recognize Ctrl+V by physical VK as well as Tk keysym.

    On Windows with a Cyrillic keyboard layout the physical V key can arrive
    as Cyrillic_em, so a literal <Control-v> binding is not sufficient.
    """
    try:
        state = int(getattr(event, "state", 0) or 0)
    except (TypeError, ValueError):
        state = 0
    if not (state & 0x0004):
        return False
    try:
        keycode = int(getattr(event, "keycode", 0) or 0)
    except (TypeError, ValueError):
        keycode = 0
    keysym = str(getattr(event, "keysym", "") or "").lower()
    return keycode == 86 or keysym in {"v", "cyrillic_em"}


def _new_toplevel(parent, title, *, resizable=(False, False), minsize=None):
    dlg = tk.Toplevel(parent)
    try:
        dlg.attributes("-alpha", 0.0)
    except tk.TclError:
        pass
    dlg.withdraw()
    dlg.transient(parent)
    dlg.title(title)
    dlg.resizable(*resizable)
    if minsize is not None:
        dlg.minsize(*minsize)
    dlg.configure(background=ui_theme.color("SURFACE"))
    try:
        dlg.after_idle(lambda: apply_window_chrome(dlg))
    except tk.TclError:
        pass
    return dlg


def _center(parent, dlg):
    dlg.update_idletasks()
    px = parent.winfo_rootx()
    py = parent.winfo_rooty()
    pw = max(parent.winfo_width(), 1)
    ph = max(parent.winfo_height(), 1)
    dw = max(dlg.winfo_reqwidth(), 1)
    dh = max(dlg.winfo_reqheight(), 1)
    dlg.geometry("+%d+%d" % (px + max(0, (pw - dw) // 2), py + max(0, (ph - dh) // 2)))


def _modal(parent, dlg, focus=None):
    # Pair confirmation can legitimately open while the host's code dialog is
    # already running its nested wait_window().  Preserve/restore the previous
    # grab so the confirmation becomes the active modal without leaving the
    # underlying code dialog in a half-modal state afterwards.
    previous_grab = None
    try:
        previous_grab = parent.grab_current()
    except tk.TclError:
        previous_grab = None
    try:
        _center(parent, dlg)
        try:
            dlg.attributes("-alpha", 1.0)
        except tk.TclError:
            pass
        dlg.deiconify()
        dlg.lift()
        dlg.wait_visibility()
        dlg.grab_set()
        if focus is not None:
            focus.focus_set()
        dlg.wait_window()
    finally:
        # A TclError during visibility/focus/wait must never leave a global
        # grab attached to a half-created dialog.
        try:
            if dlg.winfo_exists():
                dlg.grab_release()
                dlg.destroy()
        except tk.TclError:
            pass
        if previous_grab is not None:
            try:
                if previous_grab.winfo_exists():
                    previous_grab.grab_set()
            except tk.TclError:
                pass


def _code_entry(parent, textvariable, readonly=False):
    # AppEntry keeps code-field padding and typography in the shared UI kit.  This keeps the
    # caret/text away from the border without increasing the control height.
    entry = AppEntry(parent, textvariable=textvariable, variant="code")
    if readonly:
        entry.configure(state="readonly")
    return entry


def show_pair_code(parent, code):
    dlg = _new_toplevel(
        parent,
        "PeerSync — " + t("pair_code"),
        resizable=(True, False),
        minsize=(580, 0),
    )

    frm = AppDialogFrame(dlg)
    frm.pack(fill="both", expand=True)
    AppLabel(frm, text=t("pair_code"), variant="dialog_title").pack(anchor="w")
    AppLabel(frm, text=t("pair_code_hint"), variant="dialog", wraplength=610).pack(anchor="w", pady=(2, 6))

    var = tk.StringVar(value=code)
    entry = _code_entry(frm, var, readonly=True)
    entry.pack(fill="x", pady=(0, 7))

    btns = AppFrame(frm, surface="dialog")
    btns.pack(fill="x")
    copy_btn = AppButton(btns, text=t("copy_code"), variant="primary")
    copy_btn.pack(side="left")
    close_btn = AppButton(btns, text=t("close"))
    close_btn.pack(side="right")

    reset_after = {"id": None}

    def close_dialog(_evt=None):
        if reset_after["id"] is not None:
            try:
                dlg.after_cancel(reset_after["id"])
            except tk.TclError:
                pass
        dlg.destroy()

    def restore_copy_label():
        reset_after["id"] = None
        try:
            copy_btn.configure(text=t("copy_code"))
        except tk.TclError:
            pass

    def copy_code(_evt=None):
        copy_text(parent, code)
        copy_btn.configure(text=t("copied"))
        if reset_after["id"] is not None:
            dlg.after_cancel(reset_after["id"])
        reset_after["id"] = dlg.after(1500, restore_copy_label)
        return "break"

    copy_btn.configure(command=copy_code)
    close_btn.configure(command=close_dialog)
    dlg.protocol("WM_DELETE_WINDOW", close_dialog)
    dlg.bind("<Escape>", close_dialog)
    dlg.bind("<Return>", copy_code)
    entry.bind("<Control-c>", copy_code)
    entry.bind("<Control-C>", copy_code)
    entry.bind("<1>", lambda _e: entry.focus_set())
    entry.selection_range(0, tk.END)
    _modal(parent, dlg, entry)


def normalize_pair_code(value):
    text = str(value or "").strip()
    match = _HEX64_RE.search(text)
    if match:
        return match.group(1).lower()
    compact = re.sub(r"[\s-]+", "", text)
    if re.fullmatch(r"(?i)[0-9a-f]{64}", compact or ""):
        return compact.lower()
    return ""


def show_pair_join(parent):
    result = {"code": None}
    dlg = _new_toplevel(
        parent,
        "PeerSync — " + t("join_code"),
        resizable=(True, False),
        minsize=(580, 0),
    )

    frm = AppDialogFrame(dlg)
    frm.pack(fill="both", expand=True)
    AppLabel(frm, text=t("join_code"), variant="dialog_title").pack(anchor="w")
    AppLabel(frm, text=t("join_code_hint"), variant="dialog", wraplength=610).pack(anchor="w", pady=(2, 6))

    value = tk.StringVar()
    entry = _code_entry(frm, value)
    entry.pack(fill="x")

    state_var = tk.StringVar(value=t("pair_code_invalid"))
    state_label = AppLabel(frm, textvariable=state_var, variant="dialog_hint_error")
    state_label.pack(anchor="w", pady=(3, 8))

    btns = AppFrame(frm, surface="dialog")
    btns.pack(fill="x")
    paste_btn = AppButton(btns, text=t("paste"))
    paste_btn.pack(side="left")
    cancel_btn = AppButton(btns, text=t("close"))
    cancel_btn.pack(side="right")
    join_btn = AppButton(btns, text=t("join_now"), variant="primary", state="disabled")
    join_btn.pack(side="right", padx=(0, 7))

    def validate(*_args):
        code = normalize_pair_code(value.get())
        if code:
            state_var.set(t("pair_code_valid"))
            state_label.configure(variant="dialog_hint_success")
            join_btn.configure(state="normal")
        else:
            state_var.set(t("pair_code_invalid"))
            state_label.configure(variant="dialog_hint_error")
            join_btn.configure(state="disabled")
        return code

    def paste(_evt=None):
        try:
            text = parent.clipboard_get()
        except tk.TclError:
            text = ""
        entry.delete(0, tk.END)
        entry.insert(0, text)
        validate()
        entry.icursor(tk.END)
        return "break"

    def accept(_evt=None):
        code = validate()
        if not code:
            return "break"
        result["code"] = code
        dlg.destroy()
        return "break"

    def cancel(_evt=None):
        dlg.destroy()
        return "break"

    value.trace_add("write", validate)
    paste_btn.configure(command=paste)
    join_btn.configure(command=accept)
    cancel_btn.configure(command=cancel)
    dlg.protocol("WM_DELETE_WINDOW", cancel)
    dlg.bind("<Escape>", cancel)
    dlg.bind("<Return>", accept)
    def keyboard_paste(event):
        if _is_ctrl_paste(event):
            return paste(event)
        return None

    # Generic Ctrl+KeyPress is deliberate: it works with both Latin and
    # Cyrillic keyboard layouts on Windows (physical V keeps VK code 86).
    entry.bind("<Control-KeyPress>", keyboard_paste)
    entry.bind("<Shift-Insert>", paste)
    entry.bind("<<Paste>>", paste)
    _modal(parent, dlg, entry)
    return result["code"]


def show_pair_request(parent, name, device_type, fingerprint, timeout_ms=60_000):
    """Return (accepted, mine) or (False, False) on close/decline/timeout."""
    result = {"accepted": False, "mine": False}
    dlg = _new_toplevel(parent, "PeerSync — " + t("pair_request"))

    frm = AppDialogFrame(dlg)
    frm.pack(fill="both", expand=True)
    AppLabel(frm, text=t("pair_request"), variant="dialog_title").pack(anchor="w")
    AppLabel(frm, text=t("pair_request_hint"), variant="dialog", wraplength=500).pack(anchor="w", pady=(2, 7))

    details = AppFrame(frm, surface="dialog")
    details.pack(fill="x", pady=(0, 7))
    rows = [
        (t("device_name"), name or "—"),
        (t("device_type"), device_type or "—"),
        (t("fingerprint"), fingerprint or "—"),
    ]
    for row, (label, value) in enumerate(rows):
        AppLabel(details, text=label + ":", variant="dialog_muted").grid(
            row=row, column=0, sticky="w", padx=(0, 10), pady=2
        )
        value_kwargs = {"font": design.MONO_SMALL_FONT} if row == 2 else {}
        AppLabel(
            details,
            text=value,
            variant="dialog",
            **value_kwargs,
        ).grid(row=row, column=1, sticky="w", pady=2)

    mine_var = tk.BooleanVar(value=False)
    AppCheckBox(frm, text=t("mine"), variable=mine_var).pack(anchor="w", pady=(0, 7))

    btns = AppFrame(frm, surface="dialog")
    btns.pack(fill="x")

    timeout_after = {"id": None}

    def close_dialog():
        if timeout_after["id"] is not None:
            try:
                dlg.after_cancel(timeout_after["id"])
            except tk.TclError:
                pass
            timeout_after["id"] = None
        dlg.destroy()

    def decline(_evt=None):
        close_dialog()
        return "break"

    def accept(_evt=None):
        result["accepted"] = True
        result["mine"] = bool(mine_var.get())
        close_dialog()
        return "break"

    if timeout_ms and int(timeout_ms) > 0:
        timeout_after["id"] = dlg.after(int(timeout_ms), decline)

    AppButton(btns, text=t("decline"), command=decline).pack(side="left")
    accept_btn = AppButton(btns, text=t("accept"), variant="primary", command=accept)
    accept_btn.pack(side="right")
    dlg.protocol("WM_DELETE_WINDOW", decline)
    dlg.bind("<Escape>", decline)
    dlg.bind("<Return>", accept)
    _modal(parent, dlg, accept_btn)
    return result["accepted"], result["mine"]


def show_update_request(
    parent, peer_name, version, sha256, signature_verified=False, signature_required=False
):
    """Confirm an update source; release signatures are optional in compatibility mode."""
    result = {"accepted": False}
    dlg = _new_toplevel(parent, "PeerSync — Обновление")
    frm = AppDialogFrame(dlg)
    frm.pack(fill="both", expand=True)
    AppLabel(frm, text="Обновление PeerSync", variant="dialog_title").pack(anchor="w")
    if signature_required:
        intro = "Исполняемый файл будет получен с вашего доверенного устройства и проверен по подписи релиза."
        signature_text = "проверена" if signature_verified else "НЕ ПРОВЕРЕНА"
    else:
        intro = "Исполняемый файл будет получен с вашего доверенного устройства и проверен по размеру и SHA-256."
        signature_text = "проверена (не обязательна)" if signature_verified else "не используется"
    AppLabel(
        frm,
        text=intro,
        variant="dialog",
        wraplength=540,
    ).pack(anchor="w", pady=(2, 8))

    details = AppFrame(frm, surface="dialog")
    details.pack(fill="x", pady=(0, 8))
    rows = [
        ("Источник", peer_name or "—"),
        ("Версия", version or "—"),
        ("SHA-256", sha256 or "—"),
        ("Подпись", signature_text),
    ]
    for row, (label, value) in enumerate(rows):
        AppLabel(details, text=label + ":", variant="dialog_muted").grid(
            row=row, column=0, sticky="nw", padx=(0, 10), pady=2
        )
        AppLabel(
            details,
            text=value,
            variant="dialog",
            wraplength=430,
            **({"font": design.MONO_SMALL_FONT} if row == 2 else {}),
        ).grid(row=row, column=1, sticky="w", pady=2)

    btns = AppFrame(frm, surface="dialog")
    btns.pack(fill="x")

    def cancel(_evt=None):
        dlg.destroy()
        return "break"

    def accept(_evt=None):
        if signature_required and not signature_verified:
            return "break"
        result["accepted"] = True
        dlg.destroy()
        return "break"

    AppButton(btns, text=t("close"), command=cancel).pack(side="left")
    accept_btn = AppButton(
        btns,
        text="Скачать и установить",
        variant="primary",
        state="normal" if (signature_verified or not signature_required) else "disabled",
        command=accept,
    )
    accept_btn.pack(side="right")
    dlg.protocol("WM_DELETE_WINDOW", cancel)
    dlg.bind("<Escape>", cancel)
    dlg.bind("<Return>", accept)
    _modal(parent, dlg, accept_btn)
    return result["accepted"]


def show_root_access(parent, peer_name, current_write=False):
    result = {"saved": False, "write": bool(current_write)}
    dlg = _new_toplevel(parent, "PeerSync — " + t("access_title"))

    frm = AppDialogFrame(dlg)
    frm.pack(fill="both", expand=True)
    AppLabel(frm, text=t("access_title"), variant="dialog_title").pack(anchor="w")
    AppLabel(frm, text=t("access_intro"), variant="dialog", wraplength=520).pack(anchor="w", pady=(2, 6))
    AppLabel(frm, text=t("access_peer", peer=peer_name or "—"), variant="dialog_section").pack(anchor="w", pady=(0, 7))

    write_var = tk.BooleanVar(value=bool(current_write))
    AppCheckBox(frm, text=t("allow_write"), variable=write_var).pack(anchor="w")
    AppLabel(frm, text=t("allow_write_hint"), wraplength=500, variant="dialog_muted").pack(anchor="w", pady=(2, 8))

    btns = AppFrame(frm, surface="dialog")
    btns.pack(fill="x")

    def cancel(_evt=None):
        dlg.destroy()
        return "break"

    def save(_evt=None):
        result["saved"] = True
        result["write"] = bool(write_var.get())
        dlg.destroy()
        return "break"

    AppButton(btns, text=t("close"), command=cancel).pack(side="left")
    save_btn = AppButton(btns, text=t("save"), variant="primary", command=save)
    save_btn.pack(side="right")
    dlg.protocol("WM_DELETE_WINDOW", cancel)
    dlg.bind("<Escape>", cancel)
    dlg.bind("<Return>", save)
    _modal(parent, dlg, save_btn)
    if not result["saved"]:
        return None
    return result["write"]


def _folder_basename(path):
    cleaned = (path or "").replace("/", "\\").rstrip("\\")
    if not cleaned:
        return ""
    return cleaned.rsplit("\\", 1)[-1]


ROOT_NAME_MAX_LEN = 256


def _utf16_units(value):
    return len((value or "").encode("utf-16-le")) // 2


def show_add_folder(parent):
    """Return ``{"path", "name"}`` or ``None`` if the user cancelled."""
    result = {"ok": False, "path": "", "name": ""}
    dlg = _new_toplevel(
        parent,
        "PeerSync — " + t("add_folder_title"),
        resizable=(True, False),
        minsize=(520, 0),
    )

    frm = AppDialogFrame(dlg)
    frm.pack(fill="both", expand=True)
    AppLabel(frm, text=t("add_folder_title"), variant="dialog_title").pack(anchor="w")
    AppLabel(frm, text=t("add_folder_hint"), variant="dialog", wraplength=520).pack(anchor="w", pady=(2, 8))

    path_var = tk.StringVar()
    name_var = tk.StringVar()
    auto_name = [""]

    AppLabel(frm, text=t("folder_path") + ":", variant="dialog_muted").pack(anchor="w")
    path_row = AppFrame(frm, surface="dialog")
    path_row.pack(fill="x", pady=(1, 7))
    path_row.columnconfigure(0, weight=1)
    path_entry = AppEntry(path_row, textvariable=path_var, state="readonly")
    path_entry.grid(row=0, column=0, sticky="ew")

    def apply_path(chosen):
        native = (chosen or "").replace("/", "\\")
        if not native:
            return
        path_var.set(native)
        base = _folder_basename(native)
        current = name_var.get().strip()
        if not current or current == auto_name[0]:
            name_var.set(base)
            auto_name[0] = base
        add_btn.configure(state="normal")

    def browse(_evt=None):
        chosen = filedialog.askdirectory(parent=dlg)
        if chosen:
            apply_path(chosen)
        return "break"

    AppButton(path_row, text=t("browse"), compact=True, command=browse).grid(
        row=0, column=1, sticky="e", padx=(6, 0)
    )

    AppLabel(frm, text=t("mount_name") + ":", variant="dialog_muted").pack(anchor="w")
    name_entry = AppEntry(frm, textvariable=name_var)
    name_entry.pack(fill="x", pady=(1, 8))

    btns = AppFrame(frm, surface="dialog")
    btns.pack(fill="x")

    def cancel(_evt=None):
        dlg.destroy()
        return "break"

    def save(_evt=None):
        path = path_var.get().strip()
        name = name_var.get().strip() or _folder_basename(path)
        if not path or not name:
            return "break"
        if _utf16_units(name) > ROOT_NAME_MAX_LEN:
            messagebox.showerror(
                "PeerSync by Nickston",
                t("mount_name_too_long", max=ROOT_NAME_MAX_LEN),
                parent=dlg,
            )
            name_entry.focus_set()
            return "break"
        result["ok"] = True
        result["path"] = path
        result["name"] = name
        dlg.destroy()
        return "break"

    AppButton(btns, text=t("close"), command=cancel).pack(side="left")
    add_btn = AppButton(btns, text=t("add_folder"), variant="primary", command=save, state="disabled")
    add_btn.pack(side="right")
    dlg.protocol("WM_DELETE_WINDOW", cancel)
    dlg.bind("<Escape>", cancel)
    dlg.bind("<Return>", save)
    _modal(parent, dlg, path_entry)
    if not result["ok"]:
        return None
    return {"path": result["path"], "name": result["name"]}


def show_copy_collision(parent, collisions):
    """Return ``overwrite``, ``skip``, or ``None`` if the user cancelled."""
    prompt = collision_prompt(collisions)
    result = {"decision": None}
    dlg = _new_toplevel(
        parent,
        "PeerSync — " + t("copy_exists_title"),
        resizable=(True, False),
        minsize=(480, 0),
    )

    frm = AppDialogFrame(dlg)
    frm.pack(fill="both", expand=True)
    AppLabel(frm, text=t("copy_exists_title"), variant="dialog_title").pack(anchor="w")
    if prompt["body"]:
        AppLabel(frm, text=prompt["body"], variant="dialog", wraplength=520).pack(anchor="w", pady=(2, 4))
    AppLabel(frm, text=prompt["hint"], variant="dialog_muted", wraplength=520).pack(anchor="w", pady=(0, 6))
    if prompt["mismatch"]:
        AppLabel(frm, text=prompt["mismatch"], variant="dialog_hint_error", wraplength=520).pack(
            anchor="w", pady=(0, 8)
        )

    btns = AppFrame(frm, surface="dialog")
    btns.pack(fill="x")

    def cancel(_evt=None):
        dlg.destroy()
        return "break"

    def skip(_evt=None):
        result["decision"] = "skip"
        dlg.destroy()
        return "break"

    def replace(_evt=None):
        if not prompt["can_replace"]:
            return "break"
        result["decision"] = "overwrite"
        dlg.destroy()
        return "break"

    AppButton(btns, text=t("cancel"), command=cancel).pack(side="left")
    replace_btn = AppButton(
        btns,
        text=t("copy_replace"),
        variant="primary",
        command=replace,
        state="normal" if prompt["can_replace"] else "disabled",
    )
    replace_btn.pack(side="right")
    AppButton(btns, text=t("copy_skip"), command=skip).pack(side="right", padx=(0, 7))
    dlg.protocol("WM_DELETE_WINDOW", cancel)
    dlg.bind("<Escape>", cancel)
    dlg.bind("<Return>", replace if prompt["can_replace"] else skip)
    _modal(parent, dlg, replace_btn if prompt["can_replace"] else None)
    return result["decision"]
