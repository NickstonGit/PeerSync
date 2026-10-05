"""Shared design tokens for the portable PeerSync UI.

Screens should not invent geometry values for common controls.  The component
layer consumes these tokens so spacing, heights and radii can be changed once.
"""

# Control geometry
CONTROL_HEIGHT = 30
CONTROL_HEIGHT_COMPACT = 28
CONTROL_RADIUS = 8
CONTROL_BORDER = 1
ICON_BUTTON_WIDTH_CHARS = 3

# Spacing scale
SPACE_XS = 3
SPACE_S = 5
SPACE_M = 7
SPACE_L = 10
SPACE_XL = 12

# Shared paddings
FRAME_PADDING = (12, 8)
CARD_PADDING = (10, 7)
STATUS_PADDING = (8, 1)
ENTRY_PADDING = (9, 1)
CODE_ENTRY_PADDING = (10, 2)
LABELFRAME_CAPTION_PADDING = (9, 0, 4, 2)

# Typography
UI_FONT = ("Segoe UI", 11)
UI_FONT_SEMIBOLD = ("Segoe UI Semibold", 11)
SMALL_FONT = ("Segoe UI", 10)
SMALL_FONT_SEMIBOLD = ("Segoe UI Semibold", 10)
TINY_FONT = ("Segoe UI", 9)
MONO_SMALL_FONT = ("Consolas", 10)
TITLE_FONT = ("Segoe UI Semibold", 23)
BRAND_BYLINE_FONT = ("Segoe UI", 9)
HEADER_META_FONT = ("Segoe UI", 10)
WINDOW_CONTROL_FONT = ("Segoe UI Symbol", 12)
SECTION_FONT = ("Segoe UI Semibold", 11)
DIALOG_TITLE_FONT = ("Segoe UI Semibold", 15)
CODE_FONT = ("Consolas", 11)
