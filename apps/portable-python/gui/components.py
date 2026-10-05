"""Single entry point for reusable portable-UI primitives.

Business screens should import common controls from this module rather than
constructing raw ttk widgets with local styles.  Appearance stays in theme.py;
this module owns the semantic component variants used by screens.
"""

from tkinter import ttk

from gui.button import AppButton
from gui.icon_assets import load_icon, load_button_icon
from gui.tooltip import ToolTip
from gui import design


_FRAME_STYLES = {
    "default": "TFrame",
    "root": "TFrame",
    "header": "Header.TFrame",
    "surface": "Surface.TFrame",
    "dialog": "Dialog.TFrame",
    "divider": "Divider.TFrame",
    "divider_edge": "DividerEdge.TFrame",
}

_LABEL_STYLES = {
    "default": "TLabel",
    "header": "Header.TLabel",
    "header_meta": "HeaderMeta.TLabel",
    "brand_byline": "BrandByline.TLabel",
    "surface": "Surface.TLabel",
    "dialog": "Dialog.TLabel",
    "muted": "Muted.TLabel",
    "surface_muted": "SurfaceMuted.TLabel",
    "dialog_muted": "DialogMuted.TLabel",
    "title": "Title.TLabel",
    "dialog_title": "DialogTitle.TLabel",
    "section": "Section.TLabel",
    "surface_section": "SurfaceSection.TLabel",
    "dialog_section": "DialogSection.TLabel",
    "hint": "Hint.TLabel",
    "hint_success": "HintSuccess.TLabel",
    "hint_error": "HintError.TLabel",
    "dialog_hint": "DialogHint.TLabel",
    "dialog_hint_success": "DialogHintSuccess.TLabel",
    "dialog_hint_error": "DialogHintError.TLabel",
    "surface_success": "SurfaceSuccess.TLabel",
    "surface_error": "SurfaceError.TLabel",
    "status": "StatusInfo.TLabel",
    "status_info": "StatusInfo.TLabel",
    "status_error": "StatusError.TLabel",
    "status_warning": "StatusWarning.TLabel",
    "status_success": "StatusSuccess.TLabel",
    "path": "Path.TLabel",
}

_STATUS_VARIANTS = {
    "info": "status_info",
    "error": "status_error",
    "warning": "status_warning",
    "success": "status_success",
}


class AppFrame(ttk.Frame):
    def __init__(self, master=None, *, surface="default", **kwargs):
        style = kwargs.pop("style", _FRAME_STYLES.get(surface, _FRAME_STYLES["default"]))
        super().__init__(master, style=style, **kwargs)
        self._surface = surface


class AppLabel(ttk.Label):
    def __init__(self, master=None, *, variant="default", **kwargs):
        style = kwargs.pop("style", _LABEL_STYLES.get(variant, _LABEL_STYLES["default"]))
        super().__init__(master, style=style, **kwargs)
        self._variant = variant

    def configure(self, cnf=None, **kwargs):
        if "variant" in kwargs:
            self._variant = kwargs.pop("variant")
            kwargs["style"] = _LABEL_STYLES.get(self._variant, _LABEL_STYLES["default"])
        return super().configure(cnf, **kwargs)

    config = configure


class AppStatus(AppLabel):
    def __init__(self, master=None, *, severity="info", **kwargs):
        super().__init__(master, variant=_STATUS_VARIANTS.get(severity, "status_info"), **kwargs)
        self._severity = severity

    def set_severity(self, severity="info"):
        self._severity = severity if severity in _STATUS_VARIANTS else "info"
        self.configure(variant=_STATUS_VARIANTS[self._severity])


class AppEntry(ttk.Entry):
    def __init__(self, master=None, *, variant="default", **kwargs):
        style = kwargs.pop("style", "Code.TEntry" if variant == "code" else "TEntry")
        super().__init__(master, style=style, **kwargs)
        self._variant = variant


class AppComboBox(ttk.Combobox):
    def __init__(self, master=None, **kwargs):
        kwargs.setdefault("style", "TCombobox")
        super().__init__(master, **kwargs)


class AppCard(ttk.LabelFrame):
    def __init__(self, master=None, *, title=None, padding=None, **kwargs):
        if title is not None and "text" not in kwargs:
            kwargs["text"] = title
        kwargs.setdefault("style", "Card.TLabelframe")
        kwargs.setdefault("padding", design.CARD_PADDING if padding is None else padding)
        super().__init__(master, **kwargs)


class AppCheckBox(ttk.Checkbutton):
    def __init__(self, master=None, *, surface="dialog", **kwargs):
        if "style" not in kwargs:
            kwargs["style"] = "Dialog.TCheckbutton" if surface == "dialog" else "TCheckbutton"
        super().__init__(master, **kwargs)


class AppTree(ttk.Treeview):
    def __init__(self, master=None, **kwargs):
        kwargs.setdefault("style", "Treeview")
        super().__init__(master, **kwargs)


class AppScrollbar(ttk.Scrollbar):
    def __init__(self, master=None, **kwargs):
        orient = str(kwargs.get("orient", "vertical")).lower()
        kwargs.setdefault("style", "Horizontal.TScrollbar" if orient.startswith("h") else "Vertical.TScrollbar")
        super().__init__(master, **kwargs)


class AppProgress(ttk.Progressbar):
    def __init__(self, master=None, **kwargs):
        kwargs.setdefault("style", "Horizontal.TProgressbar")
        super().__init__(master, **kwargs)


class AppPanedWindow(ttk.Panedwindow):
    def __init__(self, master=None, **kwargs):
        kwargs.setdefault("style", "App.TPanedwindow")
        super().__init__(master, **kwargs)


class AppDialogFrame(AppFrame):
    def __init__(self, master=None, *, padding=None, **kwargs):
        kwargs.setdefault("padding", design.FRAME_PADDING if padding is None else padding)
        super().__init__(master, surface="dialog", **kwargs)


__all__ = [
    "AppButton",
    "AppFrame",
    "AppLabel",
    "AppStatus",
    "AppEntry",
    "AppComboBox",
    "AppCard",
    "AppCheckBox",
    "AppTree",
    "AppScrollbar",
    "AppProgress",
    "AppPanedWindow",
    "AppDialogFrame",
    "ToolTip",
    "load_icon",
    "load_button_icon",
]
