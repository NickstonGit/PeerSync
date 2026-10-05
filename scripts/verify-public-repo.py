#!/usr/bin/env python3
"""Fail closed if the public PeerSync source tree contains local/upstream leftovers.

The check is intentionally dependency-free so it can run before npm/pip install.
Use --working-tree before the first public commit; CI uses tracked files by default.
"""

from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
from pathlib import Path, PurePosixPath

ROOT = Path(__file__).resolve().parents[1]
LEGACY_BRAND = "Alter" + "Send"
LEGACY_LOWER = LEGACY_BRAND.lower()

# These files may contain legal attribution or exact compatibility bytes that existing
# PeerSync peers/data depend on. Any occurrence elsewhere is treated as a regression.
LEGACY_ALLOWLIST = {
    "LICENSE",
    "NOTICE",
    "README.md",
    "apps/portable-python/runtime/compat.py",
    "apps/portable-python/tests/test_updater.py",
    "packages/core/src/transport-compat.ts",
    "packages/core/src/portable/fs-engine.ts",
    "packages/core/src/worklet/peers/store.ts",
    "packages/core/schema/spec/hyperschema/index.js",
    "packages/core/schema/spec/hyperschema/schema.json",
    "packages/core/schema/spec/hyperdb/db.json",
    "packages/core/schema/spec/hyperdb/index.js",
    "packages/core/schema/spec/hyperdb/messages.js",
    "packages/drive/src/transport.ts",
    "packages/drive/src/adapters/publication.ts",
    "packages/drive/src/adapters/disk-writer.test.ts",
    "scripts/e2e-two-cores.py",
}

FORBIDDEN_EXACT = {
    ".clinerules",
    "kilo.json",
    "BASE-COMMIT.txt",
    "copy.png",
    "PSN.exe",
    "PSN.exe.update.json",
    "build-report.json",
    "docs/reference-check.md",
    "docs/operator-acceptance.md",
    "apps/portable-python/core_payload.py",
    "apps/portable-python/build_info.py",
}
FORBIDDEN_PARTS = {
    ".git",
    ".cursor",
    ".kilocode",
    ".kilo",
    ".pytest_cache",
    ".ruff_cache",
    ".tmp",
    "node_modules",
    "__pycache__",
    "dist",
    "build",
    "out",
    "data",
    "app",
}
FORBIDDEN_SUFFIXES = {
    ".pyc",
    ".pyo",
    ".exe",
    ".dll",
    ".zip",
    ".7z",
    ".rar",
    ".pfx",
    ".p12",
    ".p8",
    ".pem",
    ".key",
    ".jks",
    ".keystore",
}
SECRET_PATTERNS = {
    "private key block": re.compile(r"-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----"),
    "GitHub classic token": re.compile(r"\bgh[pousr]_[A-Za-z0-9]{20,}\b"),
    "GitHub fine-grained token": re.compile(r"\bgithub_pat_[A-Za-z0-9_]{20,}\b"),
    "AWS access key": re.compile(r"\bAKIA[0-9A-Z]{16}\b"),
    "PeerSync signing seed": re.compile(r"PEERSYNC_UPDATE_SIGNING_SEED\s*=\s*[0-9a-fA-F]{64}\b"),
}


def run_git(*args: str) -> str:
    proc = subprocess.run(
        ["git", *args],
        cwd=ROOT,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=False,
    )
    if proc.returncode != 0:
        raise RuntimeError(proc.stderr.strip() or f"git {' '.join(args)} failed")
    return proc.stdout


def candidate_files(working_tree: bool) -> list[str]:
    if working_tree:
        raw = run_git("ls-files", "--cached", "--others", "--exclude-standard", "-z")
        # An old local Git index may still contain paths deleted in the current
        # PeerSync working tree. They are not candidates for the fresh public repo.
        return sorted({p for p in raw.split("\0") if p and (ROOT / p).is_file()})
    raw = run_git("ls-files", "-z")
    return sorted({p for p in raw.split("\0") if p})


def looks_binary(data: bytes) -> bool:
    return b"\0" in data[:8192]


def path_problem(path: str) -> str | None:
    posix = PurePosixPath(path)
    if path in FORBIDDEN_EXACT:
        return "local/generated/upstream artifact must not be public source"
    if any(part in FORBIDDEN_PARTS for part in posix.parts):
        return "forbidden generated/local directory"
    if posix.suffix.lower() in FORBIDDEN_SUFFIXES:
        return f"forbidden public-source suffix {posix.suffix}"
    name = posix.name.lower()
    if name == ".env" or (name.startswith(".env.") and not name.endswith(".example")):
        return "environment secret file"
    return None


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--working-tree",
        action="store_true",
        help="scan tracked + untracked non-ignored files (use before the first commit)",
    )
    args = parser.parse_args()

    problems: list[str] = []
    files = candidate_files(args.working_tree)

    for rel in files:
        issue = path_problem(rel)
        if issue:
            problems.append(f"PATH {rel}: {issue}")
            continue
        p = ROOT / rel
        try:
            data = p.read_bytes()
        except OSError as exc:
            problems.append(f"READ {rel}: {exc}")
            continue
        if looks_binary(data):
            continue
        text = data.decode("utf-8", "replace")
        lowered = text.lower()
        if LEGACY_LOWER in lowered and rel not in LEGACY_ALLOWLIST:
            lines = [
                str(i)
                for i, line in enumerate(text.splitlines(), 1)
                if LEGACY_LOWER in line.lower()
            ][:8]
            problems.append(
                f"LEGACY {rel}:{','.join(lines)}: unexpected legacy product-name occurrence"
            )
        for label, pattern in SECRET_PATTERNS.items():
            match = pattern.search(text)
            if match:
                line = text.count("\n", 0, match.start()) + 1
                problems.append(f"SECRET {rel}:{line}: possible {label}")

    try:
        pkg = json.loads((ROOT / "package.json").read_text(encoding="utf-8"))
        if pkg.get("name") != "peersync":
            problems.append(f"PACKAGE package.json name is {pkg.get('name')!r}, expected 'peersync'")
        if pkg.get("private") is not True:
            problems.append("PACKAGE root package must remain private=true")
        if set(pkg.get("workspaces") or []) != {"packages/core", "packages/drive"}:
            problems.append("PACKAGE public workspaces must be exactly packages/core + packages/drive")
    except Exception as exc:
        problems.append(f"PACKAGE cannot validate package.json: {exc}")

    # Local safety: do not accidentally push back into an upstream repository.
    try:
        remotes = run_git("remote", "-v")
        for line in remotes.splitlines():
            if LEGACY_LOWER in line.lower():
                problems.append(f"REMOTE legacy upstream remote present: {line}")
    except RuntimeError:
        pass

    if problems:
        print("PUBLIC REPOSITORY HYGIENE: FAIL", file=sys.stderr)
        for problem in problems:
            print(f" - {problem}", file=sys.stderr)
        return 1

    mode = "working tree" if args.working_tree else "tracked source"
    print(f"PUBLIC REPOSITORY HYGIENE: PASS ({len(files)} files, {mode})")
    print(f"Legacy-name occurrences are restricted to {len(LEGACY_ALLOWLIST)} legal/compatibility files.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
