"""Portable peer-to-peer launcher updates, with no registry or autostart writes.

The known-good helper publishes a durable transaction beside PSN.exe and arms
an acknowledged detached watchdog before replacement. The watchdog rolls back
an unconfirmed candidate in the current session. After reboot, recovery starts
only when the user next launches the application or the known-good helper.
A candidate that cannot start after reboot can be restored from PSN.exe.bak.
"""

from datetime import date
import hashlib
import json
import os

from runtime.compat import UPDATE_MANIFEST_SCHEMA, UPDATE_MANIFEST_SCHEMAS
import re
import secrets
import shutil
import subprocess
import sys
import time

from windows import paths

_SHA_CHUNK = 1024 * 1024
_BUILD_LABEL_RE = re.compile(r"^(?:n-)?(\d{2})(\d{2})(\d{2})$", re.IGNORECASE)
_NEW_BUILD_LABEL_RE = re.compile(r"^\d{6}$")
_LEGACY_BUILD_LABEL_RE = re.compile(r"^n-\d{6}$", re.IGNORECASE)

_PENDING_SCHEMA = "peersync-update-pending-v1"
_PENDING_FILE_NAME = "update-pending.json"
_PENDING_TOKEN_RE = re.compile(r"^[0-9a-f]{32,64}$")
# The helper's own readiness window is bounded (readiness timeout + stabilization),
# so an independent recovery must never act before that window has passed.
_PENDING_GRACE_SECONDS = 240.0
_WATCHDOG_TIMEOUT_SECONDS = 300.0
# Starting the watchdog proves nothing. The helper must read and validate the
# concrete transaction and acknowledge it before the commit may destroy the
# known-good launcher, so arming has its own bounded handshake. The helper is a
# onefile copy of the launcher, so this also covers its start-up extraction.
_WATCHDOG_ARM_TIMEOUT_SECONDS = 30.0
# A manually launched recovery helper uses a bounded remaining grace window.
_STARTUP_RECOVERY_MAX_WAIT_SECONDS = 60.0
_MAX_RECOVERY_WAIT_SECONDS = 900.0
_WATCHDOG_ARMED_SUFFIX = "-armed"
# Bound the machine-orderable release revision so it can never be confused with
# a value parsed out of an untrusted update advertisement.
_MAX_RELEASE_REVISION = 100000000


def version_tuple(value):
    main = str(value or "").strip().split("+", 1)[0].split("-", 1)[0]
    parts = main.split(".")
    if not 1 <= len(parts) <= 4 or any(not part.isdigit() for part in parts):
        return None
    return tuple(int(part) for part in parts)


def _build_label_line(value):
    label = str(value or "").strip()
    if _NEW_BUILD_LABEL_RE.fullmatch(label):
        return "peersync"
    if _LEGACY_BUILD_LABEL_RE.fullmatch(label):
        return "legacy"
    return "other"


def _crosses_release_line(candidate, current):
    left = _build_label_line(candidate)
    right = _build_label_line(current)
    return {left, right} == {"peersync", "legacy"}


def parse_build_label(value):
    # n-DDMMYY remains readable only for pre-PeerSync test-build compatibility.
    match = _BUILD_LABEL_RE.fullmatch(str(value or "").strip())
    if not match:
        return None
    day = int(match.group(1))
    month = int(match.group(2))
    year = 2000 + int(match.group(3))
    try:
        date(year, month, day)
    except ValueError:
        return None
    return (year, month, day)


def _compare_tuples(left, right):
    width = max(len(left), len(right))
    padded_left = left + (0,) * (width - len(left))
    padded_right = right + (0,) * (width - len(right))
    if padded_left > padded_right:
        return 1
    if padded_left < padded_right:
        return -1
    return 0


def compare_build_labels(candidate, current):
    if _crosses_release_line(candidate, current):
        return 0
    left = parse_build_label(candidate)
    right = parse_build_label(current)
    if left is None and right is None:
        return 0
    if left is None:
        return -1
    if right is None:
        return 1
    return _compare_tuples(left, right)


def parse_release_revision(value):
    """Monotonic within-day release revision; 0 when the field is absent.

    The public DDMMYY label stays unchanged in the UI.  A revision is the
    machine-orderable identity that lets two different official builds share one
    calendar date without becoming indistinguishable to update ordering.
    """
    if value is None or isinstance(value, bool):
        return 0
    if isinstance(value, int):
        revision = value
    elif isinstance(value, str):
        text = value.strip()
        if not text.isdigit():
            return 0
        revision = int(text)
    else:
        return 0
    if 0 <= revision < _MAX_RELEASE_REVISION:
        return revision
    return 0


def compare_release_revisions(candidate, current):
    return _compare_tuples((parse_release_revision(candidate),), (parse_release_revision(current),))


def compare_release(
    candidate_version, candidate_build, current_version, current_build,
    candidate_revision=0, current_revision=0,
):
    # PeerSync DDMMYY is a separate product version lineage. Do not rank legacy
    # n-DDMMYY builds against new DDMMYY builds by inherited semver.
    if _crosses_release_line(candidate_build, current_build):
        return 0
    for label in (candidate_build, current_build):
        if _build_label_line(label) != "other" and parse_build_label(label) is None:
            return 0
    left = version_tuple(candidate_version)
    right = version_tuple(current_version)
    if left is None or right is None:
        return 0
    by_version = _compare_tuples(left, right)
    if by_version:
        return by_version
    by_label = compare_build_labels(candidate_build, current_build)
    if by_label:
        return by_label
    # Same product version and same calendar date: the revision decides. A
    # missing/unparseable label is outside the PeerSync DDMMYY lineage, so it
    # keeps the historical "not comparable" result of 0.
    if not (_NEW_BUILD_LABEL_RE.fullmatch(str(candidate_build or "").strip())
            and _NEW_BUILD_LABEL_RE.fullmatch(str(current_build or "").strip())):
        return 0
    return compare_release_revisions(candidate_revision, current_revision)


def is_newer_version(candidate, current):
    return compare_release(candidate, "", current, "") > 0


def is_newer_release(
    candidate_version, candidate_build, current_version, current_build,
    candidate_revision=0, current_revision=0,
):
    return compare_release(
        candidate_version, candidate_build, current_version, current_build,
        candidate_revision, current_revision,
    ) > 0


