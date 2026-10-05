"""One renderer for every clickable button in the portable UI.

The application previously mixed native ttk button layouts, image-backed rounded
styles and per-screen tweaks.  ``AppButton`` is now the single button primitive:
variants only change palette; geometry, radius, hover/pressed/disabled behaviour,
text/icon layout and keyboard semantics all live here.
"""

import tkinter as tk
import tkinter.font as tkfont
import weakref

from gui import theme as ui_theme
from gui import design


_DEFAULT_HEIGHT = design.CONTROL_HEIGHT
_COMPACT_HEIGHT = design.CONTROL_HEIGHT_COMPACT
_ICON_WIDTH_CHARS = design.ICON_BUTTON_WIDTH_CHARS
_RADIUS = design.CONTROL_RADIUS


class AppButton(tk.Canvas):
    """Canvas-backed rounded button with a small ttk-compatible surface API."""

    def __init__(
        self,
        master,
        *,
        text="",
        image=None,
        disabled_image=None,
        command=None,
        variant="default",
        state="normal",
        width=None,
        height=None,
        compound="center",
        takefocus=True,
        compact=False,
        surface=None,
        radius=_RADIUS,
        **kwargs,
    ):
        self._toplevel = master.winfo_toplevel()
        self._text = str(text or "")
        self._command = command
        self._variant = self._normalize_variant(variant)
        self._state = "disabled" if str(state).lower() == "disabled" else "normal"
        self._compound = str(compound or "center").lower()
        self._takefocus = bool(takefocus)
        self._compact = bool(compact)
        self._surface = surface
        self._radius = max(3, int(radius or _RADIUS))
        self._hover = False
        self._pressed = False
        self._focused = False
        self._image = None
        self._disabled_image = None
        self._badge = False
        self._draw_signature = None
        self._width_chars = None if width in (None, "") else max(1, int(width))
        self._fixed_height = None if height in (None, "") else max(18, int(height))
        self._font = ui_theme.UI_FONT_SEMIBOLD
        self._cursor_normal = kwargs.pop("cursor", "hand2")
        self._surface_image_cache = {}

        # Canvas itself occupies the exact button box.  Its background is the
        # surrounding surface, so rounded corners are genuinely transparent to
        # the parent rather than faked with a second rectangular button style.
        super().__init__(
            master,
            highlightthickness=0,
            borderwidth=0,
            relief="flat",
            takefocus=1 if self._takefocus else 0,
            cursor="" if self._state == "disabled" else self._cursor_normal,
            **kwargs,
        )
        self._set_image_spec(image, disabled_image)
        self._install_bindtag()
        self._register_instance()
        self.refresh_theme(resize=True)

    # ---------- public API (small ttk.Button-compatible subset) ----------
    @staticmethod
    def _normalize_variant(value):
        value = str(value or "default").strip().lower().replace("-", "_")
        aliases = {
            "base": "default",
            "primary": "primary",
            "danger": "danger",
            "header": "header",
            "icon": "icon",
            "window": "window",
            "close": "close",
            "toggleoff": "toggle_off",
            "toggleon": "toggle_on",
            "toggle_off": "toggle_off",
            "toggle_on": "toggle_on",
            "compact": "default",
        }
        return aliases.get(value, value if value in {
            "default", "primary", "danger", "header", "icon", "window", "close", "toggle_off", "toggle_on"
        } else "default")

    @staticmethod
    def variant_from_legacy_style(style):
        mapping = {
            "Primary.TButton": "primary",
            "Danger.TButton": "danger",
            "Header.TButton": "header",
            "Icon.TButton": "icon",
            "WindowControl.TButton": "window",
            "CloseWindowControl.TButton": "close",
            "ToggleOff.TButton": "toggle_off",
            "ToggleOn.TButton": "toggle_on",
            "Compact.TButton": "default",
            "TButton": "default",
        }
        return mapping.get(str(style or ""), "default")

    def configure(self, cnf=None, **kwargs):
        if cnf:
            if isinstance(cnf, dict):
                kwargs = {**cnf, **kwargs}
            else:
                return super().configure(cnf, **kwargs)

        resize = False
        redraw = False
        badge_only = False
        if "text" in kwargs:
            self._text = str(kwargs.pop("text") or "")
            resize = redraw = True
        if "command" in kwargs:
            self._command = kwargs.pop("command")
        if "state" in kwargs:
            self._state = "disabled" if str(kwargs.pop("state")).lower() == "disabled" else "normal"
            if self._state == "disabled":
                self._pressed = False
                self._hover = False
            redraw = True
        if "variant" in kwargs:
            self._variant = self._normalize_variant(kwargs.pop("variant"))
            redraw = True
        if "style" in kwargs:
            # Transitional compatibility for callers outside the portable UI.
            self._variant = self.variant_from_legacy_style(kwargs.pop("style"))
            redraw = True
        if "image" in kwargs:
            image = kwargs.pop("image")
            disabled = kwargs.pop("disabled_image", self._disabled_image)
            self._set_image_spec(image, disabled)
            resize = redraw = True
        elif "disabled_image" in kwargs:
            self._disabled_image = kwargs.pop("disabled_image")
            redraw = True
        if "badge" in kwargs:
            next_badge = bool(kwargs.pop("badge"))
            if next_badge != self._badge:
                self._badge = next_badge
                badge_only = True
        if "compound" in kwargs:
            self._compound = str(kwargs.pop("compound") or "center").lower()
            resize = redraw = True
        if "width" in kwargs:
            self._width_chars = max(1, int(kwargs.pop("width")))
            resize = True
        if "height" in kwargs:
            self._fixed_height = max(18, int(kwargs.pop("height")))
            resize = True
        if "cursor" in kwargs:
            self._cursor_normal = kwargs.pop("cursor") or "hand2"
            redraw = True
        if "takefocus" in kwargs:
            self._takefocus = bool(kwargs.pop("takefocus"))
            super().configure(takefocus=1 if self._takefocus else 0)
        if kwargs:
            super().configure(**kwargs)
        if resize:
            self._apply_geometry()
        if redraw or resize:
            self._draw()
        elif badge_only:
            self._sync_badge()
        return self

    config = configure

    def cget(self, key):
        if key == "text":
            return self._text
        if key == "state":
            return self._state
        if key == "variant" or key == "style":
            return self._variant
        if key == "command":
            return self._command
        if key == "image":
            return self._image
        if key == "compound":
            return self._compound
        if key == "badge":
            return self._badge
        return super().cget(key)

    def state(self, specs=None):
        specs = list(specs or [])
        for spec in specs:
            spec = str(spec)
            if spec == "disabled":
                self._state = "disabled"
            elif spec == "!disabled":
                self._state = "normal"
            elif spec in ("active", "hover"):
                self._hover = True
            elif spec in ("!active", "!hover"):
                self._hover = False
            elif spec == "pressed":
                self._pressed = True
            elif spec == "!pressed":
                self._pressed = False
        self._draw()
        result = []
        if self._state == "disabled":
            result.append("disabled")
        if self._hover:
            result.append("active")
        if self._pressed:
            result.append("pressed")
        return tuple(result)

    def instate(self, specs):
        current = set(self.state())
        for spec in specs or []:
            spec = str(spec)
            if spec.startswith("!"):
                if spec[1:] in current:
                    return False
            elif spec not in current:
                return False
        return True

    def invoke(self):
        if self._state == "disabled" or not callable(self._command):
            return None
        return self._command()

    def refresh_theme(self, resize=False):
        try:
            super().configure(background=self._surface_color())
        except tk.TclError:
            return
        if resize:
            self._apply_geometry()
        self._draw()

    # ---------- shared event mechanism ----------
    def _install_bindtag(self):
        tags = list(self.bindtags())
        if "ASNButton" not in tags:
            tags.insert(1, "ASNButton")
            self.bindtags(tuple(tags))
        root = self._toplevel
        if getattr(root, "_asn_button_bindings", False):
            return
        root._asn_button_bindings = True
        root.bind_class("ASNButton", "<Enter>", lambda e: AppButton._dispatch(e, "enter"))
        root.bind_class("ASNButton", "<Leave>", lambda e: AppButton._dispatch(e, "leave"))
        root.bind_class("ASNButton", "<ButtonPress-1>", lambda e: AppButton._dispatch(e, "press"))
        root.bind_class("ASNButton", "<ButtonRelease-1>", lambda e: AppButton._dispatch(e, "release"))
        root.bind_class("ASNButton", "<FocusIn>", lambda e: AppButton._dispatch(e, "focus_in"))
        root.bind_class("ASNButton", "<FocusOut>", lambda e: AppButton._dispatch(e, "focus_out"))
        root.bind_class("ASNButton", "<Configure>", lambda e: AppButton._dispatch(e, "configure"))
        root.bind_class("ASNButton", "<KeyPress-space>", lambda e: AppButton._dispatch(e, "key_press"))
        root.bind_class("ASNButton", "<KeyRelease-space>", lambda e: AppButton._dispatch(e, "key_release"))
        root.bind_class("ASNButton", "<KeyPress-Return>", lambda e: AppButton._dispatch(e, "key_press"))
        root.bind_class("ASNButton", "<KeyRelease-Return>", lambda e: AppButton._dispatch(e, "key_release"))

    @staticmethod
    def _dispatch(event, action):
        widget = event.widget
        if not isinstance(widget, AppButton):
            return None
        if action == "enter":
            widget._hover = widget._state != "disabled"
        elif action == "leave":
            widget._hover = False
            widget._pressed = False
        elif action == "press":
            if widget._state != "disabled":
                widget._pressed = True
                if widget._takefocus:
                    widget.focus_set()
        elif action == "release":
            should_invoke = widget._state != "disabled" and widget._pressed and widget._pointer_inside()
            widget._pressed = False
            if should_invoke:
                widget.invoke()
        elif action == "focus_in":
            widget._focused = True
        elif action == "focus_out":
            widget._focused = False
            widget._pressed = False
        elif action == "configure":
            widget._draw()
            return None
        elif action == "key_press":
            if widget._state != "disabled":
                widget._pressed = True
        elif action == "key_release":
            should_invoke = widget._state != "disabled" and widget._pressed
            widget._pressed = False
            if should_invoke:
                widget.invoke()
        widget._draw()
        return "break" if action.startswith("key_") else None

    def _pointer_inside(self):
        try:
            x = self.winfo_pointerx() - self.winfo_rootx()
            y = self.winfo_pointery() - self.winfo_rooty()
            return 0 <= x < self.winfo_width() and 0 <= y < self.winfo_height()
        except tk.TclError:
            return False

    # ---------- rendering ----------
    def _register_instance(self):
        store = getattr(self._toplevel, "_asn_buttons", None)
        if store is None:
            store = weakref.WeakSet()
            self._toplevel._asn_buttons = store
        store.add(self)

    def _set_image_spec(self, image, disabled_image=None):
        if isinstance(image, (tuple, list)) and len(image) >= 3 and str(image[1]) == "disabled":
            self._image = image[0]
            self._disabled_image = image[2]
        else:
            self._image = image
            self._disabled_image = disabled_image

    def _surface_color(self):
        if self._surface:
            name = str(self._surface).upper()
            aliases = {
                "HEADER": "HEADER_BG",
                "SURFACE": "SURFACE",
                "DIALOG": "SURFACE",
                "APP": "APP_BG",
            }
            return ui_theme.color(aliases.get(name, name))
        widget = self.master
        for _ in range(4):
            try:
                style = str(widget.cget("style") or "")
            except (tk.TclError, TypeError):
                style = ""
            if "Header" in style:
                return ui_theme.color("HEADER_BG")
            if any(token in style for token in ("Surface", "Dialog", "Card")):
                return ui_theme.color("SURFACE")
            if isinstance(widget, tk.Toplevel):
                return ui_theme.color("SURFACE")
            widget = getattr(widget, "master", None)
            if widget is None:
                break
        return ui_theme.color("APP_BG")

    def _palette(self):
        variant = self._variant
        dark = ui_theme.is_dark_theme(self._toplevel)
        default = {
            "bg": ui_theme.color("BUTTON_BG"),
            "hover": ui_theme.color("BUTTON_HOVER"),
            "pressed": ui_theme.color("BUTTON_ACTIVE"),
            "fg": ui_theme.color("INK"),
            "border": ui_theme.color("BORDER"),
            "disabled_bg": ui_theme.color("DISABLED_BG"),
            "disabled_fg": ui_theme.color("DISABLED_FG"),
            "disabled_border": ui_theme.color("BORDER"),
        }
        if variant == "primary":
            default.update(
                bg=ui_theme.color("ACCENT"), hover=ui_theme.color("ACCENT_HOVER"),
                pressed=ui_theme.color("ACCENT_ACTIVE"), fg="#ffffff",
                border=ui_theme.color("ACCENT"),
            )
        elif variant == "danger":
            default.update(
                fg=ui_theme.color("DANGER"),
                hover="#4a3435" if dark else "#f1dfdd",
                pressed="#563b3c" if dark else "#ead4d1",
            )
        elif variant == "header":
            default.update(border=ui_theme.color("BORDER_STRONG"))
        elif variant == "icon":
            default.update(border=ui_theme.color("BORDER_STRONG"))
        elif variant == "toggle_off":
            default.update(border=ui_theme.color("BORDER_STRONG"))
        elif variant == "toggle_on":
            default.update(
                bg="#355477" if dark else "#c8daf8",
                hover="#3d6089" if dark else "#bdd3f7",
                pressed="#2f4968" if dark else "#b3cdf5",
                fg=ui_theme.color("INK") if dark else "#153f93",
                border=ui_theme.color("ACCENT"),
            )
        elif variant == "window":
            default.update(
                bg=ui_theme.color("HEADER_BG"), hover=ui_theme.color("BUTTON_BG"),
                pressed=ui_theme.color("BUTTON_ACTIVE"), border=ui_theme.color("HEADER_BG"),
                disabled_bg=ui_theme.color("HEADER_BG"), disabled_border=ui_theme.color("HEADER_BG"),
            )
        elif variant == "close":
            default.update(
                bg=ui_theme.color("HEADER_BG"), hover="#c94b45", pressed="#b83d37",
                border=ui_theme.color("HEADER_BG"), disabled_bg=ui_theme.color("HEADER_BG"),
                disabled_border=ui_theme.color("HEADER_BG"),
            )
        return default

    def _font_for_variant(self):
        if self._variant in ("icon", "window", "close", "toggle_off", "toggle_on"):
            return ("Segoe UI Symbol", 11)
        return ui_theme.UI_FONT_SEMIBOLD

    def _apply_geometry(self):
        self._font = self._font_for_variant()
        font = tkfont.Font(master=self._toplevel, font=self._font)
        hpad = 8 if self._compact else 10
        if self._variant in ("icon", "window", "close", "toggle_off", "toggle_on"):
            hpad = 6
        vheight = self._fixed_height or (_COMPACT_HEIGHT if self._compact else _DEFAULT_HEIGHT)
        text_width = font.measure(self._text) if self._text else 0
        image = self._active_image()
        image_width = 0
        if image is not None:
            try:
                image_width = int(image.width())
            except (AttributeError, tk.TclError):
                image_width = 16
        gap = 5 if text_width and image_width and self._compound in ("left", "right") else 0
        natural = text_width + image_width + gap + hpad * 2
        if self._width_chars is not None:
            char_width = max(6, font.measure("0"))
            natural = max(natural, self._width_chars * char_width + hpad * 2)
        if not self._text and image_width:
            natural = max(natural, 34)
        natural = max(34, natural)
        super().configure(width=int(natural), height=int(vheight))

    def _active_image(self):
        if self._state == "disabled" and self._disabled_image is not None:
            return self._disabled_image
        return self._image

    def _color_rgb8(self, color):
        r, g, b = self.winfo_rgb(color)
        return r // 257, g // 257, b // 257

    @staticmethod
    def _inside_rounded_rect(px, py, x1, y1, x2, y2, radius):
        if px < x1 or py < y1 or px >= x2 or py >= y2:
            return False
        radius = max(0.0, min(float(radius), (x2 - x1) / 2.0, (y2 - y1) / 2.0))
        if radius <= 0.0:
            return True
        cx = min(max(px, x1 + radius), x2 - radius)
        cy = min(max(py, y1 + radius), y2 - radius)
        dx = px - cx
        dy = py - cy
        return dx * dx + dy * dy <= radius * radius

    def _button_surface_image(self, width, height, radius, fill, border, surface):
        """Return an antialiased rounded button bitmap.

        Tk Canvas ovals and rectangles do not rasterize to exactly the same
        pixels on Windows.  Building a 1 px border by painting an outer rounded
        shape and then an inner one therefore leaves asymmetric corner
        "feet".  Render the complete shape into one bitmap instead.
        """
        key = (int(width), int(height), int(radius), str(fill), str(border), str(surface))
        cached = self._surface_image_cache.get(key)
        if cached is not None:
            return cached

        width = max(2, int(width))
        height = max(2, int(height))
        radius = max(1.0, min(float(radius), width / 2.0, height / 2.0))
        inner = 1.0
        inner_radius = max(0.0, radius - inner)
        surface_rgb = self._color_rgb8(surface)
        border_rgb = self._color_rgb8(border)
        fill_rgb = self._color_rgb8(fill)
        palette = (surface_rgb, border_rgb, fill_rgb)

        # 4x4 supersampling is enough for a clean 1 px border at the control
        # sizes used here, while keeping redraw cost small.
        samples = (0.125, 0.375, 0.625, 0.875)
        rows = []
        for y in range(height):
            row = []
            for x in range(width):
                rr = gg = bb = count = 0
                for sy in samples:
                    py = y + sy
                    for sx in samples:
                        px = x + sx
                        if self._inside_rounded_rect(px, py, 0.0, 0.0, width, height, radius):
                            if self._inside_rounded_rect(
                                px, py, inner, inner, width - inner, height - inner, inner_radius
                            ):
                                color = palette[2]
                            else:
                                color = palette[1]
                        else:
                            color = palette[0]
                        rr += color[0]
                        gg += color[1]
                        bb += color[2]
                        count += 1
                row.append(
                    "#{:02x}{:02x}{:02x}".format(
                        round(rr / count), round(gg / count), round(bb / count)
                    )
                )
            rows.append("{" + " ".join(row) + "}")

        image = tk.PhotoImage(master=self._toplevel, width=width, height=height)
        image.put(" ".join(rows))
        # A button only has a handful of visual states.  Bound the cache in
        # case a parent repeatedly changes its requested size.
        if len(self._surface_image_cache) >= 12:
            self._surface_image_cache.clear()
        self._surface_image_cache[key] = image
        return image

    def _rounded_box(self, x1, y1, x2, y2, radius, fill, tag):
        r = max(1, min(radius, int((x2 - x1) / 2), int((y2 - y1) / 2)))
        self.create_rectangle(x1 + r, y1, x2 - r, y2, fill=fill, outline="", tags=tag)
        self.create_rectangle(x1, y1 + r, x2, y2 - r, fill=fill, outline="", tags=tag)
        self.create_oval(x1, y1, x1 + 2 * r, y1 + 2 * r, fill=fill, outline="", tags=tag)
        self.create_oval(x2 - 2 * r, y1, x2, y1 + 2 * r, fill=fill, outline="", tags=tag)
        self.create_oval(x1, y2 - 2 * r, x1 + 2 * r, y2, fill=fill, outline="", tags=tag)
        self.create_oval(x2 - 2 * r, y2 - 2 * r, x2, y2, fill=fill, outline="", tags=tag)

    def _draw(self):
        if not self.winfo_exists():
            return
        palette = self._palette()
        disabled = self._state == "disabled"
        if disabled:
            fill = palette["disabled_bg"]
            fg = palette["disabled_fg"]
            border = palette["disabled_border"]
        else:
            fill = palette["pressed"] if self._pressed else palette["hover"] if self._hover else palette["bg"]
            fg = "#ffffff" if self._variant == "close" and (self._hover or self._pressed) else palette["fg"]
            border = ui_theme.color("ACCENT") if self._focused and self._variant not in ("window", "close") else palette["border"]

        try:
            self.configure.__func__  # keep linters from mistaking Canvas.configure recursion below
            tk.Canvas.configure(self, background=self._surface_color(), cursor="" if disabled else self._cursor_normal)
            configured_w = max(2, int(float(self.cget("width"))))
            configured_h = max(2, int(float(self.cget("height"))))
            actual_w = max(1, int(self.winfo_width()))
            actual_h = max(1, int(self.winfo_height()))
            # Draw inside the real allocated Canvas size.  Painting to the
            # larger requested size can clip the right/bottom rounded edge.
            w = actual_w if actual_w > 1 else configured_w
            h = actual_h if actual_h > 1 else configured_h
        except (tk.TclError, ValueError, TypeError):
            return

        # Tk delivers <Configure> when a widget moves, not only when it grows, so
        # a window drag or a sash drag used to rebuild every button on the screen
        # for nothing.  Skip the rebuild unless something painted actually moved.
        active_image = self._active_image()
        signature = (int(w), int(h), str(fill), str(fg), str(border), self._state,
                     self._text, self._compound, id(active_image),
                     bool(self._hover), bool(self._pressed), bool(self._focused))
        if signature == self._draw_signature:
            return
        self._draw_signature = signature

        self.delete("all")

        # Draw border + fill as one antialiased bitmap. Tk's separate oval/
        # rectangle primitives round edge pixels differently on Windows, which
        # leaves the small "bitten" corner artifacts visible on icon buttons.
        try:
            surface_image = self._button_surface_image(
                w, h, self._radius, fill, border, self._surface_color()
            )
            self.create_image(0, 0, image=surface_image, anchor="nw", tags="button")
        except (tk.TclError, ValueError, TypeError):
            return

        image = self._active_image()
        text = self._text
        font = self._font_for_variant()
        if image is not None and text and self._compound in ("left", "right"):
            try:
                iw = int(image.width())
            except (AttributeError, tk.TclError):
                iw = 16
            tw = tkfont.Font(master=self._toplevel, font=font).measure(text)
            gap = 5
            total = iw + gap + tw
            left = (w - total) / 2
            if self._compound == "left":
                self.create_image(left + iw / 2, h / 2, image=image, anchor="center")
                self.create_text(left + iw + gap + tw / 2, h / 2, text=text, fill=fg, font=font, anchor="center")
            else:
                self.create_text(left + tw / 2, h / 2, text=text, fill=fg, font=font, anchor="center")
                self.create_image(left + tw + gap + iw / 2, h / 2, image=image, anchor="center")
        elif image is not None and not text:
            self.create_image(w / 2, h / 2, image=image, anchor="center")
        elif image is not None and self._compound in ("top", "bottom"):
            # Rare in this UI; keep one renderer rather than special-casing a widget.
            self.create_image(w / 2, h / 2 - 5, image=image, anchor="center")
            if text:
                self.create_text(w / 2, h / 2 + 8, text=text, fill=fg, font=font, anchor="center")
        else:
            self.create_text(w / 2, h / 2, text=text, fill=fg, font=font, anchor="center")

        self._sync_badge()

    def _sync_badge(self):
        """Add or remove the unread dot without rebuilding the button surface."""
        try:
            self.delete("badge")
        except tk.TclError:
            return
        if not self._badge:
            return
        try:
            configured_w = max(2, int(float(self.cget("width"))))
            actual_w = max(1, int(self.winfo_width()))
            w = actual_w if actual_w > 1 else configured_w
        except (tk.TclError, ValueError, TypeError):
            return
        radius = 5
        pad = 2
        x2 = w - pad
        y1 = pad
        fill = ui_theme.color("DANGER")
        ring = ui_theme.color("SURFACE")
        self.create_oval(
            x2 - 2 * radius,
            y1,
            x2,
            y1 + 2 * radius,
            fill=fill,
            outline=ring,
            width=1,
            tags="badge",
        )


def refresh_buttons(root):
    """Repaint every AppButton after the shared theme palette changes."""
    store = getattr(root, "_asn_buttons", None)
    if not store:
        return
    for button in list(store):
        try:
            button.refresh_theme(resize=False)
        except tk.TclError:
            pass
