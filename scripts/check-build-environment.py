"""Reject a release compiler environment that differs from its hashed lock."""

from importlib import metadata
from pathlib import Path
import re
import sys

root = Path(__file__).resolve().parents[1]
expected = (root / '.python-version').read_text().strip()
actual = '.'.join(str(part) for part in sys.version_info[:3])
if actual != expected:
    raise SystemExit('Release build requires Python ' + expected + '; found ' + actual)
for line in (root / 'apps' / 'portable-python' / 'requirements-build.txt').read_text().splitlines():
    pinned = re.match(r'^([\w.-]+)==([^\s\\]+)', line)
    if not pinned:
        continue
    name, version = pinned.groups()
    try:
        installed = metadata.version(name)
    except metadata.PackageNotFoundError:
        installed = 'missing'
    if installed != version:
        raise SystemExit(name + ': expected ' + version + ', found ' + installed + '; install requirements-build.txt with --require-hashes')
print('Locked Python release compiler environment verified.')