def comparable_app_version(app_version, build_label):
    """Old cores compare only appVersion. Fold DDMMYY (or legacy n-DDMMYY) into a 4th semver part."""
    parts = version_tuple(app_version)
    if not parts:
        return str(app_version or "0.0.0")
    if len(parts) >= 4:
        return ".".join(str(part) for part in parts)
    parsed = parse_build_label(build_label)
    if not parsed:
        return ".".join(str(part) for part in parts)
    padded = list(parts) + [0] * max(0, 3 - len(parts))
    year, month, day = parsed
    stamp = year * 10000 + month * 100 + day
    return "%d.%d.%d.%d" % (padded[0], padded[1], padded[2], stamp)


def best_available_update(peers, current_version, current_build, preferred_peer_id=None, current_revision=0):
    """Pick the newest offerable update among online peers."""
    preferred = str(preferred_peer_id or "").lower()
    best = None
    for peer in peers or []:
        if not (peer or {}).get("online"):
            continue
        update = (peer or {}).get("update") or {}
        if not isinstance(update, dict):
            continue
        if not update.get("available") or not update.get("compatible"):
            continue
        if not update.get("trustedSource"):
            continue
        if update.get("signatureRequired") is True and not update.get("signatureVerified"):
            continue
        version = str(update.get("appVersion") or update.get("version") or "")
        build = str(update.get("buildLabel") or "")
        revision = parse_release_revision(update.get("releaseRevision"))
        if not is_newer_release(version, build, current_version, current_build, revision, current_revision):
            continue
        candidate = dict(update)
        candidate["peerId"] = str((peer or {}).get("id") or "").lower()
        candidate["appVersion"] = version
        candidate["buildLabel"] = build
        candidate["releaseRevision"] = revision
        if not candidate["peerId"]:
            continue
        if best is None:
            best = candidate
            continue
        cmp = compare_release(
            version, build, best.get("appVersion"), best.get("buildLabel"),
            revision, best.get("releaseRevision", 0),
        )
        if cmp > 0:
            best = candidate
        elif cmp == 0 and preferred and candidate["peerId"] == preferred:
            best = candidate
    return best


def release_label(version, build):
    version = str(version or "").strip()
    build = str(build or "").strip()
    # New PeerSync product versions are dates only. appVersion is a protocol
    # compatibility field and must not leak into user-facing version labels.
    if _NEW_BUILD_LABEL_RE.fullmatch(build):
        return build
    if version and build:
        return "%s %s" % (version, build)
    return build or version


def update_check_summary(peers, current_version, current_build, current_revision=0):
    """Classify the latest peer update hello: offer, none, no_info, or blocked."""
    offer = best_available_update(peers, current_version, current_build, None, current_revision)
    if offer:
        return "offer", offer
    online = False
    reported = []
    blocked = None
    for peer in peers or []:
        if not (peer or {}).get("online"):
            continue
        online = True
        update = (peer or {}).get("update") or {}
        if not isinstance(update, dict):
            continue
        version = str(update.get("appVersion") or update.get("version") or "")
        if not version:
            continue
        item = dict(update)
        item["peerId"] = str((peer or {}).get("id") or "").lower()
        item["appVersion"] = version
        item["buildLabel"] = str(update.get("buildLabel") or "")
        item["releaseRevision"] = parse_release_revision(update.get("releaseRevision"))
        reported.append(item)
        if not is_newer_release(
            version, item["buildLabel"], current_version, current_build,
            item["releaseRevision"], current_revision,
        ):
            continue
        if not blocked:
            if not update.get("compatible"):
                blocked = ("incompatible", item)
            elif update.get("available") and update.get("signatureRequired") is True and not update.get("signatureVerified"):
                blocked = ("unverified", item)
            elif update.get("available") and not update.get("trustedSource"):
                blocked = ("untrusted_source", item)
            elif not update.get("available"):
                blocked = ("newer_unavailable", item)
    if not online:
        return None, None
    if blocked:
        return blocked
    if not reported:
        return "no_info", None
    newest = reported[0]
    for item in reported[1:]:
        if compare_release(
            item["appVersion"], item["buildLabel"], newest["appVersion"], newest["buildLabel"],
            item["releaseRevision"], newest["releaseRevision"],
        ) > 0:
            newest = item
    return "none", newest


def sha256_file(file_path):
    digest = hashlib.sha256()
    size = 0
    with open(file_path, "rb") as fh:
        while True:
            chunk = fh.read(_SHA_CHUNK)
            if not chunk:
                break
            digest.update(chunk)
            size += len(chunk)
    return digest.hexdigest(), size


def verify_staged_update(file_path, expected_size, expected_sha256):
    path = os.path.abspath(str(file_path or ""))
    expected_hash = str(expected_sha256 or "").lower()
    try:
        expected_size = int(expected_size)
    except (TypeError, ValueError) as exc:
        raise RuntimeError("Некорректный размер обновления") from exc
    if expected_size <= 0 or len(expected_hash) != 64:
        raise RuntimeError("Некорректные метаданные обновления")
    if not os.path.isfile(path):
        raise RuntimeError("Файл обновления не найден")

    # Core is allowed to stage updates only inside data/update.  Re-check here
    # before a privileged replace so an IPC bug cannot turn updater into an
    # arbitrary local-file installer.
    update_root = os.path.normcase(os.path.realpath(os.path.abspath(os.path.join(paths.data_root(), "update"))))
    resolved_path = os.path.realpath(path)
    candidate = os.path.normcase(resolved_path)
    try:
        inside_staging = os.path.commonpath([update_root, candidate]) == update_root
    except ValueError:
        inside_staging = False
    if not inside_staging:
        raise RuntimeError("Файл обновления находится вне каталога staging")

    actual_hash, actual_size = sha256_file(resolved_path)
    if actual_size != expected_size:
        raise RuntimeError("Размер полученного обновления не совпадает")
    if actual_hash.lower() != expected_hash:
        raise RuntimeError("SHA-256 полученного обновления не совпадает")
    return resolved_path


