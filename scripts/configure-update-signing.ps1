$ErrorActionPreference = "Stop"

if (-not $env:LOCALAPPDATA) {
  throw "LOCALAPPDATA is unavailable"
}

$dir = Join-Path $env:LOCALAPPDATA "PeerSync"
$path = Join-Path $dir "update-signing-seed.txt"
New-Item -ItemType Directory -Force -Path $dir | Out-Null

if (Test-Path $path) {
  $existing = (Get-Content -Raw -Encoding ASCII $path).Trim()
  if ($existing -match '^[0-9a-fA-F]{64}$') {
    Write-Host "PeerSync update signing seed is already configured: $path" -ForegroundColor Green
    Write-Host "The existing key was kept unchanged."
    exit 0
  }
  throw "Existing signing seed file is invalid: $path"
}

$bytes = New-Object byte[] 32
$rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
try {
  $rng.GetBytes($bytes)
} finally {
  $rng.Dispose()
}
$seed = ([BitConverter]::ToString($bytes)).Replace("-", "").ToLowerInvariant()
[System.IO.File]::WriteAllText($path, $seed + [Environment]::NewLine, [System.Text.Encoding]::ASCII)

# Restrict the secret file to the current Windows user. Failure to tighten ACL
# is fatal: a release signing seed must not be left world-readable.
& icacls.exe $path /inheritance:r /grant:r ("${env:USERNAME}:(F)") | Out-Null
if ($LASTEXITCODE -ne 0) {
  Remove-Item $path -Force -ErrorAction SilentlyContinue
  throw "Failed to restrict ACL on signing seed file"
}

Write-Host "PeerSync update signing seed created:" -ForegroundColor Green
Write-Host "  $path"
Write-Host "Keep this file backed up securely. All future production releases must use the same seed." -ForegroundColor Yellow
Write-Host "The current portable build does not consume this seed automatically. See docs\update-signing.md before enabling signing."
