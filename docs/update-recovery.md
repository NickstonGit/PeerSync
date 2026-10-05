# Portable launcher update recovery

PeerSync is distributed as one `PSN.exe`. Its runtime, settings and update
recovery files stay in `data/` beside that executable. Updating creates no
registry entries, services, scheduled tasks or Windows startup registration.

## Transaction and current-session recovery

Before replacing `PSN.exe`, the updater writes and flushes
`data/runtime/update-pending.json`, including the current/candidate SHA-256 and
the known-good `PSN.exe.bak`. It starts the known-good helper copy
`data/runtime/PSNUpdater.exe` as a detached recovery watchdog. The watchdog must
read the exact transaction and write a durable token acknowledgement before
replacement is allowed. A failed or unacknowledged watchdog aborts the update
while the previous executable is still in place.

The new launcher confirms the transaction only after Core hello succeeds.
Failed replacement or startup restores the backup. If the updater is killed,
the watchdog checks candidate process identity, waits for the generation to
retire, verifies the backup hash, restores it and restarts the old launcher.
A live candidate is never replaced from underneath its running process.

## Reboot or power loss

The transaction, backup and known-good helper survive on disk; the watchdog
process does not survive reboot. PeerSync does not start automatically at logon.
Recovery resumes only after an explicit launch:

- If the installed candidate starts, it reads the pending transaction and
  starts a new session watchdog. Successful Core readiness confirms and clears
  the transaction even without the updater's original command-line token.
- If the candidate cannot start at all, launch the known-good recovery helper
  from the portable folder:

  ```powershell
  .\data\runtime\PSNUpdater.exe --recover-pending .\data\runtime\update-pending.json
  ```

  The helper verifies and restores the backup, then starts `PSN.exe`.
- If the portable folder was moved during the interrupted update, the recorded
  absolute paths may no longer match. Use the manual procedure below.

No code runs while the application is closed after reboot. Automatic recovery
before the user's next launch is deliberately outside the portable contract.

## Manual recovery

1. Close all PeerSync processes, including `PSNCore.exe`.
2. Copy `PSN.exe.bak` over `PSN.exe`, preserving the backup.
3. If present, restore `PSN.exe.update.json.bak` to `PSN.exe.update.json`;
   otherwise remove a stale signature sidecar.
4. Start `PSN.exe`. A matching previous-image hash retires the pending record.
5. Inspect `data/logs/update.log` for the transaction outcome.

Keep the backup and `data/runtime/PSNUpdater.exe` until the update is confirmed.