def _validate_update_manifest(manifest, expected_size, expected_sha256):
    if not isinstance(manifest, dict) or manifest.get("schema") not in UPDATE_MANIFEST_SCHEMAS:
        raise RuntimeError("Некорректный manifest обновления")
    try:
        size = int(manifest.get("size") or 0)
    except (TypeError, ValueError) as exc:
        raise RuntimeError("Некорректный размер в manifest обновления") from exc
    sha256 = str(manifest.get("sha256") or "").lower()
    signature = str(manifest.get("signature") or "").lower()
    public_key = str(manifest.get("publicKey") or "").lower()
    if size != int(expected_size) or sha256 != str(expected_sha256 or "").lower():
        raise RuntimeError("Manifest обновления не соответствует staged executable")
    if len(signature) != 128 or any(ch not in "0123456789abcdef" for ch in signature):
        raise RuntimeError("Некорректная подпись в manifest обновления")
    if len(public_key) != 64 or any(ch not in "0123456789abcdef" for ch in public_key):
        raise RuntimeError("Некорректный public key в manifest обновления")
    if not str(manifest.get("appVersion") or "") or not str(manifest.get("buildLabel") or ""):
        raise RuntimeError("Manifest обновления не содержит версию сборки")
    if not str(manifest.get("platform") or ""):
        raise RuntimeError("Manifest обновления не содержит платформу")
    if "releaseRevision" in manifest:
        revision = parse_release_revision(manifest.get("releaseRevision"))
        if revision == 0 and str(manifest.get("releaseRevision") or "").strip() not in ("", "0"):
            raise RuntimeError("Некорректный releaseRevision в manifest обновления")
    return dict(manifest)


def _write_staged_update_manifest(staged, manifest):
    path = staged + ".update.json"
    tmp = path + ".tmp"
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(tmp, "w", encoding="utf-8", newline="\n") as fh:
        json.dump(manifest, fh, ensure_ascii=False, indent=2, sort_keys=True)
        fh.write("\n")
        fh.flush()
        os.fsync(fh.fileno())
    os.replace(tmp, path)
    return path


def launch_staged_update(
    file_path, expected_size, expected_sha256, *,
    app_version, build_label, platform, signature, public_key, signature_required=False,
    release_revision=0,
):
    if not getattr(sys, "frozen", False):
        raise RuntimeError("Обновление доступно только для собранного PSN.exe")
    staged = verify_staged_update(file_path, expected_size, expected_sha256)
    staged_manifest = None
    if signature_required:
        manifest = _validate_update_manifest({
            "schema": UPDATE_MANIFEST_SCHEMA,
            "appVersion": str(app_version or ""),
            "buildLabel": str(build_label or ""),
            "releaseRevision": parse_release_revision(release_revision),
            "platform": str(platform or ""),
            "size": int(expected_size),
            "sha256": str(expected_sha256 or "").lower(),
            "signature": str(signature or "").lower(),
            "publicKey": str(public_key or "").lower(),
        }, expected_size, expected_sha256)
        staged_manifest = _write_staged_update_manifest(staged, manifest)
    else:
        try:
            os.remove(staged + ".update.json")
        except FileNotFoundError:
            pass
    current = os.path.abspath(sys.executable)
    runtime_dir = paths.runtime_dir()
    os.makedirs(runtime_dir, exist_ok=True)
    helper = os.path.join(runtime_dir, "PSNUpdater.exe")
    helper_tmp = helper + ".new"

    # Copy the currently running, trusted launcher rather than the downloaded
    # executable.  This keeps update semantics on the old trusted code path.
    shutil.copy2(current, helper_tmp)
    os.replace(helper_tmp, helper)

    ready_path = os.path.join(runtime_dir, "update-ready-%d.flag" % os.getpid())
    try:
        os.remove(ready_path)
    except FileNotFoundError:
        pass
    args = [
        helper,
        "--apply-update",
        str(os.getpid()),
        current,
        staged,
        str(int(expected_size)),
        str(expected_sha256).lower(),
        ready_path,
        staged_manifest or "",
    ]
    creationflags = 0
    if os.name == "nt":
        creationflags = getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0) | getattr(subprocess, "DETACHED_PROCESS", 0)
    proc = subprocess.Popen(
        args,
        cwd=os.path.dirname(current),
        close_fds=True,
        creationflags=creationflags,
    )
    # Do not let the GUI exit until the helper has opened/query-validated the
    # real parent process handle. This removes the startup race introduced by
    # fail-closed parent validation.
    deadline = time.time() + 5.0
    while time.time() < deadline:
        if os.path.isfile(ready_path):
            try:
                os.remove(ready_path)
            except OSError:
                pass
            return True
        if proc.poll() is not None:
            raise RuntimeError("Updater helper завершился до подтверждения готовности")
        time.sleep(0.02)
    try:
        proc.terminate()
    except Exception:
        pass
    raise RuntimeError("Updater helper не подтвердил готовность")


def _wait_for_parent(pid, timeout=90.0, ready_path=None, expected_current=None, staged=None):
    """Wait for the trusted launcher and return its executable path on Windows.

    The updater helper must bind the destructive replace to the process that
    actually launched it.  A missing/inaccessible PID is therefore a hard
    failure, not evidence that the parent has already exited.
    """
    if os.name == "nt":
        import ctypes
        from ctypes import wintypes

        SYNCHRONIZE = 0x00100000
        PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
        WAIT_OBJECT_0 = 0
        WAIT_TIMEOUT = 0x00000102
        kernel32 = ctypes.windll.kernel32
        kernel32.OpenProcess.restype = wintypes.HANDLE
        kernel32.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
        kernel32.QueryFullProcessImageNameW.restype = wintypes.BOOL
        kernel32.QueryFullProcessImageNameW.argtypes = [wintypes.HANDLE, wintypes.DWORD, wintypes.LPWSTR, ctypes.POINTER(wintypes.DWORD)]
        kernel32.WaitForSingleObject.restype = wintypes.DWORD
        kernel32.WaitForSingleObject.argtypes = [wintypes.HANDLE, wintypes.DWORD]
        kernel32.CloseHandle.argtypes = [wintypes.HANDLE]
        handle = kernel32.OpenProcess(
            SYNCHRONIZE | PROCESS_QUERY_LIMITED_INFORMATION, False, int(pid)
        )
        if not handle:
            raise ctypes.WinError(ctypes.get_last_error(), "Не удалось открыть процесс PeerSync для обновления")
        try:
            capacity = ctypes.c_ulong(32768)
            buffer = ctypes.create_unicode_buffer(capacity.value)
            if not kernel32.QueryFullProcessImageNameW(handle, 0, buffer, ctypes.byref(capacity)):
                raise ctypes.WinError(ctypes.get_last_error(), "Не удалось определить путь запущенного PeerSync")
            parent_image = os.path.abspath(buffer.value)
            if expected_current and os.path.normcase(os.path.realpath(expected_current)) != os.path.normcase(os.path.realpath(parent_image)):
                raise RuntimeError("Путь обновляемого лаунчера не совпадает с запущенным PeerSync")
            if staged:
                update_root = os.path.join(os.path.dirname(parent_image), "data", "update")
                if not _is_path_inside(update_root, staged):
                    raise RuntimeError("Файл обновления находится вне каталога staging")
            if ready_path:
                runtime_root = os.path.join(os.path.dirname(parent_image), "data", "runtime")
                if not _is_path_inside(runtime_root, ready_path):
                    raise RuntimeError("Некорректный путь handshake updater helper")
                ready_dir = os.path.dirname(os.path.abspath(ready_path))
                if ready_dir:
                    os.makedirs(ready_dir, exist_ok=True)
                with open(ready_path, "w", encoding="ascii") as fh:
                    fh.write("ready")

            deadline = time.time() + timeout
            while time.time() < deadline:
                ms = min(1000, max(1, int((deadline - time.time()) * 1000)))
                result = kernel32.WaitForSingleObject(handle, ms)
                if result == WAIT_OBJECT_0:
                    return parent_image
                if result != WAIT_TIMEOUT:
                    raise RuntimeError("Ошибка ожидания завершения PeerSync перед обновлением")
        finally:
            kernel32.CloseHandle(handle)
        raise RuntimeError("PeerSync не завершился перед установкой обновления")

    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            os.kill(int(pid), 0)
        except OSError:
            return None
        time.sleep(0.25)
    raise RuntimeError("PeerSync не завершился перед установкой обновления")


