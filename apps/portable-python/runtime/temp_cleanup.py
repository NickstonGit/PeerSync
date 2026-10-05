"""Bound the cache left by Bare standalone self-extraction on Windows.

`bare-build --standalone` embeds native DLLs in PSNCore.exe.  At runtime Bare
materialises those DLLs below the user's temporary directory using names such
as::

    PSNCore.exe-2f68892b06decb57197ca77967fd4f35ce3be264c7381a87eb477a4341647784

A new bundle id creates a new directory.  Bare owns creation of these caches;
PeerSync owns lifecycle hygiene around them so old development/release builds
do not accumulate indefinitely.

Cleanup is deliberately conservative:
* only direct children with the exact PSNCore.exe-<64 hex> shape are eligible;
* junctions/symlinks/reparse points are never traversed;
* nothing is touched while any PSNCore.exe process is running;
* one newest cache is retained to preserve warm-start behaviour.
"""

import os
import re
import shutil
import tempfile


_CACHE_NAME = re.compile(r"^PSNCore\.exe-[0-9a-fA-F]{64}$")
_FILE_ATTRIBUTE_REPARSE_POINT = 0x0400


def _is_reparse_or_link(path):
    try:
        if os.path.islink(path):
            return True
        isjunction = getattr(os.path, "isjunction", None)
        if isjunction is not None and isjunction(path):
            return True
        st = os.lstat(path)
        attrs = int(getattr(st, "st_file_attributes", 0) or 0)
        return bool(attrs & _FILE_ATTRIBUTE_REPARSE_POINT)
    except OSError:
        # An entry that cannot be inspected is not safe to remove.
        return True


def _candidate_dirs(temp_root):
    result = []
    try:
        names = os.listdir(temp_root)
    except OSError:
        return result

    for name in names:
        if not _CACHE_NAME.fullmatch(name):
            continue
        path = os.path.join(temp_root, name)
        try:
            if not os.path.isdir(path) or _is_reparse_or_link(path):
                continue
            st = os.stat(path, follow_symlinks=False)
        except OSError:
            continue
        result.append((int(st.st_mtime_ns), path))

    result.sort(key=lambda item: item[0], reverse=True)
    return result


def cleanup_psncore_temp(temp_root=None, keep=1, core_running=None):
    """Delete stale Bare PSNCore extraction caches.

    Returns a small diagnostics dict and never raises for cleanup failures.
    ``core_running`` is injectable for unit tests; in production it should be a
    callable returning True when any PSNCore.exe process exists system-wide.
    """
    root = os.path.abspath(temp_root or tempfile.gettempdir())
    keep = max(0, int(keep))
    result = {
        "root": root,
        "found": 0,
        "removed": 0,
        "failed": 0,
        "kept": 0,
        "skippedActiveCore": False,
        "freedBytes": 0,
    }

    try:
        if core_running is not None and bool(core_running()):
            result["skippedActiveCore"] = True
            return result
    except Exception:  # process-enumeration failure => fail closed
        result["skippedActiveCore"] = True
        return result

    candidates = _candidate_dirs(root)
    result["found"] = len(candidates)
    result["kept"] = min(keep, len(candidates))

    for _mtime, path in candidates[keep:]:
        # Re-check immediately before every deletion. Another PeerSync using a
        # different data root can start after the initial snapshot; stop at the
        # first sign of a live Core rather than racing its DLL extraction.
        if core_running is not None:
            try:
                if bool(core_running()):
                    result["skippedActiveCore"] = True
                    break
            except Exception:
                result["skippedActiveCore"] = True
                break
        size = _tree_size(path)
        try:
            shutil.rmtree(path)
        except (OSError, PermissionError):
            result["failed"] += 1
            continue
        result["removed"] += 1
        result["freedBytes"] += size

    return result


def _tree_size(root):
    total = 0
    try:
        for base, dirs, files in os.walk(root, topdown=True, followlinks=False):
            # Never descend through an unexpected reparse point that appeared
            # after the parent candidate was inspected.
            safe_dirs = []
            for name in dirs:
                path = os.path.join(base, name)
                if not _is_reparse_or_link(path):
                    safe_dirs.append(name)
            dirs[:] = safe_dirs
            for name in files:
                path = os.path.join(base, name)
                try:
                    total += os.path.getsize(path)
                except OSError:
                    pass
    except OSError:
        pass
    return total
