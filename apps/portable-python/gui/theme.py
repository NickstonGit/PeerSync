"""Small, consistent visual system for the portable Tk shell."""

import ctypes
import sys
import tkinter as tk
import tkinter.font as tkfont
from tkinter import ttk

from gui import design


# Calm blue-grey shell with slightly lighter working surfaces.  The important
# part is the *step* between the tones: controls remain visible without looking
# like white stickers pasted on a grey window.
APP_BG = "#d4dde5"
HEADER_BG = "#c7d3de"
SURFACE = "#e2e8ed"
SURFACE_ALT = "#d4dde5"
BUTTON_BG = "#edf1f4"
BUTTON_HOVER = "#dceaf8"
BUTTON_ACTIVE = "#dce4ea"
PAPER = SURFACE
FIELD = "#eef2f5"
FIELD_HOVER = "#f4f6f8"
INK = "#20303d"
MUTED = "#5a6b79"
BORDER = "#a5b3bf"
BORDER_STRONG = "#7d91a2"
ACCENT = "#2563eb"
ACCENT_HOVER = "#1f5bd5"
ACCENT_ACTIVE = "#1d4ed8"
ACCENT_SOFT = "#d5e4ff"
DANGER = "#b42318"
SUCCESS = "#157347"
WARNING = "#8a6500"
DISABLED_BG = "#d1d9e0"
DISABLED_FG = "#697784"
PROGRESS_FILL = "#abc8fa"
PROGRESS_DONE = "#badfc9"
PROGRESS_FAILED = "#efc9c5"
PROGRESS_WAITING = "#cbd7e1"

# The light palette remains the default exported constants for compatibility.
# apply_contrast() swaps these globals before reconfiguring ttk so the same
# widgets can change theme without a restart.
_LIGHT_PALETTE = {
    "APP_BG": APP_BG, "HEADER_BG": HEADER_BG, "SURFACE": SURFACE,
    "SURFACE_ALT": SURFACE_ALT, "BUTTON_BG": BUTTON_BG,
    "BUTTON_HOVER": BUTTON_HOVER, "BUTTON_ACTIVE": BUTTON_ACTIVE,
    "PAPER": PAPER, "FIELD": FIELD, "FIELD_HOVER": FIELD_HOVER,
    "INK": INK, "MUTED": MUTED, "BORDER": BORDER,
    "BORDER_STRONG": BORDER_STRONG, "ACCENT": ACCENT,
    "ACCENT_HOVER": ACCENT_HOVER, "ACCENT_ACTIVE": ACCENT_ACTIVE,
    "ACCENT_SOFT": ACCENT_SOFT, "DANGER": DANGER, "SUCCESS": SUCCESS,
    "WARNING": WARNING, "DISABLED_BG": DISABLED_BG,
    "DISABLED_FG": DISABLED_FG, "PROGRESS_FILL": PROGRESS_FILL,
    "PROGRESS_DONE": PROGRESS_DONE, "PROGRESS_FAILED": PROGRESS_FAILED,
    "PROGRESS_WAITING": PROGRESS_WAITING,
}
_DARK_PALETTE = {
    "APP_BG": "#1f272e",
    "HEADER_BG": "#25313b",
    "SURFACE": "#2b353e",
    "SURFACE_ALT": "#25313b",
    "BUTTON_BG": "#34414c",
    "BUTTON_HOVER": "#405160",
    "BUTTON_ACTIVE": "#2f3a43",
    "PAPER": "#2b353e",
    "FIELD": "#313c45",
    "FIELD_HOVER": "#394751",
    "INK": "#e8eef3",
    "MUTED": "#a7b6c1",
    "BORDER": "#465662",
    "BORDER_STRONG": "#657887",
    "ACCENT": "#5b8def",
    "ACCENT_HOVER": "#6c9af1",
    "ACCENT_ACTIVE": "#4b7ee0",
    "ACCENT_SOFT": "#304766",
    "DANGER": "#ff8278",
    "SUCCESS": "#69d092",
    "WARNING": "#e8c466",
    "DISABLED_BG": "#29333b",
    "DISABLED_FG": "#71818d",
    "PROGRESS_FILL": "#476b9e",
    "PROGRESS_DONE": "#365c47",
    "PROGRESS_FAILED": "#68403f",
    "PROGRESS_WAITING": "#3b4852",
}
_CURRENT_PALETTE = dict(_LIGHT_PALETTE)

