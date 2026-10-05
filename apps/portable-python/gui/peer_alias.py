"""Local nicknames for remembered peers. Empty alias falls back to the computer name."""

import json
import os
import time

from windows import paths

_MAX_ALIAS = 255


class PeerAliasDataError(RuntimeError):
    """Alias storage exists but cannot be trusted as an empty alias set."""


def peer_aliases_path():
    return os.path.join(paths.data_root(), "peer-aliases.json")


def _quarantine_corrupt_alias_file(path):
    stamp = time.strftime("%Y%m%d-%H%M%S")
    quarantined = "%s.corrupt-%s" % (path, stamp)
    try:
        os.replace(path, quarantined)
        return quarantined
    except OSError:
        return None


def _corrupt(path, reason):
    quarantined = _quarantine_corrupt_alias_file(path)
    suffix = ""
    if quarantined:
        suffix = "; сохранена копия: %s" % quarantined
    raise PeerAliasDataError("Файл локальных имён устройств повреждён (%s)%s" % (reason, suffix))


def load_peer_aliases():
    path = peer_aliases_path()
    try:
        with open(path, encoding="utf-8") as fh:
            raw = json.load(fh)
    except FileNotFoundError:
        return {}
    except (ValueError, UnicodeError) as exc:
        _corrupt(path, exc.__class__.__name__)
    except OSError as exc:
        raise PeerAliasDataError("Не удалось прочитать локальные имена устройств: %s" % exc) from exc

    if not isinstance(raw, dict):
        _corrupt(path, "ожидался JSON-объект")

    out = {}
    for key, value in raw.items():
        if not isinstance(key, str) or not isinstance(value, str):
            _corrupt(path, "ключи и значения должны быть строками")
        peer_id = key.strip().lower()
        alias = value.strip()[:_MAX_ALIAS]
        if peer_id and alias:
            out[peer_id] = alias
    return out


def save_peer_aliases(aliases):
    path = peer_aliases_path()
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = path + ".tmp"
    payload = json.dumps(aliases or {}, ensure_ascii=False, indent=2, sort_keys=True)
    with open(tmp, "w", encoding="utf-8") as fh:
        fh.write(payload)
        fh.flush()
        try:
            os.fsync(fh.fileno())
        except OSError:
            pass
    os.replace(tmp, path)


def peer_device_name(peer):
    return str((peer or {}).get("name") or "").strip() or str((peer or {}).get("id") or "")[:12]


def normalize_peer_alias(text, device_name=""):
    alias = str(text or "").strip()[:_MAX_ALIAS]
    device = str(device_name or "").strip()
    if not alias or alias == device:
        return ""
    return alias


def set_peer_alias(aliases, peer_id, text, device_name=""):
    next_aliases = dict(aliases or {})
    key = str(peer_id or "").lower()
    if not key:
        return next_aliases
    alias = normalize_peer_alias(text, device_name)
    if alias:
        next_aliases[key] = alias
    else:
        next_aliases.pop(key, None)
    return next_aliases


def peer_display_name(peer, aliases=None):
    peer_id = str((peer or {}).get("id") or "").lower()
    alias = str((aliases or {}).get(peer_id) or "").strip()
    return alias or peer_device_name(peer)
