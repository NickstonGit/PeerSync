# Contributing to PeerSync by Nickston

Thanks for your interest in contributing to **PeerSync by Nickston**.

This repository develops the PeerSync Windows application and its P2P transport.

## Prerequisites

- Windows
- Git
- Node.js 22
- npm
- Python 3.14
- PowerShell

For portable executable builds, install the Python packaging requirements from `apps/portable-python/requirements-build.txt`.

## Setup

Clone the repository, enter its root directory and install dependencies:

```powershell
git clone <repository-url>
cd <repository-directory>
npm ci
python -m pip install -r apps\portable-python\requirements-build.txt
```

The repository uses npm workspaces for the supported portable packages.

## Supported project areas

The maintained project areas are:

```text
apps/portable-python/   Windows portable UI/runtime
packages/core/          Portable P2P core and protocol
packages/drive/         File-transfer engine
scripts/                Build and validation tooling
docs/                   Public technical documentation
```

Private workspace names use the `@peersync` scope. Preserve persisted-state and transport contracts unless a versioned migration is planned.

## Local validation

Before opening a pull request, run the same main checks used by CI:

```powershell
npm audit --omit=dev --audit-level=high
npm run typecheck
npm run test:portable
npm run build
npm run lint:portable
python -m unittest discover -s apps/portable-python/tests -q
python -m compileall -q apps/portable-python scripts
```

The production dependency audit is intentionally limited to production dependencies. Do not run `npm audit fix` blindly; dependency updates should be reviewed deliberately.

## Portable build

To build and smoke-test the Windows portable application:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\build-portable-win.ps1
```

The build script performs the portable core build, Python packaging and project smoke/integrity checks. Generated artifacts are written under `dist/` and must not be committed.

## Making changes

1. Create a branch from `main`.
2. Keep changes focused and avoid unrelated formatting churn.
3. Add or update tests for behavior changes where practical.
4. Run the local validation commands above.
5. Open a pull request and describe what changed and how it was tested.

## Code style

- TypeScript changes must pass the configured ESLint rules.
- Python changes must compile successfully under Python 3.14.
- Prefer clear code over explanatory comments. Add comments when they document a non-obvious constraint, invariant or workaround.
- Do not commit local runtime data, build output, logs, credentials, private keys or environment-specific files.

## Transport attribution

Preserve applicable source copyright and license notices when modifying transport code. Its origin is recorded in [NOTICE](NOTICE).

## Security issues

Do not report security vulnerabilities in a public issue. Follow [SECURITY.md](SECURITY.md).
