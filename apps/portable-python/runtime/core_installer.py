"""Install/verify the embedded PSNCore.exe into a stable data/runtime
path (firewall discipline).

The core binary is embedded in the frozen app as the bytes constant of the
`core_payload` module (PYZ), not as a separate extracted data file: Windows
onefile deferred-extraction makes raw reads of _MEIPASS data files unreliable
in this packaging setup, and this guarantees PSNCore.exe is never dropped
to (or run from) a random %TEMP% path. We stream the bytes to
`PSNCore.new`, verify SHA-256 over what we wrote, then atomically
replace the stable `data/runtime/PSNCore.exe`. Reinstall happens only
when the expected hash changes, so the firewall-visible path stays stable.
"""

import hashlib
import json
import os
import stat
import time


def _payload():
    import core_payload

    return core_payload


def install_core(dest_path):
    """Returns (installed_path, sha256, did_change)."""
    import core_payload  # provided next to app.py; bundled in PYZ when frozen

    expected = core_payload.CORE_SHA256
    data = core_payload.CORE
    src_hash = hashlib.sha256(data).hexdigest()
    if src_hash != expected:
        raise RuntimeError(
            "bundled core self-check failed: expected %s got %s" % (expected, src_hash)
        )
    if len(data) != core_payload.CORE_SIZE:
        raise RuntimeError("bundled core size mismatch")

    os.makedirs(os.path.dirname(dest_path), exist_ok=True)
    old = dest_path + ".old"
    tmp = dest_path + ".new"
    if os.path.exists(dest_path):
        try:
            if _hash_file(dest_path) == src_hash:
                # A previous successful commit may have left .old behind while
                # AV/indexing held the file. The fast path used to return before
                # ever retrying cleanup, so stale transaction files lived forever.
                _remove_stale(old)
                _remove_stale(tmp)
                return dest_path, src_hash, False
        except OSError:
            pass

    with open(tmp, "wb") as out:
        out.write(data)
        out.flush()
        os.fsync(out.fileno())
    if _hash_file(tmp) != src_hash:
        _remove_stale(tmp)
        raise RuntimeError("verification of copied core failed")

    # Recover an interrupted previous commit before touching the new payload.
    # If the working target vanished but .old survived, .old is the last known
    # good executable and must be restored first.
    if not os.path.exists(dest_path) and os.path.exists(old):
        try:
            os.replace(old, dest_path)
        except OSError as exc:
            _remove_stale(tmp)
            raise RuntimeError("не удалось восстановить предыдущую версию PSNCore.exe") from exc

    moved_old = False
    if os.path.exists(dest_path):
        try:
            os.replace(dest_path, old)
            moved_old = True
        except OSError as exc:
            _remove_stale(tmp)
            raise RuntimeError(
                "%s занят (скорее всего запущен другой PeerSync). "
                "Закройте приложение полностью и повторите." % os.path.basename(dest_path)
            ) from exc

    try:
        os.replace(tmp, dest_path)
    except OSError as exc:
        # The two os.replace calls are not one transaction. If committing the
        # new binary fails after the old one was moved away, restore the last
        # known-good target immediately.
        rollback_error = None
        if moved_old and os.path.exists(old):
            try:
                os.replace(old, dest_path)
            except OSError as rb_exc:
                rollback_error = rb_exc
        if os.path.exists(tmp):
            _remove_stale(tmp)
        if rollback_error is not None:
            raise RuntimeError(
                "не удалось установить новую версию Core и восстановить предыдущую"
            ) from rollback_error
        raise RuntimeError("не удалось установить новую версию PSNCore.exe; предыдущая восстановлена") from exc

    _remove_stale(old)
    return dest_path, src_hash, True


def _remove_stale(path, attempts=4):
    for attempt in range(attempts):
        try:
            os.remove(path)
            return True
        except FileNotFoundError:
            return True
        except PermissionError:
            # Windows AV/indexing and a stale read-only bit are both common on
            # freshly replaced executables. Make cleanup bounded but persistent.
            try:
                os.chmod(path, stat.S_IREAD | stat.S_IWRITE)
            except OSError:
                pass
            if attempt + 1 >= attempts:
                return False
            time.sleep(0.12 * (attempt + 1))
        except OSError:
            return False
    return False


def _hash_file(path):

    last = None
    for _attempt in range(10):
        try:
            h = hashlib.sha256()
            with open(path, "rb") as fh:
                for chunk in iter(lambda: fh.read(1 << 20), b""):
                    h.update(chunk)
            return h.hexdigest()
        except PermissionError as exc:
            last = exc
            time.sleep(1.0)
    raise last


# kept for harness compatibility / diagnostics
def sha256_file(path):
    return _hash_file(path)


def write_runtime_manifest(dest_path, installed_hash, did_change):
    manifest = os.path.join(os.path.dirname(dest_path), "runtime-manifest.json")
    tmp = manifest + ".tmp"
    payload = {
        "coreSha256": installed_hash,
        "sizeBytes": os.path.getsize(dest_path),
        "changed": did_change,
    }
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(payload, fh, indent=2)
        fh.flush()
        os.fsync(fh.fileno())
    os.replace(tmp, manifest)
