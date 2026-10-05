"""Stable Windows paths (portable data contract).

Never use cwd or PyInstaller's temp extraction dir for persistent data.
`dataRoot = dirname(real exe) / data` so PSN.exe + data/ stay together.
For a PyInstaller onefile build, sys.executable is the launcher EXE itself, so
dirname(sys.executable) points at the real user-visible location (not _MEIPASS).
"""

import os
import sys


def is_frozen():
    return bool(getattr(sys, "frozen", False))


def launcher_dir():
    """Directory containing the user-facing PSN.exe (stable across runs)."""
    if is_frozen():
        # sys.executable is the outer launcher EXE, not sys._MEIPASS temp dir.
        return os.path.dirname(os.path.abspath(sys.executable))
    # dev run: apps/portable-python/app.py -> repo root is 3 levels up
    here = os.path.dirname(os.path.abspath(__file__))
    return os.path.abspath(os.path.join(here, "..", "..", ".."))


def data_root():
    return os.path.join(launcher_dir(), "data")


def runtime_dir():
    return os.path.join(data_root(), "runtime")


def core_path():
    return os.path.join(runtime_dir(), "PSNCore.exe")


def logs_dir():
    return os.path.join(data_root(), "logs")


def rotate_log_files(log_path, max_bytes=5 * 1024 * 1024, backups=3, force=False):
    """Best-effort bounded rotation for shell-owned diagnostic logs."""
    try:
        if not os.path.exists(log_path) or (not force and os.path.getsize(log_path) < max_bytes):
            return False
        oldest = "%s.%d" % (log_path, backups)
        try:
            os.remove(oldest)
        except FileNotFoundError:
            pass
        for index in range(backups - 1, 0, -1):
            src = "%s.%d" % (log_path, index)
            dst = "%s.%d" % (log_path, index + 1)
            if os.path.exists(src):
                os.replace(src, dst)
        os.replace(log_path, log_path + ".1")
        return True
    except OSError:
        return False


def security_dir():
    return os.path.join(data_root(), "security")


def identity_dpapi_path():
    return os.path.join(security_dir(), "identity.dpapi")


def core_log_path():
    return os.path.join(logs_dir(), "core.log")


def runtime_icon_path():
    return os.path.join(runtime_dir(), "peersync.ico")


def layout():
    for d in (
        data_root(),
        runtime_dir(),
        logs_dir(),
        security_dir(),
        os.path.join(data_root(), "chat"),
        os.path.join(data_root(), "journals"),
        os.path.join(data_root(), "update"),
    ):
        yield d


def ensure_layout():
    """Create data tree or raise with a portable-friendly message."""
    try:
        for d in layout():
            os.makedirs(d, exist_ok=True)
        probe = os.path.join(data_root(), ".writeable")
        with open(probe, "w", encoding="utf-8") as fh:
            fh.write("ok")
        os.remove(probe)
    except OSError as exc:
        raise RuntimeError(
            "Не удалось создать или записать каталог данных рядом с PSN.exe: "
            f"{data_root()} ({exc}). Папка с программой должна быть доступна для записи. "
            "Скопируйте PSN.exe в доступную для записи папку."
        ) from exc