def _is_path_inside(root, candidate):
    root = os.path.normcase(os.path.realpath(os.path.abspath(root)))
    candidate = os.path.normcase(os.path.realpath(os.path.abspath(candidate)))
    try:
        return os.path.commonpath([root, candidate]) == root
    except ValueError:
        return False


def _updater_log(target_exe, message):
    try:
        root = os.path.join(os.path.dirname(os.path.abspath(target_exe)), "data", "logs")
        os.makedirs(root, exist_ok=True)
        log_path = os.path.join(root, "update.log")
        paths.rotate_log_files(log_path)
        with open(log_path, "a", encoding="utf-8") as fh:
            fh.write("[%s] %s\n" % (time.strftime("%Y-%m-%d %H:%M:%S"), message))
    except OSError:
        pass


def _replace_retry(source, target, attempts=25, delay=0.2):
    last = None
    for attempt in range(attempts):
        try:
            os.replace(source, target)
            return
        except OSError as exc:
            last = exc
            if attempt + 1 < attempts:
                time.sleep(delay)
    raise last


def _copy_durable(source, target):
    """Publish a flushed backup without ever removing the public launcher."""
    temporary = target + ".new-" + secrets.token_hex(8)
    try:
        shutil.copyfile(source, temporary)
        with open(temporary, "rb+") as handle:
            os.fsync(handle.fileno())
        _replace_retry(temporary, target)
    finally:
        try:
            os.remove(temporary)
        except FileNotFoundError:
            pass


# ---------------------------------------------------------------------------
# Durable update transaction + recovery that does not require the new launcher
# ---------------------------------------------------------------------------


def pending_marker_path(exe_path):
    """Path of the durable pending-update record for a given launcher path."""
    launcher_dir = os.path.dirname(os.path.abspath(str(exe_path or "")))
    return os.path.join(launcher_dir, "data", "runtime", _PENDING_FILE_NAME)


def _durable_json_write(path, payload):
    directory = os.path.dirname(path)
    os.makedirs(directory, exist_ok=True)
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8", newline="\n") as fh:
        json.dump(payload, fh, ensure_ascii=False, indent=2, sort_keys=True)
        fh.write("\n")
        fh.flush()
        os.fsync(fh.fileno())
    os.replace(tmp, path)
    return path


def _write_pending_transaction(marker_path, record):
    return _durable_json_write(marker_path, record)


def _clear_watchdog_acknowledgements(marker_path):
    """Drop the per-transaction arming acknowledgements next to the marker."""
    if not marker_path:
        return
    marker = os.path.abspath(marker_path)
    directory = os.path.dirname(marker)
    prefix = os.path.basename(marker) + _WATCHDOG_ARMED_SUFFIX
    try:
        names = os.listdir(directory)
    except OSError:
        return
    for name in names:
        if not name.startswith(prefix):
            continue
        try:
            os.remove(os.path.join(directory, name))
        except OSError:
            pass


def _clear_pending_transaction(marker_path):
    if not marker_path:
        return False
    _clear_watchdog_acknowledgements(marker_path)
    try:
        os.remove(marker_path)
        return True
    except FileNotFoundError:
        return False
    except OSError:
        return False


def read_pending_transaction(marker_path):
    """Return a validated pending-update record, or None when there is none.

    The marker is a local recovery hint, never an authority: it may only name
    the launcher directory it lives in and that launcher's own ``.bak`` copy.
    """
    if not marker_path:
        return None
    try:
        with open(marker_path, encoding="utf-8") as fh:
            record = json.load(fh)
    except (OSError, ValueError, TypeError):
        return None
    if not isinstance(record, dict) or record.get("schema") != _PENDING_SCHEMA:
        return None
    token = str(record.get("token") or "")
    if not _PENDING_TOKEN_RE.fullmatch(token):
        return None
    current = record.get("current")
    backup = record.get("backup")
    if not isinstance(current, str) or not isinstance(backup, str) or not current or not backup:
        return None
    current = os.path.abspath(current)
    backup = os.path.abspath(backup)
    expected_dir = os.path.normcase(os.path.abspath(os.path.dirname(str(marker_path))))
    if expected_dir != os.path.normcase(os.path.join(os.path.dirname(current), "data", "runtime")):
        return None
    if os.path.normcase(backup) != os.path.normcase(current + ".bak"):
        return None
    record["token"] = token
    record["current"] = current
    record["backup"] = backup
    try:
        record["createdAt"] = float(record.get("createdAt") or 0)
    except (TypeError, ValueError):
        record["createdAt"] = 0.0
    try:
        record["candidatePid"] = int(record.get("candidatePid") or 0)
    except (TypeError, ValueError):
        record["candidatePid"] = 0
    return record


def _pending_age(record):
    created = float((record or {}).get("createdAt") or 0.0)
    if created <= 0:
        return _PENDING_GRACE_SECONDS
    return max(0.0, time.time() - created)


