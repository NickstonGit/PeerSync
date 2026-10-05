"""Verify the exact tested artifact before it is published as a release.

This is the fail-closed half of the exact-artifact chain. It never rebuilds and
never regenerates anything: it recomputes the hashes of the bytes that were
downloaded from the CI artifact and refuses to publish unless they are the
bytes the manifest, the tagged source and the repository metadata all agree on.

Checks, in order:

* the manifest is a well-formed ``peersync-release-manifest-v1`` record;
* the release repository is a full clone, so release-tag enumeration cannot be
  answered from an incomplete local view;
* ``PSN.exe`` exists with exactly the recorded size and SHA-256;
* the release was not produced from a dirty working tree;
* the manifest commit is the commit being released;
* the release tag is exactly ``v<DDMMYY>-r<revision>``;
* the tagged ``package.json`` carries the same version and revision;
* the tagged source reproduces the recorded ``sourceFingerprint``, which is what
  turns ``tested bytes -> published bytes`` into ``tagged source -> published
  bytes``;
* no existing tag already claims this ``(releaseVersion, releaseRevision)`` and
  no existing revision for this date is greater or equal to this one.
"""

import argparse
from datetime import datetime
import json
import os
import re
import subprocess
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from source_fingerprint import file_sha256, source_fingerprint

SCHEMA = "peersync-release-manifest-v1"
RELEASE_TAG_RE = re.compile(r"^v(?P<version>\d{6})-r(?P<revision>\d{1,8})$")
COMMIT_RE = re.compile(r"^[0-9a-f]{40}$")


def fail(message):
    raise SystemExit("release verification failed: " + message)


def require(condition, message):
    if not condition:
        fail(message)


def git_output(repo, *args):
    try:
        raw = subprocess.check_output(
            ["git", "-C", repo] + list(args),
            stderr=subprocess.DEVNULL,
        )
    except (OSError, subprocess.CalledProcessError):
        fail("git %s failed in %s" % (" ".join(args), repo))
    return raw.decode("utf-8", "replace").strip()


def require_complete_history(repo):
    """A shallow clone cannot answer "is a higher revision already published?".

    ``actions/checkout`` defaults to a shallow, single-tag clone, where the
    local repository only knows the tag being released. Monotonicity checked
    against that view silently accepts a revision that is already behind a
    published one, so refuse to verify in a shallow repository at all.
    """
    if git_output(repo, "rev-parse", "--is-shallow-repository") == "true":
        fail(
            "release verification needs the complete tag history of %s; "
            "check out with fetch-depth: 0 and fetch --tags" % repo
        )


