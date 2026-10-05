"""Exact-artifact release chain: the manifest writer and its fail-closed verifier.

The CI release job publishes the exact ``PSN.exe`` that passed the build, smoke,
E2E and reproducibility gates. These tests pin the properties that make that
claim true: the manifest describes the bytes, the tagged source reproduces the
recorded fingerprint, and the verifier refuses to publish anything that does not
match them or that it cannot fully inspect.
"""

import importlib.util
import contextlib
import io
import json
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

TESTS = Path(__file__).resolve().parent
APP_ROOT = TESTS.parent
REPO_ROOT = TESTS.parents[2]
SCRIPTS = REPO_ROOT / "scripts"
sys.path.insert(0, str(APP_ROOT))
sys.path.insert(0, str(SCRIPTS))

from source_fingerprint import file_sha256, source_fingerprint  # noqa: E402


def _load(name):
    spec = importlib.util.spec_from_file_location(name, SCRIPTS / (name + ".py"))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


release_manifest = _load("write-release-manifest")
release_verifier = _load("verify-release-artifact")

RELEASE_VERSION = "031026"
RELEASE_REVISION = 7


def _git(repo, *args, check=True):
    return subprocess.run(
        ["git", "-C", str(repo)] + list(args),
        check=check, capture_output=True, text=True,
    ).stdout.strip()


def _quiet(function, argv):
    """Run a release-tool entry point without letting its report reach test output."""
    with contextlib.redirect_stdout(io.StringIO()):
        return function(argv)


