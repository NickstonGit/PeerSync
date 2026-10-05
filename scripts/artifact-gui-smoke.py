"""Verify real frozen GUI/Core startup and retire its entire Windows Job."""

import json
from pathlib import Path
import secrets
import shutil
import subprocess
import sys
import tempfile
import time

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'apps' / 'portable-python'))

from runtime.updater import _wait_for_update_ready  # noqa: E402
from windows import process_tree  # noqa: E402


def main():
    source = Path(sys.argv[1]).resolve()
    folder = Path(tempfile.mkdtemp(prefix='psn-gui-smoke-')).resolve()
    if folder.parent != Path(tempfile.gettempdir()).resolve() or not folder.name.startswith('psn-gui-smoke-'):
        raise RuntimeError('Unexpected smoke directory')
    current = folder / 'PSN.exe'
    shutil.copy2(source, current)
    ready_dir = folder / 'data' / 'runtime'
    ready_dir.mkdir(parents=True)
    token = secrets.token_hex(32)
    marker = ready_dir / ('update-start-' + token + '.json')
    job = process_tree.create_kill_on_close_job()
    proc = None
    retired = False
    started = time.monotonic()
    try:
        proc = subprocess.Popen([str(current), '--update-ready=' + token], cwd=folder,
                                creationflags=process_tree.CREATE_SUSPENDED,
                                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        process_tree.assign_process(job, proc.pid)
        process_tree.resume_suspended_process(proc.pid)
        _wait_for_update_ready(proc, str(marker), token, str(current))
        result = {'ok': True, 'artifact': str(source), 'frozenGuiAndCore': True,
                  'elapsedSec': round(time.monotonic() - started, 3)}
    finally:
        try:
            retired = process_tree.terminate_job_and_wait(job, timeout=15)
        finally:
            process_tree.close_job(job)
        if proc is not None:
            proc.wait(timeout=15)
        if retired:
            # Windows can release the final file handles slightly after Job
            # accounting reaches zero (and antivirus can briefly scan them).
            for attempt in range(50):
                try:
                    shutil.rmtree(folder)
                    break
                except OSError as exc:
                    if getattr(exc, 'winerror', None) not in (5, 32, 33) or attempt == 49:
                        raise
                    time.sleep(0.1)
    if not retired:
        raise RuntimeError('GUI smoke process tree did not retire')
    result['processTreeRetired'] = True
    if len(sys.argv) > 2:
        Path(sys.argv[2]).write_text(json.dumps(result, indent=2), encoding='utf-8')
    print(json.dumps(result, indent=2))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
