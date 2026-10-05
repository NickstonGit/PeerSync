"""Resolve sync endpoints from two-panel selection (same mapping as copy)."""


def join_rel(base, tail):
    base = (base or "").replace("\\", "/").strip("/")
    tail = (tail or "").replace("\\", "/").strip("/")
    if not base:
        return tail
    if not tail:
        return base
    return "%s/%s" % (base, tail)


def basename_rel(path):
    p = (path or "").replace("\\", "/").strip("/")
    i = p.rfind("/")
    return p if i < 0 else p[i + 1 :]


_DIR_TYPES = {"dir", "folder", "directory"}


def dir_entry(relative_path, name=None):
    rel = (relative_path or "").replace("\\", "/").strip("/")
    return {
        "type": "dir",
        "relativePath": rel,
        "name": name or basename_rel(rel) or rel or "/",
    }


def _dirs_and_files(entries):
    dirs = []
    files = []
    for entry in list(entries or []):
        if not entry:
            continue
        kind = str(entry.get("type") or "").lower()
        if kind in _DIR_TYPES:
            dirs.append(entry)
        else:
            files.append(entry)
    return dirs, files


def format_selection(entries):
    dirs, files = _dirs_and_files(entries)
    parts = []
    if dirs:
        names = ", ".join((d.get("name") or d.get("relativePath") or "?") for d in dirs[:3])
        extra = "…" if len(dirs) > 3 else ""
        if len(dirs) == 1:
            parts.append("папка %s" % names)
        else:
            parts.append("%d папки (%s%s)" % (len(dirs), names, extra))
    if files:
        if len(files) == 1:
            parts.append("файл %s" % (files[0].get("name") or files[0].get("relativePath") or "?"))
        else:
            parts.append("%d файла" % len(files))
    if parts:
        return " и ".join(parts)
    if entries:
        return "%d элемент(ов)" % len(entries)
    return "ничего"


def _one_dir(entries):
    dirs, _files = _dirs_and_files(entries)
    if len(dirs) == 1:
        return dirs[0].get("relativePath") or ""
    return None


def pick_sync_source_entries(selected, overlay_entry=None, cwd=""):
    """Prefer the selected folder; otherwise the overlay row or current folder."""
    selected = list(selected or [])
    if _one_dir(selected) is not None:
        return selected
    dirs, _files = _dirs_and_files(selected)
    if len(dirs) > 1:
        return selected
    overlay = dict(overlay_entry or {})
    overlay_rel = str(overlay.get("relativePath") or overlay.get("name") or "").strip("/")
    if overlay_rel:
        overlay["type"] = "dir"
        overlay["relativePath"] = overlay.get("relativePath") or overlay_rel
        if not overlay.get("name"):
            overlay["name"] = basename_rel(overlay["relativePath"])
        return [overlay]
    cwd_rel = (cwd or "").replace("\\", "/").strip("/")
    if cwd_rel:
        return [dir_entry(cwd_rel)]
    return selected


def resolve_sync_pair(src_entries, dest_cwd, dest_entries):
    """Map two-panel state to (sourceRel, destRel, errorKey).

    Source is the selected folder, like Copy. Extra selected files are ignored.
    Destination is the selected folder on the other panel, or dest CWD plus
    the source folder name.
    """
    src_rel = _one_dir(src_entries)
    if src_rel is None:
        return None, None, "sync_need_folder"
    dest_rel = _one_dir(dest_entries)
    if dest_rel is None:
        dest_rel = join_rel(dest_cwd, basename_rel(src_rel))
    return src_rel, dest_rel, None