def existing_tags(repo):
    try:
        raw = subprocess.check_output(
            ["git", "-C", repo, "tag", "--list", "v*-r*"],
            stderr=subprocess.DEVNULL,
        )
    except (OSError, subprocess.CalledProcessError):
        fail("cannot list release tags in " + repo)
    return sorted(tag.decode("ascii", "replace").strip() for tag in raw.splitlines() if tag.strip())


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--manifest", required=True)
    parser.add_argument("--psn", required=True)
    parser.add_argument("--package", required=True)
    parser.add_argument("--repo", required=True)
    parser.add_argument("--tag", required=True)
    parser.add_argument("--commit", default="")
    args = parser.parse_args(argv)

    require(os.path.isfile(args.manifest), "release manifest is missing: " + args.manifest)
    try:
        with open(args.manifest, encoding="utf-8") as handle:
            manifest = json.load(handle)
    except (OSError, ValueError) as exc:
        fail("release manifest is unreadable: %s" % exc)
    require(isinstance(manifest, dict), "release manifest must be a JSON object")
    require(manifest.get("schema") == SCHEMA, "unexpected manifest schema %r" % manifest.get("schema"))

    release_version = str(manifest.get("releaseVersion") or "")
    require(re.fullmatch(r"\d{6}", release_version), "invalid releaseVersion %r" % release_version)
    try:
        datetime.strptime(release_version, "%d%m%y")
    except ValueError:
        fail("invalid release calendar date %r" % release_version)
    release_revision = manifest.get("releaseRevision")
    if type(release_revision) is not int:
        fail("invalid releaseRevision %r" % manifest.get("releaseRevision"))
    require(1 <= release_revision <= 99999999, "releaseRevision out of range: %r" % release_revision)
    require(
        str(manifest.get("releaseIdentity") or "") == "%s+%d" % (release_version, release_revision),
        "releaseIdentity %r does not match %s+%d"
        % (manifest.get("releaseIdentity"), release_version, release_revision),
    )
    require(
        bool(re.fullmatch(r"[0-9a-f]{64}", str(manifest.get("sourceFingerprint") or ""))),
        "sourceFingerprint is missing or malformed",
    )

    require(manifest.get("dirtyWorkingTree") is False, "artifact was built from a dirty working tree or lacks a clean-tree declaration")
    for field in ("sourceFiles", "psnBytes", "coreBytes"):
        value = manifest.get(field)
        require(type(value) is int and value > 0, "invalid %s %r" % (field, value))
    for field in ("psnSha256", "coreSha256"):
        require(bool(re.fullmatch(r"[0-9a-f]{64}", str(manifest.get(field) or ""))), "invalid " + field)

    # Release-tag enumeration below is only as complete as this clone, and the
    # source fingerprint is only meaningful when it is the tagged tree itself.
    require_complete_history(args.repo)
    require(
        git_output(args.repo, "status", "--porcelain") == "",
        "release checkout is not a clean tree: the tagged source cannot be verified",
    )

    manifest_commit = str(manifest.get("commit") or "")
    require(bool(COMMIT_RE.fullmatch(manifest_commit)), "manifest commit %r is not a full sha" % manifest_commit)
    expected_commit = str(args.commit or "").strip().lower()
    require(
        expected_commit == manifest_commit,
        "manifest commit %s does not match the released commit %s" % (manifest_commit, expected_commit),
    )

    # Source provenance: the manifest's fingerprint must be reproducible from the
    # tagged checkout itself. A manifest field that is only checked for shape
    # proves nothing about the source the tested bytes came from.
    recorded_fingerprint = str(manifest.get("sourceFingerprint") or "").lower()
    actual_fingerprint, actual_source_files = source_fingerprint(os.path.abspath(args.repo))
    require(
        actual_fingerprint == recorded_fingerprint,
        "source fingerprint %s of the tagged checkout does not match the built manifest %s"
        % (actual_fingerprint, recorded_fingerprint),
    )
    require(
        int(manifest.get("sourceFiles") or -1) == actual_source_files,
        "manifest describes %r source files, the tagged checkout has %d"
        % (manifest.get("sourceFiles"), actual_source_files),
    )

    # The bytes: this is the whole point of the chain.
    require(os.path.isfile(args.psn), "released executable is missing: " + args.psn)
    actual_bytes = os.path.getsize(args.psn)
    require(
        actual_bytes == int(manifest.get("psnBytes") or -1),
        "PSN.exe is %d bytes, manifest says %r" % (actual_bytes, manifest.get("psnBytes")),
    )
    actual_sha = file_sha256(args.psn)
    require(
        actual_sha == str(manifest.get("psnSha256") or "").lower(),
        "PSN.exe sha256 %s does not match the tested manifest %r" % (actual_sha, manifest.get("psnSha256")),
    )

    # The tag is the human-readable name of exactly this identity.
    tag_match = RELEASE_TAG_RE.fullmatch(args.tag or "")
    require(bool(tag_match), "release tag %r must look like vDDMMYY-rREVISION" % args.tag)
    require(
        tag_match.group("version") == release_version and int(tag_match.group("revision")) == release_revision,
        "tag %s does not name the manifest identity %s+%d" % (args.tag, release_version, release_revision),
    )

    require(args.tag in existing_tags(args.repo), "tag %s is not present in the release repository" % args.tag)
    require(
        git_output(args.repo, "rev-parse", "HEAD") == manifest_commit,
        "release checkout HEAD does not match the manifest commit",
    )
    require(
        git_output(args.repo, "rev-parse", "refs/tags/" + args.tag + "^{commit}") == manifest_commit,
        "release tag does not point to the manifest commit",
    )

    try:
        with open(args.package, encoding="utf-8") as handle:
            package = json.load(handle)
    except (OSError, ValueError) as exc:
        fail("package.json is unreadable: %s" % exc)
    require(isinstance(package, dict), "package.json must be a JSON object")
    require(
        str(package.get("releaseVersion")) == release_version,
        "package.json releaseVersion %r != %r" % (package.get("releaseVersion"), release_version),
    )
    require(
        type(package.get("releaseRevision")) is int and package.get("releaseRevision") == release_revision,
        "package.json releaseRevision %r != %r" % (package.get("releaseRevision"), release_revision),
    )

    # The release tag is created by the tag push, so it is present locally, and
    # require_complete_history() above guarantees that this local view is the
    # whole tag set rather than a single shallow tag. Every *other* tag for the
    # same date must carry a strictly lower revision: one (date, revision) names
    # exactly one published artifact and revisions never move backwards.
    tags = existing_tags(args.repo)
    require(args.tag in tags, "tag %s is not present in the release repository" % args.tag)
    highest = 0
    for tag in tags:
        if tag == args.tag:
            continue
        match = RELEASE_TAG_RE.fullmatch(tag)
        if not match or match.group("version") != release_version:
            continue
        highest = max(highest, int(match.group("revision")))
    require(
        highest < release_revision,
        "release revision %d is not above the highest existing revision %d for %s"
        % (release_revision, highest, release_version),
    )

    print(json.dumps({
        "ok": True,
        "tag": args.tag,
        "releaseIdentity": manifest["releaseIdentity"],
        "commit": manifest_commit,
        "sourceFingerprint": manifest["sourceFingerprint"],
        "psnSha256": actual_sha,
        "psnBytes": actual_bytes,
    }, indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    sys.exit(main())
