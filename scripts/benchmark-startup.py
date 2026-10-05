"""Measure frozen PSN.exe startup latency as p50/p95 for cold and warm runs.

The production audit requires a startup performance SLA instead of a single
observed number.  This harness reuses the exact readiness point the release
gates use (Core hello succeeded, see ``--update-ready`` in
``scripts/artifact-gui-smoke.py``), so its numbers are comparable with the GUI
smoke report.

Usage::

    python scripts/benchmark-startup.py dist/PSN.exe --runs 7 --out startup.json

Each sample pair uses a fresh portable directory for its first launch and the
same installed Core for its repeat launch. --runs is the number of pairs, so
both distributions have that many samples. "cold" means first installation,
not a flushed operating-system disk cache. Run on target hardware: an SSD
workstation, a clean Windows VM, and Defender real-time protection enabled.
Peak RAM is not sampled here; collect it next to this run with an external
process sampler.
"""

import argparse
import hashlib
import json
from pathlib import Path
import shutil
import secrets
import statistics
import subprocess
import sys
import tempfile
import time

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'apps' / 'portable-python'))

from runtime.updater import _wait_for_update_ready  # noqa: E402
from windows import process_tree  # noqa: E402


def percentile(values, fraction):
    if not values:
        return None
    ordered = sorted(values)
    index = min(len(ordered) - 1, max(0, int(round(fraction * (len(ordered) - 1)))))
    return round(ordered[index], 3)


def summarize(samples):
    if not samples:
        return None
    return {
        'runs': len(samples),
        'minSec': round(min(samples), 3),
        'p50Sec': round(statistics.median(samples), 3),
        'p95Sec': percentile(samples, 0.95),
        'maxSec': round(max(samples), 3),
    }


def one_run(current, folder, label):
    ready_dir = folder / 'data' / 'runtime'
    ready_dir.mkdir(parents=True, exist_ok=True)
    token = secrets.token_hex(32)
    marker = ready_dir / ('update-start-' + token + '.json')
    job = process_tree.create_kill_on_close_job()
    proc = None
    retired = False
    try:
        started = time.monotonic()
        proc = subprocess.Popen([str(current), '--update-ready=' + token], cwd=folder,
                                creationflags=process_tree.CREATE_SUSPENDED,
                                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        process_tree.assign_process(job, proc.pid)
        process_tree.resume_suspended_process(proc.pid)
        _wait_for_update_ready(proc, str(marker), token, str(current))
        elapsed = round(time.monotonic() - started, 3)
    finally:
        try:
            retired = process_tree.terminate_job_and_wait(job, timeout=15)
        finally:
            process_tree.close_job(job)
        if proc is not None:
            proc.wait(timeout=15)
    if not retired:
        raise RuntimeError('Benchmark process tree did not retire')
    return {'label': label, 'elapsedSec': elapsed}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('artifact', type=Path)
    parser.add_argument('--runs', type=int, default=7, help='number of first/repeat launch pairs')
    parser.add_argument('--out', type=Path)
    args = parser.parse_args()
    if args.runs < 1:
        parser.error('--runs must be positive')
    source = args.artifact.resolve()
    if not source.is_file():
        raise RuntimeError('artifact not found: %s' % source)

    samples = []
    for position in range(args.runs):
        folder = Path(tempfile.mkdtemp(prefix='psn-startup-')).resolve()
        if folder.parent != Path(tempfile.gettempdir()).resolve() or not folder.name.startswith('psn-startup-'):
            raise RuntimeError('Unexpected benchmark directory')
        try:
            current = folder / 'PSN.exe'
            shutil.copy2(source, current)
            for label in ('cold', 'warm'):
                sample = one_run(current, folder, label)
                sample['pair'] = position + 1
                samples.append(sample)
        finally:
            for attempt in range(100):
                try:
                    shutil.rmtree(folder)
                    break
                except OSError as exc:
                    if getattr(exc, 'winerror', None) not in (5, 32, 33) or attempt == 99:
                        raise
                    time.sleep(0.1)
    with source.open('rb') as handle:
        artifact_hash = hashlib.file_digest(handle, 'sha256').hexdigest()
    report = {
        'artifact': str(source),
        'runs': args.runs,
        'artifactSha256': artifact_hash,
        'coldMeaning': 'first launch with no installed Core',
        'warmMeaning': 'repeat launch with the same portable data and installed Core',
        'measurement': 'process spawn -> Core hello readiness (data/runtime/update-start-*.json)',
        'cold': summarize([item['elapsedSec'] for item in samples if item['label'] == 'cold']),
        'warm': summarize([item['elapsedSec'] for item in samples if item['label'] == 'warm']),
        'samples': samples,
    }
    payload = json.dumps(report, indent=2)
    if args.out is not None:
        args.out.write_text(payload, encoding='utf-8')
    print(payload)
    return 0


if __name__ == '__main__':
    raise SystemExit(main())