def _process_image_path(pid):
    if os.name != "nt" or not pid:
        return None
    try:
        import ctypes
        from ctypes import wintypes

        PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
        kernel32 = ctypes.windll.kernel32
        kernel32.OpenProcess.restype = wintypes.HANDLE
        kernel32.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
        kernel32.QueryFullProcessImageNameW.restype = wintypes.BOOL
        kernel32.QueryFullProcessImageNameW.argtypes = [
            wintypes.HANDLE, wintypes.DWORD, wintypes.LPWSTR, ctypes.POINTER(wintypes.DWORD)
        ]
        kernel32.CloseHandle.argtypes = [wintypes.HANDLE]
        handle = kernel32.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, False, int(pid))
        if not handle:
            return None
        try:
            capacity = ctypes.c_ulong(32768)
            buffer = ctypes.create_unicode_buffer(capacity.value)
            if not kernel32.QueryFullProcessImageNameW(handle, 0, buffer, ctypes.byref(capacity)):
                return None
            return os.path.abspath(buffer.value)
        finally:
            kernel32.CloseHandle(handle)
    except Exception:  # noqa: BLE001 - liveness probe must never raise
        return None


def candidate_generation_alive(record):
    """True only when the recorded candidate generation is still running."""
    pid = int((record or {}).get("candidatePid") or 0)
    if pid <= 0:
        return False
    if os.name == "nt":
        image = _process_image_path(pid)
        return bool(image) and os.path.normcase(image) == os.path.normcase(record["current"])
    try:
        os.kill(pid, 0)
    except OSError:
        return False
    return True


def _watchdog_armed_path(marker_path, token):
    """Acknowledge file the watchdog writes next to the pending marker."""
    return "%s%s-%s" % (marker_path, _WATCHDOG_ARMED_SUFFIX, str(token or ""))


def _confirm_recovery_armed(marker_path, armed_path, token):
    """Publish the watchdog's durable acknowledgement of one specific transaction.

    The path is constrained to the marker's own directory, so the recovery
    helper cannot be turned into an arbitrary-file writer by argv.
    """
    if not armed_path or not token:
        return False
    if not _is_path_inside(os.path.dirname(os.path.abspath(marker_path)), armed_path):
        return False
    try:
        _durable_json_write(armed_path, {
            "schema": _PENDING_SCHEMA,
            "token": str(token),
            "marker": os.path.abspath(marker_path),
            "armedAt": time.time(),
        })
        return True
    except OSError:
        return False


def start_recovery_watchdog(helper, marker_path, timeout=_WATCHDOG_TIMEOUT_SECONDS, armed_path=None, token=None):
    """Run an independent recovery helper for a committed update transaction."""
    if not helper or not os.path.isfile(helper):
        return None
    creationflags = 0
    if os.name == "nt":
        creationflags = getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0) | getattr(subprocess, "DETACHED_PROCESS", 0)
    args = [helper, "--recover-pending", marker_path, str(int(timeout))]
    if armed_path:
        args += [os.path.abspath(armed_path), str(token or "")]
    try:
        return subprocess.Popen(
            args,
            cwd=os.path.dirname(helper),
            close_fds=True,
            creationflags=creationflags,
        )
    except OSError:
        return None


def arm_recovery_watchdog(helper, marker_path, token, timeout=_WATCHDOG_ARM_TIMEOUT_SECONDS):
    """Start the watchdog and require it to acknowledge this exact transaction.

    A spawned process is not a recovery guarantee: it can fail to start, exit
    immediately, or never observe the marker. The watchdog therefore writes a
    durable acknowledgement next to the marker once it has read and validated
    the record, and this returns True only after that file exists.
    """
    if not helper or not os.path.isfile(helper):
        return False
    armed_path = _watchdog_armed_path(marker_path, token)
    try:
        os.remove(armed_path)
    except FileNotFoundError:
        pass
    except OSError:
        return False

    proc = start_recovery_watchdog(
        helper, marker_path, token=token, armed_path=armed_path,
    )
    if proc is None:
        return False
    deadline = time.monotonic() + max(0.0, float(timeout))
    while time.monotonic() < deadline:
        if os.path.isfile(armed_path):
            return True
        if proc.poll() is not None:
            return False
        time.sleep(0.05)
    # Not confirmed in time. The watchdog is deliberately left running: if it is
    # merely slow it will find no pending record once the caller abandons the
    # commit, and killing it here would be the only destructive action this
    # function is allowed to take.
    return False


def arm_independent_recovery(helper, marker_path, token):
    """Require the known-good watchdog to acknowledge this portable transaction.

    This proves recovery in the current session. Durable files retain the
    transaction across reboot; no OS startup registration is created.
    """
    return arm_recovery_watchdog(helper, marker_path, token)


def _record_candidate_pid(marker_path, pid):
    record = read_pending_transaction(marker_path)
    if record is None:
        return False
    record["candidatePid"] = int(pid)
    try:
        _write_pending_transaction(marker_path, record)
        return True
    except OSError:
        return False


def _settle_pending_transaction(marker_path):
    """Retire a transaction this process completed; disarm independent recovery."""
    if not marker_path:
        return False
    _clear_pending_transaction(marker_path)
    return True


def _start_launcher(current):
    try:
        subprocess.Popen([current], cwd=os.path.dirname(current), close_fds=True)
        return True
    except OSError as exc:
        _updater_log(current, "launcher restart failed: %s" % exc)
        return False


def rollback_pending_transaction(record, marker_path, reason):
    """Restore the known-good backup for an unconfirmed update transaction."""
    current = record["current"]
    backup = record["backup"]
    expected = str(record.get("previousSha256") or "").lower()
    _updater_log(current, "pending update recovery: %s" % reason)
    try:
        if not os.path.isfile(backup):
            _updater_log(current, "pending update recovery: known-good backup is missing")
            return False
        if expected:
            digest, _size = sha256_file(backup)
            if digest.lower() != expected:
                _updater_log(current, "pending update recovery: backup failed integrity check")
                return False
        manifest = str(record.get("manifest") or "")
        manifest_backup = str(record.get("manifestBackup") or "")
        if manifest and manifest_backup:
            try:
                os.remove(manifest)
            except FileNotFoundError:
                pass
            except OSError:
                pass
            if os.path.isfile(manifest_backup):
                _replace_retry(manifest_backup, manifest)
        # Restore in place: the public launcher path is never left without a file.
        _replace_retry(backup, current)
        _clear_pending_transaction(marker_path)
        _updater_log(current, "pending update recovery: previous launcher restored")
        return True
    except OSError as exc:
        _updater_log(current, "pending update recovery failed: %s" % exc)
        return False