def _select_palette(dark=False):
    global _CURRENT_PALETTE
    _CURRENT_PALETTE = dict(_DARK_PALETTE if dark else _LIGHT_PALETTE)
    globals().update(_CURRENT_PALETTE)
    return _CURRENT_PALETTE

def color(name):
    return _CURRENT_PALETTE.get(str(name), _LIGHT_PALETTE.get(str(name), "#000000"))

def is_dark_theme(root=None):
    if root is not None:
        return bool(getattr(root, "_as_dark_theme", False))
    return _CURRENT_PALETTE is not None and _CURRENT_PALETTE.get("APP_BG") == _DARK_PALETTE["APP_BG"]

# Typography is a design token, not a per-widget decision.
UI_FONT = design.UI_FONT
UI_FONT_SEMIBOLD = design.UI_FONT_SEMIBOLD
SMALL_FONT = design.SMALL_FONT
TITLE_FONT = design.TITLE_FONT
BRAND_BYLINE_FONT = design.BRAND_BYLINE_FONT
HEADER_META_FONT = design.HEADER_META_FONT
WINDOW_CONTROL_FONT = design.WINDOW_CONTROL_FONT
SECTION_FONT = design.SECTION_FONT
DIALOG_TITLE_FONT = design.DIALOG_TITLE_FONT
CODE_FONT = design.CODE_FONT


def _configure_named_fonts(root):
    """Make classic Tk widgets use the same readable font as ttk widgets."""
    for name in ("TkDefaultFont", "TkTextFont", "TkMenuFont", "TkHeadingFont", "TkCaptionFont"):
        try:
            font = tkfont.nametofont(name, root=root)
            font.configure(family="Segoe UI", size=11)
        except tk.TclError:
            pass


def _hex_to_colorref(value):
    value = str(value or "").lstrip("#")
    if len(value) != 6:
        return 0
    r = int(value[0:2], 16)
    g = int(value[2:4], 16)
    b = int(value[4:6], 16)
    return r | (g << 8) | (b << 16)


def apply_window_chrome(window):
    """Keep the custom caption visually stable on supported Windows versions.

    Windows 11 can hide the DWM border directly.  Windows 10 cannot set a
    per-window border colour, so disable DWM non-client rendering for this
    captionless window instead.  Resize/Snap continue to come from the custom
    HT* hit-test zones in ``windows.chrome``.
    """
    if sys.platform != "win32":
        return
    try:
        build = int(getattr(sys.getwindowsversion(), "build", 0))
    except Exception:  # noqa: BLE001
        build = 0
    try:
        window.update_idletasks()
        hwnd = int(window.winfo_id())
        user32 = ctypes.windll.user32
        parent = int(user32.GetParent(hwnd) or 0)
        get_ancestor = getattr(user32, "GetAncestor", None)
        root_hwnd = int(get_ancestor(ctypes.c_void_p(parent or hwnd), 2) or 0) if get_ancestor else 0
        handles = []
        for handle in (root_hwnd, parent, hwnd):
            if handle and handle not in handles:
                handles.append(handle)
        dwm = ctypes.windll.dwmapi

        if build and build < 22000:
            # DWMWA_NCRENDERING_POLICY = 2, DWMNCRP_DISABLED = 1.
            # This is the reliable Win10 fix for the focus/hover-sensitive grey
            # strip left by WS_THICKFRAME on a captionless Tk top-level.
            policy = ctypes.c_int(1)
            for handle in handles:
                try:
                    dwm.DwmSetWindowAttribute(
                        ctypes.c_void_p(handle),
                        ctypes.c_uint(2),
                        ctypes.byref(policy),
                        ctypes.sizeof(policy),
                    )
                except Exception:  # noqa: BLE001
                    pass
            return

        caption = ctypes.c_int(_hex_to_colorref(HEADER_BG))
        border = ctypes.c_uint(0xFFFFFFFE)  # DWMWA_COLOR_NONE
        text = ctypes.c_int(_hex_to_colorref(INK))
        corners = ctypes.c_int(2)  # DWMWCP_ROUND
        for handle in handles:
            for attr, value in ((33, corners), (34, border), (35, caption), (36, text)):
                try:
                    dwm.DwmSetWindowAttribute(
                        ctypes.c_void_p(handle),
                        ctypes.c_uint(attr),
                        ctypes.byref(value),
                        ctypes.sizeof(value),
                    )
                except Exception:  # noqa: BLE001
                    pass
    except Exception:  # noqa: BLE001
        pass


