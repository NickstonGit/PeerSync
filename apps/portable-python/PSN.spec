# -*- mode: python ; coding: utf-8 -*-
import os
from pathlib import Path, PurePosixPath
from zipfile import ZipFile
from PyInstaller.utils.hooks.tcl_tk import tcltk_info

# Tcl/Tk 9 stores its scripts in ZIP overlays on the DLLs. Collect them as
# explicit data too: binary processing must not make GUI startup depend on
# preserving/loading those overlays after relocation into a onefile bundle.
embedded_tk_datas = []
for library, prefix, destination in (
    (tcltk_info.tcl_shared_library, 'tcl_library', '_tcl_data'),
    (tcltk_info.tk_shared_library, 'tk_library', '_tk_data'),
):
    if not library:
        continue
    data_dir = tcltk_info.tcl_data_dir if prefix == 'tcl_library' else tcltk_info.tk_data_dir
    if not data_dir or not data_dir.startswith('//zipfs:/'):
        continue
    from PyInstaller.config import CONF
    extracted = Path(CONF['workpath']) / 'embedded-tk' / prefix
    with ZipFile(library) as archive:
        for member in archive.infolist():
            parts = PurePosixPath(member.filename).parts
            if member.is_dir() or not parts or parts[0] != prefix:
                continue
            if '..' in parts or any(':' in part or '\\' in part for part in parts):
                raise ValueError('Invalid embedded Tcl/Tk archive path')
            relative = Path(*parts[1:])
            target = extracted / relative
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(archive.read(member))
            embedded_tk_datas.append((str(target), str(Path(destination) / relative.parent)))

spec_root = os.path.dirname(os.path.abspath(SPEC))
icon = os.path.join(spec_root, "assets", "peersync.ico")
if not os.path.isfile(icon):
    icon = None

wordmark_light = os.path.join(spec_root, "assets", "peersync-wordmark-light.png")
wordmark_dark = os.path.join(spec_root, "assets", "peersync-wordmark-dark.png")
wordmark_datas = [
    (path, "assets")
    for path in (wordmark_light, wordmark_dark)
    if os.path.isfile(path)
]
ui_icons_dir = os.path.join(spec_root, "assets", "ui-icons")
ui_icon_datas = []
if os.path.isdir(ui_icons_dir):
    ui_icon_datas.append((ui_icons_dir, os.path.join("assets", "ui-icons")))

a = Analysis(
    [os.path.join(spec_root, "app.py")],
    pathex=[spec_root],
    binaries=[],
    datas=wordmark_datas + ui_icon_datas + embedded_tk_datas,
    hiddenimports=["core_payload", "build_info", "runtime.updater"],
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[],
    noarchive=False,
)
pyz = PYZ(a.pure)
exe = EXE(
    pyz,
    a.scripts,
    a.binaries,
    a.datas,
    [],
    name="PSN",
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,
    console=False,
    disable_windowed_traceback=False,
    icon=icon,
)