def _recover_pending(marker_path, wait_seconds, armed_path=None, token=None):
    """Shared recovery body for the watchdog and a manually launched helper."""
    record = read_pending_transaction(marker_path)
    if record is not None and armed_path:
        # Acknowledge first, and only for the exact transaction that was armed.
        # The committing helper waits for this file before it destroys the
        # known-good launcher, so it must be written before any waiting starts.
        if not token or not secrets.compare_digest(record["token"], str(token)):
            return 2
        if not _confirm_recovery_armed(marker_path, armed_path, token):
            return 2
    if record is None:
        return 0
    if wait_seconds is None:
        # Manual helper launch: bound the remaining readiness grace window.
        wait_seconds = max(0.0, min(_PENDING_GRACE_SECONDS - _pending_age(record), _STARTUP_RECOVERY_MAX_WAIT_SECONDS))
    deadline = time.monotonic() + max(0.0, min(float(wait_seconds), _MAX_RECOVERY_WAIT_SECONDS))
    while time.monotonic() < deadline:
        if not os.path.isfile(marker_path):
            # The transaction was confirmed or rolled back by its owner.
            return 0
        time.sleep(0.25)
    record = read_pending_transaction(marker_path)
    if record is None:
        return 0
    if candidate_generation_alive(record):
        # A live candidate owns the launcher path. Never roll the image back from
        # under a running application; the running generation settles the marker.
        return 0
    healed = rollback_pending_transaction(record, marker_path, "committed update was never confirmed")
    if not healed:
        return 1
    _start_launcher(record["current"])
    return 0


def recover_pending_cli(argv):
    """argv: --recover-pending markerPath [waitSeconds] [armedPath] [token]

    Runs from the previous (known-good) launcher copy, so it keeps working even
    when the freshly installed candidate cannot start at all.  When ``armedPath``
    is present the helper must first prove it owns this transaction by writing a
    durable acknowledgement next to the marker.
    """
    if len(argv) < 3 or argv[1] != "--recover-pending":
        return 2
    marker_path = os.path.abspath(argv[2])
    wait_seconds = None
    if len(argv) > 3:
        try:
            wait_seconds = max(0.0, min(float(argv[3]), _MAX_RECOVERY_WAIT_SECONDS))
        except (TypeError, ValueError):
            wait_seconds = _WATCHDOG_TIMEOUT_SECONDS
    armed_path = os.path.abspath(argv[4]) if len(argv) > 4 and argv[4] else None
    token = str(argv[5]) if len(argv) > 5 and argv[5] else ""
    return _recover_pending(marker_path, wait_seconds, armed_path, token)


def arm_candidate_session_recovery(exe, record, marker_path):
    """Re-arm in-session recovery for a candidate that never confirmed.

    A power loss destroys the update-time watchdog, so a candidate that boots
    from a leftover record would otherwise be the last running copy of the
    transaction with nobody left to heal it if it dies.  Startup therefore
    publishes itself as the live generation and starts a fresh, bounded
    recovery helper: a candidate that reaches readiness retires the record and
    the helper stands down, while a candidate that dies gets the known-good
    image restored.

    Fire-and-forget on purpose: startup must never wait for an arming handshake.
    """
    if int((record or {}).get("candidatePid") or 0) == os.getpid():
        # This generation was started by the helper itself, so the update-time
        # watchdog is still alive and already covers this session.
        return False
    helper = os.path.join(os.path.dirname(exe), "data", "runtime", "PSNUpdater.exe")
    if not os.path.isfile(helper):
        return False
    # The recorded pid belongs to a generation that no longer exists. Publishing
    # this one keeps the recovery liveness check from acting on a dead pid.
    try:
        _record_candidate_pid(marker_path, os.getpid())
    except OSError:
        pass
    proc = start_recovery_watchdog(helper, marker_path)
    if proc is None:
        _updater_log(exe, "startup could not re-arm candidate recovery")
        return False
    _updater_log(exe, "startup re-armed candidate recovery %s" % record["token"][:12])
    return True


def reconcile_pending_update(exe_path=None):
    """Report the outcome of a leftover update transaction for a starting launcher.

    A running Windows executable cannot replace itself, so startup only inspects
    the durable record:

    * the image is the hash-verified candidate, so the update installed; the
      marker is kept until the new generation confirms readiness
      (``notify_update_ready``), because a startup that dies later still has to
      be recoverable.  This generation also re-arms a session recovery helper so
      that "dies later" has an executor even when the update-time watchdog was
      lost to a power cut;
    * the image is the known-good previous launcher, so a rollback already
      restored it and the record can be retired;
    * anything else is reported and left to the recovery helper, which owns file
      replacement.
    """
    exe = os.path.abspath(str(exe_path or sys.executable))
    marker_path = pending_marker_path(exe)
    record = read_pending_transaction(marker_path)
    if record is None:
        return None
    if os.path.normcase(os.path.realpath(record["current"])) != os.path.normcase(os.path.realpath(exe)):
        return None
    try:
        digest, _size = sha256_file(exe)
    except OSError:
        return None
    digest = digest.lower()
    if digest and digest == str(record.get("candidateSha256") or "").lower():
        _updater_log(exe, "startup running pending update %s" % record["token"][:12])
        arm_candidate_session_recovery(exe, record, marker_path)
        return "pending"
    if digest and digest == str(record.get("previousSha256") or "").lower():
        _clear_pending_transaction(marker_path)
        _updater_log(exe, "startup cleared rolled back update %s" % record["token"][:12])
        return "rolled-back"
    _updater_log(exe, "startup found an unexpected launcher image for pending update %s" % record["token"][:12])
    return "diverged"


def confirm_pending_candidate(exe_path=None):
    """Confirm a manual restart only after its Core has become ready.

    A reboot loses the updater's command-line token. The durable record and
    actual launcher hash identify the candidate without registering autostart.
    """
    exe = os.path.abspath(str(exe_path or sys.executable))
    marker_path = pending_marker_path(exe)
    record = read_pending_transaction(marker_path)
    if record is None:
        return False
    if os.path.normcase(os.path.realpath(record["current"])) != os.path.normcase(os.path.realpath(exe)):
        return False
    try:
        digest, _size = sha256_file(exe)
    except OSError:
        return False
    if digest.lower() != str(record.get("candidateSha256") or "").lower():
        return False
    _settle_pending_transaction(marker_path)
    _updater_log(exe, "Core readiness confirmed pending update %s" % record["token"][:12])
    return True


