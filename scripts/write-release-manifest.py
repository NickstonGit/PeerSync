"""Write the immutable release manifest for the exact tested PSN.exe.

The manifest travels with the executable through CI upload, artifact download
and the release job. It exists so the published bytes are *provably* the bytes
that passed build, smoke, E2E and reproducibility gates: the release job
recomputes every hash and re-checks the commit, the tagged source fingerprint and
the version instead of rebuilding anything.

``--dirty`` is a claim made by the build script, so it is cross-checked against
``git status`` here: a manifest may declare a dirty tree, but it may never claim a
clean one while the tree actually carries changes. That keeps a lifecycle script
or dependency step that edits tracked source *after* the build script's own
check from being published as a clean, reproducible release.
"""

import argparse
from datetime import datetime
import json
import os
import subprocess
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from source_fingerprint import file_sha256, source_fingerprint


def _positive_int(value, name):
    try:
        parsed = int(value)
    except (TypeError, ValueError) as exc:
        raise SystemExit("%s must be an integer, got %r" % (name, value)) from exc
    if not 1 <= parsed <= 99999999:
        raise SystemExit("%s must be 1..99999999, got %r" % (name, value))
    return parsed


def _working_tree_dirty(root):
    """Fail closed when the checkout state cannot be determined."""
    if not os.path.exists(os.path.join(root, ".git")):
        return True
    try:
        raw = subprocess.check_output(
            ["git", "-C", root, "status", "--porcelain"],
            stderr=subprocess.DEVNULL,
        )
    except (OSError, subprocess.CalledProcessError):
        return True
    return bool(raw.strip())


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--psn", required=True)
    parser.add_argument("--core", required=True)
    parser.add_argument("--out", required=True)
    parser.add_argument("--release-version", required=True)
    parser.add_argument("--release-revision", required=True)
    parser.add_argument("--repo", default=os.path.abspath(os.path.join(os.path.dirname(__file__), os.pardir)))
    parser.add_argument("--commit", default="unknown")
    parser.add_argument("--dirty", default="0")
    args = parser.parse_args(argv)

    if not os.path.isfile(args.psn):
        raise SystemExit("release artifact is missing: " + args.psn)
    if not os.path.isfile(args.core):
        raise SystemExit("core artifact is missing: " + args.core)
    if len(args.release_version) != 6 or not args.release_version.isdigit():
        raise SystemExit("release version must be DDMMYY, got " + args.release_version)

    try:
        datetime.strptime(args.release_version, "%d%m%y")
    except ValueError as exc:
        raise SystemExit("invalid release calendar date: " + args.release_version) from exc

    root = os.path.abspath(args.repo)
    claimed_dirty = str(args.dirty) == "1"
    if _working_tree_dirty(root) and not claimed_dirty:
        raise SystemExit(
            "release manifest refused: %s has uncommitted changes; "
            "build a tagged, clean tree or pass --dirty 1" % root
        )
    fingerprint, source_files = source_fingerprint(root)
    revision = _positive_int(args.release_revision, "release revision")

    manifest = {
        "schema": "peersync-release-manifest-v1",
        "releaseVersion": args.release_version,
        "releaseRevision": revision,
        "releaseIdentity": "%s+%d" % (args.release_version, revision),
        "commit": str(args.commit or "unknown"),
        "dirtyWorkingTree": claimed_dirty,
        "sourceFingerprint": fingerprint,
        "sourceFiles": source_files,
        "psnName": "PSN.exe",
        "psnSha256": file_sha256(args.psn),
        "psnBytes": os.path.getsize(args.psn),
        "coreName": os.path.basename(args.core),
        "coreSha256": file_sha256(args.core),
        "coreBytes": os.path.getsize(args.core),
    }
    os.makedirs(os.path.dirname(os.path.abspath(args.out)) or ".", exist_ok=True)
    with open(args.out, "w", encoding="utf-8", newline="\n") as handle:
        json.dump(manifest, handle, indent=2, sort_keys=True)
        handle.write("\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