@unittest.skipUnless(shutil.which("git"), "git is required for the release-chain tests")
class ReleaseChainTests(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.root = Path(self._tmp.name)
        self.addCleanup(self._tmp.cleanup)
        self.psn = self.root / "PSN.exe"
        self.core = self.root / "PSNCore.exe"
        self.psn.write_bytes(b"tested launcher bytes")
        self.core.write_bytes(b"tested core bytes")
        self.manifest_path = self.root / "release-manifest.json"
        self.repo, self.commit, self.tag = self._repo("repo")

    def _repo(self, name, revision=RELEASE_REVISION, version=RELEASE_VERSION, tag=True,
              extra_files=None):
        repo = self.root / name
        repo.mkdir()
        _git(repo, "init", "-q")
        _git(repo, "config", "user.email", "release@example.invalid")
        _git(repo, "config", "user.name", "release test")
        (repo / "package.json").write_text(json.dumps({
            "name": "peersync", "version": "0.0.0",
            "releaseVersion": version, "releaseRevision": revision,
        }), encoding="utf-8")
        (repo / "source.txt").write_text("product source", encoding="utf-8")
        for relative, text in (extra_files or {}).items():
            target = repo / relative
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text(text, encoding="utf-8")
        _git(repo, "add", "-A")
        _git(repo, "commit", "-q", "-m", "release source")
        commit = _git(repo, "rev-parse", "HEAD")
        if tag:
            _git(repo, "tag", "v%s-r%d" % (version, revision))
        return repo, commit, "v%s-r%d" % (version, revision)

    def _write_manifest(self, commit, dirty="0", revision=RELEASE_REVISION,
                        version=RELEASE_VERSION, repo=None):
        return _quiet(release_manifest.main, [
            "--psn", str(self.psn),
            "--core", str(self.core),
            "--out", str(self.manifest_path),
            "--repo", str(repo if repo is not None else self.repo),
            "--release-version", version,
            "--release-revision", str(revision),
            "--commit", commit,
            "--dirty", dirty,
        ])

    def _verify(self, repo, commit, tag, psn=None):
        return _quiet(release_verifier.main, [
            "--manifest", str(self.manifest_path),
            "--psn", str(psn or self.psn),
            "--package", str(repo / "package.json"),
            "--repo", str(repo),
            "--tag", tag,
            "--commit", commit,
        ])

    def _expect_refusal(self, needle, repo, commit, tag, psn=None):
        with self.assertRaises(SystemExit) as caught:
            self._verify(repo, commit, tag, psn=psn)
        self.assertIn(needle, str(caught.exception))

    def test_manifest_describes_the_exact_bytes(self):
        commit = "0" * 40
        self.assertEqual(self._write_manifest(commit), 0)
        manifest = json.loads(self.manifest_path.read_text(encoding="utf-8"))
        self.assertEqual(manifest["schema"], "peersync-release-manifest-v1")
        self.assertEqual(manifest["releaseVersion"], RELEASE_VERSION)
        self.assertEqual(manifest["releaseRevision"], RELEASE_REVISION)
        self.assertEqual(manifest["releaseIdentity"], "%s+%d" % (RELEASE_VERSION, RELEASE_REVISION))
        self.assertEqual(manifest["psnSha256"], file_sha256(self.psn))
        self.assertEqual(manifest["psnBytes"], len(b"tested launcher bytes"))
        self.assertEqual(manifest["coreSha256"], file_sha256(self.core))
        self.assertEqual(manifest["commit"], commit)
        self.assertEqual(manifest["dirtyWorkingTree"], False)
        self.assertEqual(len(manifest["sourceFingerprint"]), 64)
        # The fingerprint is over the source tree the build ran from, not over
        # the temporary directory that happens to hold the artifacts.
        self.assertEqual(manifest["sourceFingerprint"], source_fingerprint(str(self.repo))[0])
        self.assertEqual(manifest["sourceFiles"], 2)

    def test_repository_fingerprint_covers_the_product_source(self):
        fingerprint, count = source_fingerprint(str(REPO_ROOT))
        self.assertEqual(len(fingerprint), 64)
        self.assertGreater(count, 10)

    def test_manifest_refuses_a_ddmmyy_shaped_but_invalid_version(self):
        with self.assertRaises(SystemExit):
            self._write_manifest("0" * 40, version="0310262")

    def test_manifest_refuses_a_non_positive_revision(self):
        with self.assertRaises(SystemExit):
            self._write_manifest("0" * 40, revision=0)

    def test_manifest_refuses_to_call_a_modified_tree_clean(self):
        # A lifecycle script or dependency step that edits tracked source after
        # the build's own check must never be published as a clean release.
        (self.repo / "source.txt").write_text("patched after the dirty check", encoding="utf-8")
        with self.assertRaises(SystemExit) as caught:
            self._write_manifest(self.commit, dirty="0")
        self.assertIn("uncommitted changes", str(caught.exception))

    def test_manifest_may_still_declare_a_dirty_tree(self):
        (self.repo / "source.txt").write_text("patched after the dirty check", encoding="utf-8")
        self.assertEqual(self._write_manifest(self.commit, dirty="1"), 0)
        manifest = json.loads(self.manifest_path.read_text(encoding="utf-8"))
        self.assertEqual(manifest["dirtyWorkingTree"], True)

    def test_verifier_accepts_the_exact_tested_bytes(self):
        self.assertEqual(self._write_manifest(self.commit), 0)
        self.assertEqual(self._verify(self.repo, self.commit, self.tag), 0)

    def test_verifier_refuses_different_bytes(self):
        self._write_manifest(self.commit)
        tampered = self.root / "tampered.exe"
        tampered.write_bytes(b"tested launcher byteS")
        with self.assertRaises(SystemExit) as caught:
            self._verify(self.repo, self.commit, self.tag, psn=tampered)
        self.assertIn("sha256", str(caught.exception))

    def test_verifier_refuses_a_truncated_executable(self):
        self._write_manifest(self.commit)
        truncated = self.root / "truncated.exe"
        truncated.write_bytes(b"short")
        with self.assertRaises(SystemExit) as caught:
            self._verify(self.repo, self.commit, self.tag, psn=truncated)
        self.assertIn("bytes", str(caught.exception))

    def test_verifier_refuses_a_different_commit(self):
        self._write_manifest(self.commit)
        with self.assertRaises(SystemExit) as caught:
            self._verify(self.repo, "1" * 40, self.tag)
        self.assertIn("released commit", str(caught.exception))

    def test_verifier_refuses_a_dirty_build(self):
        self._write_manifest(self.commit, dirty="1")
        with self.assertRaises(SystemExit) as caught:
            self._verify(self.repo, self.commit, self.tag)
        self.assertIn("dirty working tree", str(caught.exception))

    def test_verifier_requires_the_tag_to_exist_in_the_release_repository(self):
        repo, commit, tag = self._repo("untagged", tag=False)
        self._write_manifest(commit)
        self._expect_refusal(
            "not present in the release repository", repo, commit, tag,
        )

    def test_verifier_refuses_a_tag_with_a_foreign_version(self):
        repo, commit, _tag = self._repo("foreign", tag=False)
        _git(repo, "tag", "031026-r%d" % RELEASE_REVISION)
        self._write_manifest(commit)
        self._expect_refusal(
            "vDDMMYY-rREVISION", repo, commit, "031026-r%d" % RELEASE_REVISION,
        )

    def test_verifier_refuses_metadata_that_disagrees_with_the_tagged_source(self):
        repo, commit, tag = self._repo("newer", revision=RELEASE_REVISION + 1)
        self._write_manifest(commit, repo=repo)
        self._expect_refusal("does not name the manifest identity", repo, commit, tag)

    def test_verifier_requires_the_source_fingerprint_to_match_the_tagged_tree(self):
        # The bytes, commit and identity can all agree while the source the build
        # ran from is a different tree. A fingerprint of the right shape proves
        # nothing, so the tagged checkout has to reproduce the recorded value.
        self._write_manifest(self.commit)
        manifest = json.loads(self.manifest_path.read_text(encoding="utf-8"))
        manifest["sourceFingerprint"] = "0" * 64
        self.manifest_path.write_text(json.dumps(manifest), encoding="utf-8")
        self._expect_refusal("source fingerprint", self.repo, self.commit, self.tag)

    def test_verifier_refuses_a_source_tree_that_changed_after_the_build(self):
        self._write_manifest(self.commit)
        (self.repo / "source.txt").write_text("changed after the tested build", encoding="utf-8")
        _git(self.repo, "add", "-A")
        _git(self.repo, "commit", "-q", "-m", "source changed after the build")
        self._expect_refusal("source fingerprint", self.repo, self.commit, self.tag)

    def test_verifier_refuses_a_release_checkout_with_local_edits(self):
        self._write_manifest(self.commit)
        (self.repo / "source.txt").write_text("locally modified", encoding="utf-8")
        self._expect_refusal("not a clean tree", self.repo, self.commit, self.tag)

    def test_revision_must_move_forward_within_one_date(self):
        # r8 is already published, so a late r7 must never be published behind it.
        repo, commit, _tag = self._repo("history", tag=False)
        _git(repo, "tag", "v%s-r%d" % (RELEASE_VERSION, RELEASE_REVISION))
        _git(repo, "tag", "v%s-r%d" % (RELEASE_VERSION, RELEASE_REVISION + 1))
        self._write_manifest(commit)
        self._expect_refusal(
            "is not above the highest existing revision", repo, commit,
            "v%s-r%d" % (RELEASE_VERSION, RELEASE_REVISION),
        )

    def test_a_second_same_day_build_gets_its_own_identity(self):
        repo, commit, tag = self._repo("second", revision=RELEASE_REVISION + 1)
        self._write_manifest(commit, repo=repo, revision=RELEASE_REVISION + 1)
        self.assertEqual(self._verify(repo, commit, tag), 0)

    def test_verifier_refuses_a_tag_pointing_to_another_commit(self):
        self._write_manifest(self.commit)
        # Same source bytes, another commit: a source fingerprint alone cannot
        # establish that the tested build belongs to this tag.
        _git(self.repo, "commit", "--allow-empty", "-q", "-m", "different provenance")
        _git(self.repo, "tag", "-f", self.tag)
        _git(self.repo, "checkout", "-q", self.commit)
        self._expect_refusal("tag does not point", self.repo, self.commit, self.tag)

    def test_verifier_refuses_a_checkout_at_another_commit_with_identical_source(self):
        self._write_manifest(self.commit)
        _git(self.repo, "commit", "--allow-empty", "-q", "-m", "different checkout")
        self._expect_refusal("checkout HEAD", self.repo, self.commit, self.tag)

    def test_manifest_refuses_an_unknown_repository_state(self):
        from unittest import mock
        with mock.patch.object(release_manifest.subprocess, "check_output", side_effect=OSError("git unavailable")):
            with self.assertRaisesRegex(SystemExit, "uncommitted changes"):
                self._write_manifest(self.commit)

    def test_manifest_rejects_impossible_dates_and_unbounded_revisions(self):
        for value in ("310226", "290225", "000126"):
            with self.subTest(version=value), self.assertRaises(SystemExit):
                self._write_manifest(self.commit, version=value)
        with self.assertRaises(SystemExit):
            self._write_manifest(self.commit, revision=100000000)

    def test_verifier_rejects_malformed_manifest_types(self):
        for field, value in (("releaseRevision", 7.1), ("releaseRevision", "7"),
                             ("dirtyWorkingTree", None), ("psnBytes", True),
                             ("sourceFiles", "2"), ("sourceFingerprint", "z" * 64)):
            with self.subTest(field=field, value=value):
                self._write_manifest(self.commit)
                manifest = json.loads(self.manifest_path.read_text())
                manifest[field] = value
                self.manifest_path.write_text(json.dumps(manifest), encoding="utf-8")
                with self.assertRaises(SystemExit):
                    self._verify(self.repo, self.commit, self.tag)

    @unittest.skipUnless(shutil.which("powershell"), "Windows build metadata requires PowerShell")
    def test_nested_source_export_never_inherits_clean_parent_metadata(self):
        source = (SCRIPTS / "build-portable-win.ps1").read_text(encoding="utf-8")
        start = source.index("function Get-GitReleaseMetadata(")
        end = source.index("function Get-WorkingTreeDirty(", start)
        probe = self.root / "metadata-probe.ps1"
        probe.write_text(
            "param([string]$RepoPath)\n" + source[start:end]
            + "Get-GitReleaseMetadata -RepoPath $RepoPath | ConvertTo-Json\n",
            encoding="utf-8",
        )
        exported = self.repo / "build/export"
        exported.mkdir(parents=True)
        for repo, expected_dirty, expected_commit in (
                (self.repo, False, self.commit), (exported, True, "unknown")):
            result = subprocess.check_output(
                ["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", str(probe), str(repo)],
                text=True,
            )
            metadata = json.loads(result)
            self.assertEqual(metadata["Dirty"], expected_dirty)
            self.assertEqual(metadata["Commit"], expected_commit)

    def test_generated_report_does_not_change_an_export_source_identity(self):
        exported = self.root / "source-export"
        exported.mkdir()
        (exported / "source.txt").write_text("product source", encoding="utf-8")
        before = source_fingerprint(str(exported))
        (exported / "build-report.json").write_text('{"ok": true}', encoding="utf-8")
        self.assertEqual(source_fingerprint(str(exported)), before)

    def test_nested_export_has_the_same_source_identity(self):
        # Git succeeds but lists zero files in an ignored nested build export.
        (self.repo / ".gitignore").write_text("build/\n", encoding="utf-8")
        _git(self.repo, "add", ".gitignore")
        _git(self.repo, "commit", "-q", "-m", "ignore outputs")
        export = self.repo / "build/export"
        export.mkdir(parents=True)
        for name in ("source.txt", "package.json", ".gitignore"):
            shutil.copy2(self.repo / name, export / name)
        self.assertEqual(source_fingerprint(str(self.repo)), source_fingerprint(str(export)))

    def test_a_shallow_release_checkout_cannot_prove_monotonicity(self):
        # Reproduces the default actions/checkout shape: a shallow, single-tag
        # clone of the revision being released while a higher revision already
        # exists on the remote. Answering "no higher revision is published" from
        # that view is what let a lower revision be published behind a higher
        # one, so the verifier refuses to reason about an incomplete tag history.
        remote = self.root / "remote.git"
        _git(self.root, "init", "--bare", "-q", str(remote))
        origin, released_commit, _tag = self._repo("origin", tag=False)
        _git(origin, "remote", "add", "origin", str(remote))
        _git(origin, "tag", self.tag)
        _git(origin, "push", "-q", "origin", "HEAD:refs/heads/main",
             "refs/tags/%s:refs/tags/%s" % (self.tag, self.tag))

        # A later same-day hotfix is published from its own commit.
        (origin / "hotfix.txt").write_text("second revision\n", encoding="utf-8")
        _git(origin, "add", "-A")
        _git(origin, "commit", "-q", "-m", "same-day hotfix")
        _git(origin, "tag", "v%s-r%d" % (RELEASE_VERSION, RELEASE_REVISION + 1))
        _git(origin, "push", "-q", "origin", "HEAD:refs/heads/main",
             "refs/tags/v%s-r%d:refs/tags/v%s-r%d" % (
                 RELEASE_VERSION, RELEASE_REVISION + 1,
                 RELEASE_VERSION, RELEASE_REVISION + 1))

        shallow = self.root / "shallow"
        # Exactly what actions/checkout does for a tag build with its default
        # fetch depth: fetch one refspec, no tags.
        _git(self.root, "init", "-q", str(shallow))
        _git(shallow, "remote", "add", "origin", str(remote))
        _git(shallow, "fetch", "-q", "--depth", "1", "--no-tags", "origin",
             "+refs/tags/%s:refs/tags/%s" % (self.tag, self.tag))
        _git(shallow, "checkout", "-q", self.tag)
        self.assertEqual(_git(shallow, "tag", "--list", "v*-r*"), self.tag)
        self.assertEqual(_git(shallow, "rev-parse", "--is-shallow-repository"), "true")
        self.assertEqual(_git(shallow, "rev-parse", "HEAD"), released_commit)
        # The shallow view looks complete and would happily accept the lower
        # revision...
        self.assertEqual(self._write_manifest(released_commit, repo=shallow), 0)
        # ...which is exactly why the verifier must refuse to judge it.
        self._expect_refusal("complete tag history", shallow, released_commit, self.tag)

        # With the complete history the higher revision is visible and refused.
        full = self.root / "full"
        _git(self.root, "init", "-q", str(full))
        _git(full, "remote", "add", "origin", str(remote))
        _git(full, "fetch", "-q", "origin",
             "+refs/heads/*:refs/remotes/origin/*", "+refs/tags/*:refs/tags/*")
        _git(full, "checkout", "-q", self.tag)
        self.assertEqual(_git(full, "rev-parse", "--is-shallow-repository"), "false")
        self.assertEqual(_git(full, "rev-parse", "HEAD"), released_commit)
        self.assertEqual(self._write_manifest(released_commit, repo=full), 0)
        self._expect_refusal(
            "is not above the highest existing revision", full, released_commit, self.tag)


if __name__ == "__main__":
    unittest.main()