def notify_update_ready(argv=None):
    """Called on the Tk thread only after the new Core hello succeeds."""
    args = sys.argv if argv is None else argv
    tokens = [arg.split("=", 1)[1] for arg in args if arg.startswith("--update-ready=")]
    if not tokens:
        try:
            confirm_pending_candidate()
        except OSError:
            pass
        return
    if len(tokens) != 1 or not re.fullmatch(r"[0-9a-f]{64}", tokens[0]):
        raise RuntimeError("Invalid update readiness token")
    token = tokens[0]
    path = os.path.join(paths.runtime_dir(), "update-start-" + token + ".json")
    temporary = path + ".tmp"
    with open(temporary, "w", encoding="utf-8") as handle:
        json.dump({"token": token, "exe": os.path.realpath(sys.executable)}, handle)
        handle.flush()
        os.fsync(handle.fileno())
    os.replace(temporary, path)
    # Readiness is the commit point of the update transaction: only the new
    # generation can retire the record, so a candidate that dies before this
    # moment stays recoverable by the independent recovery helper.
    try:
        confirm_pending_candidate()
    except OSError:
        pass


def _wait_for_update_ready(proc, path, token, current, timeout=60.0):
    deadline = time.monotonic() + timeout
    ready_at = None
    while time.monotonic() < deadline:
        if proc.poll() is not None:
            raise RuntimeError("Новая версия PeerSync завершилась до подтверждения запуска")
        if ready_at is None:
            try:
                with open(path, encoding="utf-8") as handle:
                    record = json.loads(handle.read(4096))
                if (isinstance(record, dict) and record.get("token") == token
                        and os.path.normcase(record.get("exe", "")) == os.path.normcase(os.path.realpath(current))):
                    ready_at = time.monotonic()
            except (OSError, ValueError, TypeError):
                pass
        elif time.monotonic() - ready_at >= 1.0:
            return
        time.sleep(0.05)
    raise RuntimeError("Новая версия PeerSync не подтвердила готовность")


class UpdateProcessStillRunningError(RuntimeError):
    """Do not reuse the launcher/data namespace until its candidate is gone."""


def _start_verified_update(current, on_spawn=None):
    """Own the entire candidate process tree until GUI/Core readiness."""
    token = secrets.token_hex(32)
    ready = os.path.join(os.path.dirname(current), "data", "runtime", "update-start-" + token + ".json")
    os.makedirs(os.path.dirname(ready), exist_ok=True)
    proc = None
    job = None
    if os.name == "nt":
        from windows import process_tree

        job = process_tree.create_kill_on_close_job()
    try:
        proc = subprocess.Popen(
            [current, "--update-ready=" + token], cwd=os.path.dirname(current), close_fds=True,
            creationflags=process_tree.CREATE_SUSPENDED if job is not None else 0,
        )
        if job is not None:
            process_tree.assign_process(job, proc.pid)
            process_tree.resume_suspended_process(proc.pid)
        if on_spawn is not None:
            # Publish the candidate pid into the durable transaction so an
            # independent recovery never rolls back a live generation.
            try:
                on_spawn(proc.pid)
            except Exception:  # noqa: BLE001 - bookkeeping must not break the update
                pass
        _wait_for_update_ready(proc, ready, token, current)
        if job is not None:
            # The new app now owns its Core Job. Closing the helper's outer Job
            # must not kill the successfully started launcher.
            process_tree.release_job(job)
    except Exception:
        if job is not None:
            if not process_tree.terminate_job_and_wait(job, timeout=10.0):
                raise UpdateProcessStillRunningError("Не удалось остановить новую версию перед откатом")
        if proc is not None:
            if proc.poll() is None:
                proc.kill()
            try:
                proc.wait(timeout=10.0)
            except subprocess.TimeoutExpired as exc:
                raise UpdateProcessStillRunningError("Не удалось дождаться остановки новой версии") from exc
        raise
    finally:
        if job is not None:
            process_tree.close_job(job)
        try:
            os.remove(ready)
        except FileNotFoundError:
            pass


