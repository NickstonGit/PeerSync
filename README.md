# PeerSync by Nickston

**PeerSync by Nickston** is a portable Windows application for peer-to-peer file transfer, folder synchronization and chat between remembered devices.

The application combines a Python/Tk interface, Windows integration and a standalone P2P core.

## Current focus

- Portable Windows client
- Direct peer-to-peer file transfer
- Remembered-device pairing
- Local and remote peer discovery through the Hyperswarm-based core
- Integrity checks for transferred and update payloads
- No account requirement for the portable workflow

This repository contains the Windows portable application, its transport and its build and validation tools.

## How it works

The application consists of two main parts:

- **Python Windows shell** in `apps/portable-python` — UI, local runtime management, IPC and Windows integration.
- **Portable core** in `packages/core` with `packages/drive` — peer discovery, authenticated P2P communication and file-transfer logic.

The shell and core communicate through framed JSON IPC. File-transfer traffic is handled by the P2P core rather than by cloud storage.

## Requirements

For development and local builds:

- Windows
- Node.js 22.23.3 (pinned in `.node-version`)
- npm
- Python 3.14.8 (pinned in `.python-version`)
- PowerShell

Install JavaScript dependencies:

```powershell
npm ci
```

Install Python packaging dependencies when you need to build the portable executable:

```powershell
python -m pip install --require-hashes -r apps\portable-python\requirements-build.txt
```

## Development checks

These commands match the main checks used by CI:

```powershell
python -m pip install ruff==0.16.1 pip-audit==2.10.1
npm audit --audit-level=high
npm run typecheck
npm run test:portable
npm run build
npm run lint:portable
python -m unittest discover -s apps/portable-python/tests -q
python -m compileall -q apps/portable-python scripts
ruff check apps/portable-python scripts
python -m pip_audit -r apps/portable-python/requirements-build.txt --require-hashes --disable-pip
```

## Build

Run the Windows portable build from the repository root:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\build-portable-win.ps1
```

The build script compiles the portable core, packages the Python application and runs the project smoke/integrity gates. The main portable artifact is `dist/PSN.exe`. Generated build output is written under `dist/` and is not committed to Git.

The Python lock is generated from `requirements-build.in` with `pip-compile --allow-unsafe --generate-hashes`. Release builds use a fixed Python hash seed and `SOURCE_DATE_EPOCH` (default: the release date at midnight UTC). To use isolated build tools, set `PEERSYNC_BUILD_PYTHON` to the Python executable and `PEERSYNC_BUILD_NODE_DIR` to the directory containing the pinned Node executable.

After building, run `python scripts/check-build-reproducibility.py` to rebuild an isolated source export with a separate npm install and compare both EXEs byte for byte. CI also runs direct kill/resume, actual relay transfer and discovery/reconnect before accepting the artifact reports.

Use `python scripts/benchmark-startup.py dist/PSN.exe --runs 10 --out startup.json` to record first-install/repeat-launch startup p50/p95 (10 pairs, with the same installed Core reused in each pair) at the same readiness point the release gates use. The scenarios that a build script cannot honestly produce — clean-VM first run, reboot inside an update transaction, large-tree and soak measurements — are listed in [docs/release-acceptance.md](docs/release-acceptance.md) and must be recorded there before a release is cut.

## Versioning

PeerSync uses a date-only product version in `DDMMYY` format, for example `230926`, plus a monotonic within-day **revision**. The UI keeps showing the date; the revision is the machine-orderable identity, so two different official builds of the same calendar date stay distinguishable to update ordering. There is no public SemVer prefix and no `n-` prefix. The old `2.x / n-DDMMYY` values are read only for pre-PeerSync compatibility and are never generated for new releases.

Launcher updates are transactional: a durable `data/runtime/update-pending.json`, a known-good backup and an acknowledged detached watchdog cover interruptions in the current session. Updates create no registry entries or OS autostart. After reboot or power loss, recovery resumes at the next explicit launch; if the new executable cannot start, the known-good helper or `PSN.exe.bak` restores it. See [docs/update-recovery.md](docs/update-recovery.md).

Use `npm run version:portable -- [DDMMYY] [revision]` to set the release identity. Omitting the revision keeps the current one, so a same-day hotfix never silently reuses a released revision; a new `DDMMYY` label requires an explicit revision. Private npm workspaces use the neutral technical version `0.0.0`; it is not a PeerSync product version and is never shown in the UI.

## Releasing

A release is the exact executable that passed CI, not a local rebuild:

1. Bump the release identity and commit it.
2. `git tag v<DDMMYY>-r<revision>` and push the tag.

Pushing the tag runs `.github/workflows/checks.yml`: build → frozen smoke and
GUI readiness → direct/relay/discovery/reproducibility gates → upload
`dist/PSN.exe` together with `dist/release-manifest.json` as an immutable
artifact. The `release` job then downloads exactly that artifact, recomputes
its SHA-256, and re-checks the commit, the tag name, the tagged
`package.json` and the `sourceFingerprint` against the tagged checkout with
`scripts/verify-release-artifact.py`. It never runs PyInstaller and never
rebuilds Core, so the published SHA-256 always equals the tested SHA-256. The
verifier also refuses to judge release-revision monotonicity from a shallow
clone, so the release job checks out the complete tag history.

## Project structure

```text
apps/
  portable-python/   Windows portable UI/runtime
packages/
  core/              Portable P2P core and protocol
  drive/             File-transfer engine
scripts/             Build, smoke-test and validation tooling
docs/                Public technical documentation
```

The private workspaces are `@peersync/core` and `@peersync/drive`. Stable transport and storage identifiers preserve compatibility with previous PeerSync releases; see [docs/architecture.md](docs/architecture.md).

## CI and security

Pull requests and pushes to `main` run the portable checks in `.github/workflows/checks.yml`. Pushing a `v<DDMMYY>-r<revision>` tag runs the same checks and then publishes the tested artifact as a GitHub Release. CodeQL analysis is configured separately in `.github/workflows/codeql.yml`.

For security issues, see [SECURITY.md](SECURITY.md). Please do not disclose vulnerabilities in a public issue.

## Transport lineage

PeerSync is an independent application. Its P2P transport layer started from Apache-2.0 transport components of the open-source AlterSend project and has since been adapted for PeerSync's portable Windows architecture, file-operation model, recovery, IPC and release pipeline. This attribution does not imply affiliation or endorsement. See [NOTICE](NOTICE).

## Contributing

Contributions are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md) for the development workflow and local validation commands.

## License

This repository is distributed under the [Apache License 2.0](LICENSE). See [NOTICE](NOTICE) for transport attribution.
