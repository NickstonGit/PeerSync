"""Materialise embedded non-executable assets (icon) from core_payload to disk
so Tk/Win32 APIs that need a path can consume them. Never touches %TEMP%;
writes under a real data/ subtree."""

import os

import core_payload


def ensure_icon(data_dir: str) -> str | None:
    """Return an existing on-disk path to PeerSync runtime icon or None."""
    if not getattr(core_payload, "ICO", b""):
        return None
    os.makedirs(data_dir, exist_ok=True)
    path = os.path.join(data_dir, core_payload.ICO_NAME)
    try:
        if os.path.exists(path) and os.path.getsize(path) == len(core_payload.ICO):
            with open(path, "rb") as fh:
                if fh.read() == core_payload.ICO:
                    return path
    except OSError:
        pass
    tmp = path + ".new"
    try:
        with open(tmp, "wb") as fh:
            fh.write(core_payload.ICO)
        os.replace(tmp, path)
        return path
    except OSError:
        try:
            os.remove(tmp)
        except OSError:
            pass
        return None


def ensure_wordmark(data_dir: str, name: str) -> str | None:
    payload = (getattr(core_payload, "WORDMARKS", {}) or {}).get(name, b"")
    if not payload:
        return None
    target_dir = os.path.join(data_dir, "ui-assets")
    os.makedirs(target_dir, exist_ok=True)
    path = os.path.join(target_dir, os.path.basename(name))
    try:
        if os.path.exists(path) and os.path.getsize(path) == len(payload):
            with open(path, "rb") as fh:
                if fh.read() == payload:
                    return path
    except OSError:
        pass
    tmp = path + ".new"
    try:
        with open(tmp, "wb") as fh:
            fh.write(payload)
        os.replace(tmp, path)
        return path
    except OSError:
        try:
            os.remove(tmp)
        except OSError:
            pass
        return None
