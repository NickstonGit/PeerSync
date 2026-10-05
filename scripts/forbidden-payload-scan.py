"""Scan portable FIRST TRY graph for forbidden Electron/browser/mobile/legacy payload.

Usage (from repository root):
    python scripts/forbidden-payload-scan.py [coreExe] [finalExe] [out.json]
"""

from __future__ import annotations

import json
import os
import sys

APP = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

FORBIDDEN_SOURCE = (
    "from electron",
    "require('electron",
    'require("electron',
    "from expo",
    "react-native",
    "webview2",
    "pear-runtime",
    "pearruntime",
)
FORBIDDEN_BIN = (
    b"Electron/",
    b"Electron.app",
    b"libchromiumcontent",
    b"chrome-sandbox",
    b"expo-router",
)
SKIP_NAMES = {
    "core_payload.py",
    "node_modules",
    "dist",
    "build",
    "__pycache__",
    ".git",
}
SKIP_FILES = {"forbidden-payload-scan.py"}


def walk_sources():
    roots = [
        os.path.join(APP, "apps", "portable-python"),
        os.path.join(APP, "packages", "core", "src", "portable"),
    ]
    hits = []
    for root in roots:
        if not os.path.isdir(root):
            continue
        for dirpath, dirnames, filenames in os.walk(root):
            dirnames[:] = [d for d in dirnames if d not in SKIP_NAMES]
            for name in filenames:
                if name in SKIP_NAMES or name in SKIP_FILES or name.endswith(".pyc"):
                    continue
                if not name.endswith((".py", ".ts", ".js", ".mjs", ".md", ".ps1", ".spec")):
                    continue
                path = os.path.join(dirpath, name)
                try:
                    text = open(path, encoding="utf-8", errors="ignore").read().lower()
                except OSError:
                    continue
                for token in FORBIDDEN_SOURCE:
                    if token in text:
                        rel = os.path.relpath(path, APP)
                        hits.append({"file": rel.replace("\\", "/"), "token": token})
    return hits


def scan_exe(path):
    if not path or not os.path.isfile(path):
        return {"path": path, "missing": True, "hits": []}
    hits = []
    size = os.path.getsize(path)
    with open(path, "rb") as fh:
        buf = fh.read()
    for token in FORBIDDEN_BIN:
        if token in buf:
            hits.append(token.decode("ascii", "replace"))
    return {"path": path, "bytes": size, "hits": hits}


def main():
    core = sys.argv[1] if len(sys.argv) > 1 else os.path.join(APP, "build", "core", "PSNCore.exe")
    final = sys.argv[2] if len(sys.argv) > 2 else ""
    out = sys.argv[3] if len(sys.argv) > 3 else ""
    source_hits = walk_sources()
    core_hits = scan_exe(core)
    final_hits = scan_exe(final) if final else {"path": "", "hits": [], "skipped": True}
    ok = not source_hits and not core_hits.get("hits") and not final_hits.get("hits")
    report = {
        "ok": ok,
        "sourceHits": source_hits,
        "core": core_hits,
        "final": final_hits,
    }
    text = json.dumps(report, indent=2)
    if out:
        os.makedirs(os.path.dirname(out) or ".", exist_ok=True)
        with open(out, "w", encoding="utf-8") as fh:
            fh.write(text)
    print(text)
    if not ok:
        sys.exit(2)


if __name__ == "__main__":
    main()