def apply_update_cli(argv):
    # argv: --apply-update parentPid currentExe stagedExe size sha256 readyPath stagedManifest
    if len(argv) < 7:
        return 2
    try:
        parent_pid = int(argv[2])
        requested_current = os.path.abspath(argv[3])
        staged = os.path.abspath(argv[4])
        expected_size = int(argv[5])
        expected_hash = str(argv[6]).lower()
        ready_path = os.path.abspath(argv[7]) if len(argv) > 7 and argv[7] else None
        staged_manifest = os.path.abspath(argv[8]) if len(argv) > 8 and argv[8] else None
    except (TypeError, ValueError):
        return 2

    current = requested_current
    backup = current + ".bak"
    current_manifest = current + ".update.json"
    manifest_backup = current_manifest + ".bak"
    parent_exited = False
    old_moved_to_backup = False
    old_manifest_backed_up = False
    restarted = False
    marker_path = None
    try:
        # On Windows the process handle is the authority for the target path.
        # Do not let a direct invocation turn the signed helper into a generic
        # arbitrary-file replacement primitive by trusting argv[3].
        parent_image = _wait_for_parent(
            parent_pid, ready_path=ready_path, expected_current=requested_current, staged=staged
        )
        if parent_image:
            current = os.path.abspath(parent_image)
            if os.path.normcase(os.path.realpath(requested_current)) != os.path.normcase(os.path.realpath(current)):
                raise RuntimeError("Путь обновляемого лаунчера не совпадает с запущенным PeerSync")
        parent_exited = True

        # Re-establish the staging boundary in the helper itself.  paths.data_root()
        # is not usable here because sys.executable points at data/runtime/
        # PSNUpdater.exe rather than at the user-facing launcher.
        update_root = os.path.join(os.path.dirname(current), "data", "update")
        if not _is_path_inside(update_root, staged):
            raise RuntimeError("Файл обновления находится вне каталога staging")
        staged = os.path.realpath(staged)
        if not os.path.isfile(staged):
            raise RuntimeError("Файл обновления не найден")

        actual_hash, actual_size = sha256_file(staged)
        if actual_size != expected_size or actual_hash.lower() != expected_hash:
            raise RuntimeError("staged update failed final integrity check")
        if staged_manifest:
            if not _is_path_inside(update_root, staged_manifest):
                raise RuntimeError("Manifest обновления находится вне каталога staging")
            try:
                with open(staged_manifest, encoding="utf-8") as fh:
                    manifest = json.load(fh)
            except (OSError, ValueError, TypeError) as exc:
                raise RuntimeError("Не удалось прочитать manifest обновления") from exc
            _validate_update_manifest(manifest, expected_size, expected_hash)

        backup = current + ".bak"
        current_manifest = current + ".update.json"
        manifest_backup = current_manifest + ".bak"

        # A backup is a durable copy, not a rename of the public launcher.
        # Kill/power loss anywhere before the single staged->current replace
        # therefore leaves the known-good executable at its original path.
        _copy_durable(current, backup)

        try:
            os.remove(manifest_backup)
        except FileNotFoundError:
            pass
        if os.path.isfile(current_manifest):
            _copy_durable(current_manifest, manifest_backup)
            old_manifest_backed_up = True

        # Publish the transaction before the commit replace. From here on the
        # marker exists, so a killed helper, a dead helper or a power loss can be
        # healed by a component that does not need the new launcher to start.
        marker_path = pending_marker_path(current)
        helper_path = os.path.join(os.path.dirname(current), "data", "runtime", "PSNUpdater.exe")
        previous_digest, _previous_size = sha256_file(backup)
        pending_token = secrets.token_hex(16)
        _write_pending_transaction(marker_path, {
            "schema": _PENDING_SCHEMA,
            "token": pending_token,
            "createdAt": time.time(),
            "current": current,
            "backup": backup,
            "manifest": current_manifest if staged_manifest else "",
            "manifestBackup": manifest_backup if old_manifest_backed_up else "",
            "previousSha256": previous_digest.lower(),
            "candidateSha256": expected_hash,
            "candidateSize": int(expected_size),
            "candidatePid": 0,
        })

        # Fail-closed recovery arming. Both paths must be proven, not attempted,
        # and both are armed *before* the destructive replace: the previous
        # launcher is still in place while this runs, so abandoning the update
        # here costs nothing.
        watchdog_armed = arm_independent_recovery(helper_path, marker_path, pending_token)
        _updater_log(current, "recovery arming: watchdog=%s" % (
            "armed" if watchdog_armed else "not-armed",
        ))
        if not watchdog_armed:
            _settle_pending_transaction(marker_path)
            raise RuntimeError(
                "Update abandoned: the known-good recovery watchdog did not acknowledge the transaction"
            )

        try:
            _replace_retry(staged, current)
            old_moved_to_backup = True  # rollback now required; backup is still a copy
            if staged_manifest:
                _replace_retry(staged_manifest, current_manifest)
            else:
                # Never leave metadata for the old bytes beside an unsigned update.
                try:
                    os.remove(current_manifest)
                except FileNotFoundError:
                    pass
        except Exception:
            if old_moved_to_backup:
                _replace_retry(backup, current)
                old_moved_to_backup = False
                if old_manifest_backed_up and os.path.isfile(manifest_backup):
                    _replace_retry(manifest_backup, current_manifest)
                    old_manifest_backed_up = False
            _settle_pending_transaction(marker_path)
            raise

        # The candidate runs while the confirmed independent recovery stays armed.
        try:
            _start_verified_update(current, on_spawn=lambda pid: _record_candidate_pid(marker_path, pid))
            restarted = True
            # Readiness is confirmed: the transaction is complete. Clearing the
            # marker is what tells the watchdog to stay out.
            _settle_pending_transaction(marker_path)
        except UpdateProcessStillRunningError:
            # The candidate may still own the launcher path. Leave the marker and
            # the recovery watchdog armed: they check candidate liveness first.
            raise
        except Exception:
            # Preserve the failed image only by copying it.  Never move it away
            # before the known-good backup has replaced the public launcher
            # path: if rollback itself hits a transient AV/share failure the
            # machine must still retain *some* launcher at `current`.
            failed_image = staged + ".failed"
            try:
                shutil.copy2(current, failed_image)
            except OSError:
                pass
            _replace_retry(backup, current)
            old_moved_to_backup = False
            if os.path.exists(current_manifest):
                try:
                    os.remove(current_manifest)
                except OSError:
                    pass
            if old_manifest_backed_up and os.path.isfile(manifest_backup):
                _replace_retry(manifest_backup, current_manifest)
                old_manifest_backed_up = False
            subprocess.Popen([current], cwd=os.path.dirname(current), close_fds=True)
            restarted = True
            # The known-good image is back in place, so no independent recovery
            # is needed for this transaction any more.
            _settle_pending_transaction(marker_path)
            raise

        _updater_log(current, "update applied successfully")
        return 0
    except Exception as exc:  # noqa: BLE001 - helper must log and exit cleanly
        _updater_log(current, "update failed: %s" % exc)
        if isinstance(exc, UpdateProcessStillRunningError):
            # The current candidate may still have descendants writing data.
            # Keep both executable images; do not start a competing generation.
            return 1

        # Once the parent has exited, this helper owns application liveness.
        # Any failed update path must leave either the untouched or restored
        # launcher running; otherwise a transient AV/share violation makes the
        # app simply disappear after the shell intentionally exited.
        if parent_exited and not restarted:
            if old_moved_to_backup and os.path.isfile(backup):
                try:
                    if os.path.exists(current):
                        try:
                            shutil.copy2(current, staged + ".failed")
                        except OSError:
                            pass
                    # Replace in-place.  If this fails the failed/new launcher
                    # remains at `current`; we never create a no-launcher gap.
                    _replace_retry(backup, current)
                    old_moved_to_backup = False
                    if os.path.exists(current_manifest):
                        try:
                            os.remove(current_manifest)
                        except OSError:
                            pass
                    if old_manifest_backed_up and os.path.isfile(manifest_backup):
                        _replace_retry(manifest_backup, current_manifest)
                        old_manifest_backed_up = False
                except Exception as restore_exc:  # noqa: BLE001
                    _updater_log(current, "rollback restore failed: %s" % restore_exc)
            if not old_moved_to_backup:
                # The launcher is either untouched or already restored, so the
                # transaction no longer needs independent recovery.
                _settle_pending_transaction(marker_path)
            if os.path.isfile(current):
                try:
                    subprocess.Popen([current], cwd=os.path.dirname(current), close_fds=True)
                    restarted = True
                    _updater_log(current, "previous launcher restarted after update failure")
                except Exception as restart_exc:  # noqa: BLE001
                    _updater_log(current, "launcher restart after update failure failed: %s" % restart_exc)
        return 1
