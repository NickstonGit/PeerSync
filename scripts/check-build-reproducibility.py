"""Build the current source in an isolated export and compare both EXEs.

The export includes reviewed working-tree changes and excludes generated
files. It installs its own npm graph and regenerates Core and Python payload.
Run after scripts/build-portable-win.ps1; build tool overrides are inherited.
"""

import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from source_fingerprint import file_sha256 as digest, source_file_names, source_fingerprint


def main():
    root = Path(__file__).resolve().parents[1]
    report_path = root / 'dist' / 'reproducibility.json'
    report_path.unlink(missing_ok=True)
    manifest = json.loads((root / 'dist/release-manifest.json').read_text(encoding='utf-8'))
    fingerprint, source_count = source_fingerprint(root)
    if manifest['sourceFingerprint'] != fingerprint or manifest['sourceFiles'] != source_count:
        raise RuntimeError('Source changed since the first build; rebuild before checking reproducibility')
    if digest(root / 'dist/PSN.exe') != manifest['psnSha256'] or digest(root / 'build/core/PSNCore.exe') != manifest['coreSha256']:
        raise RuntimeError('First-build artifacts do not match their release manifest')
    exported = root / 'build' / ('repro-source-' + str(time.time_ns()))
    exported.mkdir(parents=True)
    # One shared definition of "product source": the release manifest fingerprints
    # exactly this file set, so the two gates cannot drift apart.
    names = source_file_names(root)
    copied = 0
    for name in names:
        source = root / name
        if not source.is_file():
            continue
        target = exported / name
        if not target.resolve().is_relative_to(exported.resolve()):
            raise RuntimeError('Source path escaped export')
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(source, target)
        copied += 1
    if source_fingerprint(exported) != (fingerprint, source_count):
        raise RuntimeError('Independent source export differs from the first-build source')
    build_env = os.environ.copy()
    # Independence requires a fresh install even if the first local build reused
    # audited dependencies through a developer override.
    build_env.pop('PEERSYNC_SKIP_NPM_CI', None)
    log_path = root / 'build' / 'repro-build.log'
    with log_path.open('w', encoding='utf-8') as log:
        result = subprocess.run(
            ['powershell', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File',
             str(exported / 'scripts' / 'build-portable-win.ps1')],
            cwd=exported, env=build_env, stdout=log, stderr=subprocess.STDOUT,
            timeout=1800,
        )
    if result.returncode:
        raise RuntimeError('Independent build failed; see ' + str(log_path))
    second_manifest = json.loads((exported / 'dist/release-manifest.json').read_text(encoding='utf-8'))
    if second_manifest['sourceFingerprint'] != fingerprint or second_manifest['sourceFiles'] != source_count:
        raise RuntimeError('Independent build source identity drifted during the build')
    comparisons = []
    for relative in ('build/core/PSNCore.exe', 'dist/PSN.exe'):
        first = digest(root / relative)
        second = digest(exported / relative)
        comparisons.append({'artifact': relative, 'firstSha256': first, 'secondSha256': second, 'equal': first == second})
    report = {'ok': all(row['equal'] for row in comparisons), 'sourceExport': str(exported),
              'sourceFiles': copied, 'sourceFingerprint': fingerprint, 'artifacts': comparisons}
    report_path.write_text(json.dumps(report, indent=2), encoding='utf-8')
    print(json.dumps(report, indent=2))
    return 0 if report['ok'] else 1


if __name__ == '__main__':
    raise SystemExit(main())
