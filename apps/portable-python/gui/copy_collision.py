"""Detect copy name collisions and apply the user's replace/skip decision."""

from gui.i18n import t
from gui.sync_paths import basename_rel, join_rel

_NAME_LIMIT = 8
_DIR_TYPES = {"dir", "folder", "directory"}


def entry_basename(entry):
    name = str((entry or {}).get("name") or "").strip()
    if name:
        return name
    return basename_rel((entry or {}).get("relativePath") or "")


def name_key(name):
    return str(name or "").casefold()


def entry_kind(entry):
    kind = str((entry or {}).get("type") or "file").lower()
    if kind in _DIR_TYPES:
        return "dir"
    if kind == "link":
        return "link"
    return "file"


def types_incompatible(source, dest):
    left = entry_kind(source)
    right = entry_kind(dest)
    if left == "link" or right == "link":
        return True
    return left != right


def dest_stat_target(dest, name):
    target = dict(dest or {})
    target["relativePath"] = join_rel(dest.get("relativePath") if dest else "", name)
    return target


def copy_items_for_panel(is_local, peer_id, root_id, entries):
    return [
        {
            "source": {
                "peerId": None if is_local else peer_id,
                "rootId": root_id,
                "relativePath": (entry or {}).get("relativePath") or "",
            }
        }
        for entry in entries or []
    ]


def find_copy_collisions(selected, dest_entries):
    dest_map = {}
    for dest in dest_entries or []:
        name = entry_basename(dest)
        if name:
            dest_map[name_key(name)] = dest
    collisions = []
    for source in selected or []:
        name = entry_basename(source)
        if not name:
            continue
        dest = dest_map.get(name_key(name))
        if dest is not None:
            collisions.append({"source": source, "dest": dest, "name": name})
    return collisions


def split_replaceable(collisions):
    replaceable = []
    blocked = []
    for collision in collisions or []:
        if types_incompatible(collision.get("source"), collision.get("dest")):
            blocked.append(collision)
        else:
            replaceable.append(collision)
    return replaceable, blocked


def apply_copy_decision(selected, collisions, decision):
    if decision not in ("overwrite", "skip"):
        return None
    blocked_keys = {
        name_key(collision["name"])
        for collision in collisions or []
        if types_incompatible(collision.get("source"), collision.get("dest"))
    }
    collide_keys = {name_key(collision["name"]) for collision in collisions or []}
    skip_keys = blocked_keys if decision == "overwrite" else collide_keys
    kept = [
        entry
        for entry in selected or []
        if name_key(entry_basename(entry)) not in skip_keys
    ]
    return {
        "entries": kept,
        "collision": "overwrite" if decision == "overwrite" else "rename",
        "empty": not kept,
    }


def _names_text(collisions):
    names = [collision["name"] for collision in collisions or [] if collision.get("name")]
    if not names:
        return ""
    if len(names) == 1:
        return t("copy_exists_one", name=names[0])
    quoted = ", ".join("«%s»" % name for name in names[:_NAME_LIMIT])
    extra = len(names) - min(len(names), _NAME_LIMIT)
    if extra:
        return t("copy_exists_more", names=quoted, count=extra)
    return t("copy_exists_many", names=quoted)


def collision_prompt(collisions):
    replaceable, blocked = split_replaceable(collisions)
    kinds = {entry_kind(collision.get("source")) for collision in replaceable}
    if not replaceable:
        hint = t("copy_exists_hint")
    elif kinds == {"dir"}:
        hint = t("copy_exists_hint_dir")
    elif "dir" in kinds:
        hint = t("copy_exists_hint_mixed")
    else:
        hint = t("copy_exists_hint")
    mismatch = ""
    if len(blocked) == 1:
        mismatch = t("copy_exists_type_mismatch", name=blocked[0]["name"])
    elif blocked:
        mismatch = t("copy_exists_type_mismatch_many", count=len(blocked))
    return {
        "replaceable": replaceable,
        "blocked": blocked,
        "body": _names_text(collisions),
        "hint": hint,
        "mismatch": mismatch,
        "can_replace": bool(replaceable),
    }


def shift_is_down():
    try:
        import ctypes
        return bool(ctypes.windll.user32.GetAsyncKeyState(0x10) & 0x8000)
    except (AttributeError, OSError, ValueError):
        return False
