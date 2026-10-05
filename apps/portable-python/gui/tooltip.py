"""Short hover hints for Tk widgets."""

import tkinter as tk

from gui import theme as ui_theme


class ToolTip:
    def __init__(self, widget, text):
        self.widget = widget
        self.text = text
        self._tip = None
        widget.bind("<Enter>", self._enter)
        widget.bind("<Leave>", self._leave)

    def _enter(self, _evt=None):
        if self._tip or not self.text:
            return
        x = self.widget.winfo_rootx() + 12
        y = self.widget.winfo_rooty() + self.widget.winfo_height() + 6
        self._tip = tw = tk.Toplevel(self.widget)
        tw.wm_overrideredirect(True)
        tw.wm_geometry("+%d+%d" % (x, y))
        tw.configure(background=ui_theme.color("BORDER"))
        tk.Label(
            tw,
            text=self.text,
            justify="left",
            background=ui_theme.color("FIELD"),
            foreground=ui_theme.color("INK"),
            highlightbackground=ui_theme.color("BORDER"),
            highlightcolor=ui_theme.color("BORDER"),
            highlightthickness=1,
            relief="flat",
            borderwidth=0,
            padx=6,
            pady=3,
        ).pack()

    def _leave(self, _evt=None):
        if self._tip is not None:
            self._tip.destroy()
            self._tip = None