def apply_contrast(root, dark=False):
    _select_palette(bool(dark))
    root._as_dark_theme = bool(dark)
    style = ttk.Style(root)
    try:
        style.theme_use("clam")
    except tk.TclError:
        pass

    _configure_named_fonts(root)
    root.option_add("*Font", UI_FONT)
    root.option_add("*TCombobox*Listbox.font", UI_FONT)
    root.option_add("*TCombobox*Listbox.background", FIELD)
    root.option_add("*TCombobox*Listbox.foreground", INK)
    root.option_add("*TCombobox*Listbox.selectBackground", ACCENT_SOFT)
    root.option_add("*TCombobox*Listbox.selectForeground", INK)
    root.configure(background=APP_BG)

    style.configure("TFrame", background=APP_BG)
    style.configure("Header.TFrame", background=HEADER_BG)
    style.configure("Surface.TFrame", background=SURFACE)
    style.configure("Dialog.TFrame", background=SURFACE)
    # Matches the Panedwindow sash so the chat column is split from the file
    # cards by the same dark rule that separates the cards from each other.
    # The sash paints a 5px core between two 1px softened edges, and that 7px
    # footprint is what reads as the divider; a bare flat 5px bar looked thinner.
    style.configure("Divider.TFrame", background=BORDER_STRONG)
    style.configure("DividerEdge.TFrame", background=BORDER)
    style.configure("TLabel", background=APP_BG, foreground=INK, font=UI_FONT)
    style.configure("Header.TLabel", background=HEADER_BG, foreground=INK, font=UI_FONT)
    style.configure("HeaderMeta.TLabel", background=HEADER_BG, foreground=MUTED, font=HEADER_META_FONT)
    style.configure("BrandByline.TLabel", background=HEADER_BG, foreground=MUTED, font=BRAND_BYLINE_FONT)
    style.configure("Surface.TLabel", background=SURFACE, foreground=INK, font=UI_FONT)
    style.configure("Dialog.TLabel", background=SURFACE, foreground=INK, font=UI_FONT)
    style.configure("Muted.TLabel", foreground=MUTED, background=APP_BG, font=UI_FONT)
    style.configure("SurfaceMuted.TLabel", foreground=MUTED, background=SURFACE, font=UI_FONT)
    style.configure("DialogMuted.TLabel", foreground=MUTED, background=SURFACE, font=UI_FONT)
    style.configure("Title.TLabel", font=TITLE_FONT, foreground=INK, background=HEADER_BG)
    style.configure("DialogTitle.TLabel", font=DIALOG_TITLE_FONT, foreground=INK, background=SURFACE)
    style.configure("Section.TLabel", font=SECTION_FONT, foreground=INK, background=APP_BG)
    style.configure("SurfaceSection.TLabel", font=SECTION_FONT, foreground=INK, background=SURFACE)
    style.configure("DialogSection.TLabel", font=SECTION_FONT, foreground=INK, background=SURFACE)
    style.configure("Dialog.TCheckbutton", font=UI_FONT, foreground=INK, background=SURFACE)
    style.map("Dialog.TCheckbutton", background=[("active", SURFACE)])

    # Compact status line: larger type, but no oversized top/bottom padding.
    for name, foreground in (
        ("Status.TLabel", MUTED),
        ("StatusInfo.TLabel", INK),
        ("StatusError.TLabel", DANGER),
        ("StatusWarning.TLabel", WARNING),
        ("StatusSuccess.TLabel", SUCCESS),
    ):
        style.configure(name, foreground=foreground, background=SURFACE, padding=design.STATUS_PADDING, font=UI_FONT)

    style.configure("Hint.TLabel", foreground=MUTED, background=APP_BG, font=UI_FONT)
    style.configure("HintSuccess.TLabel", foreground=SUCCESS, background=APP_BG, font=UI_FONT)
    style.configure("HintError.TLabel", foreground=DANGER, background=APP_BG, font=UI_FONT)
    style.configure("DialogHint.TLabel", foreground=MUTED, background=SURFACE, font=UI_FONT)
    style.configure("DialogHintSuccess.TLabel", foreground=SUCCESS, background=SURFACE, font=UI_FONT)
    style.configure("DialogHintError.TLabel", foreground=DANGER, background=SURFACE, font=UI_FONT)
    style.configure("SurfaceSuccess.TLabel", foreground=SUCCESS, background=SURFACE, font=UI_FONT)
    style.configure("SurfaceError.TLabel", foreground=DANGER, background=SURFACE, font=UI_FONT)

    # Buttons are canvas-rendered by AppButton; ttk owns no button visuals.

    style.configure(
        "Card.TLabelframe",
        background=SURFACE,
        bordercolor=BORDER,
        lightcolor=BORDER,
        darkcolor=BORDER,
        relief="solid",
        borderwidth=1,
        padding=design.CARD_PADDING,
    )
    style.configure(
        "Card.TLabelframe.Label",
        background=SURFACE,
        foreground=INK,
        font=UI_FONT_SEMIBOLD,
        # Caption no longer starts hard against the left border.
        padding=design.LABELFRAME_CAPTION_PADDING,
    )

    try:
        def _unmap(option):
            return [
                elm
                for elm in style.map("Treeview", query_opt=option)
                if elm[:2] != ("!disabled", "!selected")
            ]

        style.map("Treeview", foreground=_unmap("foreground"), background=_unmap("background"))
    except tk.TclError:
        pass
    style.configure(
        "Treeview",
        background=FIELD,
        fieldbackground=FIELD,
        foreground=INK,
        font=UI_FONT,
        rowheight=25,
        bordercolor=BORDER,
        lightcolor=BORDER,
        darkcolor=BORDER,
        borderwidth=1,
    )
    style.configure(
        "Treeview.Heading",
        foreground=INK,
        background="#cbd6df" if not dark else "#36434d",
        font=UI_FONT_SEMIBOLD,
        padding=(7, 1),
        bordercolor=BORDER_STRONG,
        lightcolor=BORDER,
        darkcolor=BORDER_STRONG,
        relief="raised",
        borderwidth=1,
    )
    style.map(
        "Treeview",
        background=[("selected", ACCENT_SOFT)],
        foreground=[("selected", INK)],
    )
    style.map("Treeview.Heading", background=[("active", "#d4dee6" if not dark else "#41515d")])

    style.configure(
        "TCombobox",
        font=UI_FONT,
        padding=(8, 1),
        arrowsize=14,
        arrowcolor=MUTED,
        bordercolor=BORDER,
        lightcolor=FIELD,
        darkcolor=FIELD,
        fieldbackground=FIELD,
        background=FIELD,
        foreground=INK,
        relief="flat",
    )
    style.map(
        "TCombobox",
        fieldbackground=[("readonly", FIELD), ("disabled", DISABLED_BG)],
        foreground=[("readonly", INK), ("disabled", DISABLED_FG)],
        background=[("readonly", FIELD), ("active", FIELD_HOVER), ("disabled", DISABLED_BG)],
        arrowcolor=[("active", ACCENT_ACTIVE), ("disabled", DISABLED_FG), ("readonly", MUTED)],
        bordercolor=[("focus", ACCENT), ("active", BORDER_STRONG), ("disabled", BORDER)],
        lightcolor=[("readonly", FIELD), ("disabled", DISABLED_BG)],
        darkcolor=[("readonly", FIELD), ("disabled", DISABLED_BG)],
    )

    style.configure(
        "TEntry",
        font=UI_FONT,
        padding=design.ENTRY_PADDING,
        fieldbackground=FIELD,
        foreground=INK,
        bordercolor=BORDER,
        lightcolor=FIELD,
        darkcolor=FIELD,
        insertcolor=INK,
    )
    style.map(
        "TEntry",
        fieldbackground=[("disabled", DISABLED_BG)],
        foreground=[("disabled", DISABLED_FG)],
        bordercolor=[("focus", ACCENT), ("disabled", BORDER)],
    )
    # Pairing-code entry: readable monospace text with real internal inset.
    style.configure(
        "Code.TEntry",
        font=CODE_FONT,
        padding=design.CODE_ENTRY_PADDING,
        fieldbackground=FIELD,
        foreground=INK,
        bordercolor=BORDER,
        lightcolor=FIELD,
        darkcolor=FIELD,
        insertcolor=INK,
    )
    style.map(
        "Code.TEntry",
        fieldbackground=[("readonly", FIELD), ("disabled", DISABLED_BG)],
        foreground=[("readonly", INK), ("disabled", DISABLED_FG)],
        bordercolor=[("focus", ACCENT), ("disabled", BORDER)],
    )

    style.configure(
        "Path.TLabel",
        font=UI_FONT,
        foreground=INK,
        background=FIELD,
        padding=(8, 2),
        bordercolor=BORDER,
        lightcolor=BORDER,
        darkcolor=BORDER,
        relief="solid",
        borderwidth=1,
        anchor="e",
        justify="right",
    )

    style.configure("Horizontal.TProgressbar", troughcolor=SURFACE_ALT, background=ACCENT, bordercolor=BORDER)

    # clam leaves sash/scrollbar sub-elements at theme defaults unless every
    # relevant option is set.  Explicit styles prevent bright native-looking
    # strips inside an otherwise dark application.
    style.configure(
        "App.TPanedwindow",
        background=BORDER_STRONG,
        bordercolor=BORDER_STRONG,
        lightcolor=BORDER_STRONG,
        darkcolor=BORDER_STRONG,
    )
    # ttk clam's Sash is a separate internal style.  Styling only the
    # Panedwindow background leaves the divider at the theme's light default.
    for sash_style in ("Sash", "Horizontal.Sash", "Vertical.Sash"):
        style.configure(
            sash_style,
            sashthickness=5,
            gripcount=0,
            background=BORDER_STRONG,
            bordercolor=BORDER_STRONG,
            lightcolor=BORDER_STRONG,
            darkcolor=BORDER_STRONG,
            relief="flat",
        )
    for scrollbar_style in ("TScrollbar", "Horizontal.TScrollbar", "Vertical.TScrollbar"):
        style.configure(
            scrollbar_style,
            background=SURFACE_ALT,
            troughcolor=SURFACE,
            bordercolor=BORDER,
            lightcolor=SURFACE_ALT,
            darkcolor=SURFACE_ALT,
            arrowcolor=MUTED,
            relief="flat",
        )
        style.map(
            scrollbar_style,
            background=[("pressed", BORDER_STRONG), ("active", FIELD_HOVER), ("disabled", DISABLED_BG)],
            arrowcolor=[("disabled", DISABLED_FG), ("active", INK)],
            bordercolor=[("active", BORDER_STRONG), ("disabled", BORDER)],
            lightcolor=[("active", FIELD_HOVER), ("disabled", DISABLED_BG)],
            darkcolor=[("active", FIELD_HOVER), ("disabled", DISABLED_BG)],
        )

    try:
        root.after_idle(lambda: apply_window_chrome(root))
    except tk.TclError:
        pass
    # All clickable buttons use one canvas renderer; repaint them after
    # changing the shared palette instead of rebuilding per-style ttk assets.
    try:
        from gui.button import refresh_buttons
        refresh_buttons(root)
    except (ImportError, tk.TclError):
        pass
