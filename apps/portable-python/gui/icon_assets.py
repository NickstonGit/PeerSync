"""Small monochrome UI icon loader with light/dark variants."""

import os
import sys
import tkinter as tk


def resource_path(*parts):
    base = getattr(sys, "_MEIPASS", None)
    if not base:
        base = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    return os.path.join(base, "assets", *parts)


def load_icon(master, name, dark=False, disabled=False):
    suffix = "dark" if dark else "light"
    state = "-disabled" if disabled else ""
    path = resource_path("ui-icons", "%s%s-%s.png" % (name, state, suffix))
    return tk.PhotoImage(master=master, file=path)


def load_button_icon(master, name, dark=False):
    """Return (normal, disabled, ttk image-spec) without Tk's stipple fallback."""
    normal = load_icon(master, name, dark=dark, disabled=False)
    disabled = load_icon(master, name, dark=dark, disabled=True)
    return normal, disabled, (normal, "disabled", disabled)
