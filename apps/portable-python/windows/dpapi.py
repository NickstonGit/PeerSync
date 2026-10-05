"""DPAPI (CryptProtectData/CryptUnprotectData) via ctypes.

Current-user scope; no plaintext secrets on disk. An existing identity blob is
an ownership boundary: read/decrypt/validation failure is startup-fatal and
must never be converted into an implicit key rotation.
"""

import base64
import binascii
import ctypes
import os

from runtime.compat import IDENTITY_ENTROPY
from ctypes import wintypes

kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)

CRYPTPROTECT_UI_FORBIDDEN = 0x01


def _resolve_dpapi():
    # The export has moved between advapi32/crypt32/cryptbase across versions.
    candidates = []
    for name in ("advapi32", "crypt32", "cryptbase"):
        try:
            candidates.append(ctypes.WinDLL(name, use_last_error=True))
        except OSError:
            continue
    for lib in candidates:
        try:
            protect = getattr(lib, "CryptProtectData")
            unprotect = getattr(lib, "CryptUnprotectData")
        except AttributeError:
            continue
        return protect, unprotect
    raise OSError("DPAPI (CryptProtectData) not available")


class DATA_BLOB(ctypes.Structure):
    _fields_ = [
        ("cbData", wintypes.DWORD),
        ("pbData", ctypes.POINTER(ctypes.c_ubyte)),
    ]


_CryptProtectData, _CryptUnprotectData = _resolve_dpapi()

_ARGTYPES = [
    ctypes.POINTER(DATA_BLOB),
    wintypes.LPCWSTR,
    ctypes.POINTER(DATA_BLOB),
    ctypes.c_void_p,
    ctypes.c_void_p,
    wintypes.DWORD,
    ctypes.POINTER(DATA_BLOB),
]
_CryptProtectData.argtypes = _ARGTYPES
_CryptProtectData.restype = wintypes.BOOL
_CryptUnprotectData.argtypes = _ARGTYPES
_CryptUnprotectData.restype = wintypes.BOOL
kernel32.LocalFree.argtypes = [ctypes.c_void_p]
kernel32.LocalFree.restype = ctypes.c_void_p


def _make_blob(data: bytes) -> DATA_BLOB:
    buf = (ctypes.c_ubyte * len(data)).from_buffer_copy(data)
    return DATA_BLOB(len(data), ctypes.cast(buf, ctypes.POINTER(ctypes.c_ubyte))), buf


def _blob_to_bytes(blob: DATA_BLOB) -> bytes:
    try:
        return ctypes.string_at(blob.pbData, blob.cbData)
    finally:
        kernel32.LocalFree(ctypes.cast(blob.pbData, ctypes.c_void_p))


def _call(fn, data, prompt, entropy):
    in_blob, _keep1 = _make_blob(data)
    ent_blob = None
    keep = None
    if entropy:
        ent_blob, keep = _make_blob(entropy)
    out = DATA_BLOB()
    ok = fn(
        ctypes.byref(in_blob),
        prompt,
        ctypes.byref(ent_blob) if ent_blob else None,
        None,
        None,
        CRYPTPROTECT_UI_FORBIDDEN,
        ctypes.byref(out),
    )
    if not ok:
        raise ctypes.WinError(ctypes.get_last_error())
    return _blob_to_bytes(out)


def protect(data: bytes, entropy: bytes | None = None) -> bytes:
    return _call(_CryptProtectData, data, "PeerSync", entropy)


def unprotect(data: bytes, entropy: bytes | None = None) -> bytes:
    return _call(_CryptUnprotectData, data, None, entropy)


ENTROPY = IDENTITY_ENTROPY
IDENTITY_BLOB_MAX_BYTES = 4 * 1024


def load_or_create_identity_seed(security_dir: str) -> str:
    """Return 64-hex seed; encrypted blob at <security_dir>/identity.dpapi."""
    os.makedirs(security_dir, exist_ok=True)
    path = os.path.join(security_dir, "identity.dpapi")
    if os.path.exists(path):
        # The protected 32-byte seed is tiny. Reject obviously oversized state
        # before allocating it, then keep the read itself bounded as protection
        # against a size-change race between stat and open/read.
        if os.path.getsize(path) > IDENTITY_BLOB_MAX_BYTES:
            raise RuntimeError(
                "Existing PeerSync identity is oversized; refusing automatic identity rotation"
            )

        with open(path, "rb") as fh:
            raw_blob = fh.read(IDENTITY_BLOB_MAX_BYTES + 1)
        if len(raw_blob) > IDENTITY_BLOB_MAX_BYTES:
            raise RuntimeError(
                "Existing PeerSync identity changed while being read; refusing automatic identity rotation"
            )

        blob = raw_blob.strip()
        try:
            encrypted = base64.b64decode(blob, validate=True)
            seed = unprotect(encrypted, ENTROPY)
        except (binascii.Error, ValueError, OSError) as exc:
            raise RuntimeError(
                "Existing PeerSync identity cannot be decrypted; refusing automatic identity rotation"
            ) from exc

        if len(seed) != 32:
            raise RuntimeError(
                "Existing PeerSync identity has an invalid seed length; refusing automatic identity rotation"
            )
        return seed.hex()

    # Only the proven-absent case may create a new identity. Once this file
    # exists, every later failure is fail-closed above so the old seed remains
    # available for explicit recovery instead of being overwritten.
    seed = os.urandom(32)
    blob = base64.b64encode(protect(seed, ENTROPY))
    tmp = path + ".tmp"
    with open(tmp, "wb") as fh:
        fh.write(blob)
        fh.flush()
        os.fsync(fh.fileno())
    os.replace(tmp, path)
    return seed.hex()
