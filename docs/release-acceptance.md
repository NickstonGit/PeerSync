# Release acceptance

Automated CI covers build, packaging, frozen smoke/GUI readiness, direct and
relay transfer, kill/resume, discovery/reconnect and byte-for-byte
reproducibility. The scenarios below cannot be honestly produced by a build
script; they are measured by a person on target hardware and recorded here
before a release is cut.

Artifact names produced by `scripts/build-portable-win.ps1`:

- `dist/PSN.exe` — the portable launcher (plus a convenience copy in the
  repository root);
- `PSNCore.exe` — the standalone Core, unpacked on first run into
  `data/runtime/` next to the application.

## Scenarios

| ID | Scenario | How to check | Status |
| --- | --- | --- | --- |
| AC-01 | A clean Windows x64 machine without Python/Node/WebView2 runs the single EXE | Copy `PSN.exe` to a clean VM and start it | operator |
| AC-02 | No console window on a GUI launch | Double-click `PSN.exe` | operator |
| AC-03 | `data/` sits next to the EXE; Core lives only at `data/runtime/PSNCore.exe` | Inspect after the first launch | automated (`artifact-smoke.json`) |
| AC-04 | A second launch does not rewrite Core for the same hash | `artifact-smoke.json` → `secondRunCoreRewritten=false` | automated |
| AC-05 | No network-launched `bare.exe` from `%TEMP%` | Process Explorer during a transfer | operator |
| AC-06 | Firewall prompt on a clean VM: one, branded `PSNCore.exe`, stable path | Screenshot attached to the release notes | operator |
| AC-07 | Tray Open/Exit; closing the window only hides it | Manual GUI pass | operator |
| AC-08 | Unplug/replug the network mid-transfer, then resume | Pull the cable for 30 s | operator |
| AC-09 | Reboot during a partial transfer, then resume | Reboot mid-transfer | operator |
| AC-10 | Reboot *inside* an update transaction, before the new launcher confirms readiness | Start an update, reboot during the readiness window; after logon, explicitly launch the candidate or known-good recovery helper; it must confirm readiness or restore the previous launcher without creating OS startup entries (see `docs/update-recovery.md`) | operator |
| AC-11 | DPAPI device identity survives a restart | Frozen `--smoke` run and unit tests | automated |
| AC-12 | Startup p50/p95 on the target machine (SSD, Defender on, clean VM) | `python scripts/benchmark-startup.py dist/PSN.exe --runs 10 --out startup.json` | operator |
| AC-13 | 10k / 50k / 100k files: scan, preview, cancel latency, peak RAM, hash-cache size | Synthetic tree; timings and peak memory recorded below | operator |
| AC-14 | 1–4 h soak: window open, background transfers, no crash and no RAM growth | Manual run with log export | operator |
| AC-15 | Repeated start/stop cycles do not leak handles, threads or RAM | Process handle/thread counts over 20 cycles | operator |
| AC-16 | A candidate that cannot reach Core hello is rolled back without manual `.bak` restore | Install a deliberately broken build, power-cut or reboot inside the readiness window, log on and explicitly start the known-good recovery helper: it must restore and start the previous launcher | operator |

`scripts/benchmark-startup.py` measures the same readiness point the release
gate uses (`--update-ready`, i.e. a successful Core hello), so AC-12 numbers are
directly comparable with `gui-smoke.json`.

## Recording a result

Append a section per run with:

1. the date, the machine/VM image and the `PSN.exe` SHA-256;
2. a table row per ID with PASS/FAIL and the measured numbers;
3. for any FAIL, the log file from `data/logs/` that shows it.

A scenario without a recorded result is **NOT VERIFIED**. It is not a release
blocker for the first controlled rollout, but it must not be reported as PASS.

## Live diagnostics

An application started with `--debug` publishes a private, token-authenticated
named pipe (`data/runtime/diagnostics-endpoint.json`). Without the flag no live
diagnostic surface is published at all, and external tooling reads the bounded
offline logs in `data/logs/`. That makes it possible to watch a transfer or a
disconnect as it happens instead of reconstructing it from logs afterwards.