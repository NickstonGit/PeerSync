$ErrorActionPreference = "Stop"

$Root = Split-Path -Parent $PSScriptRoot
Set-Location $Root

$Output = Join-Path $Root "PeerSync-external-audit.zip"
$Stage = Join-Path ([System.IO.Path]::GetTempPath()) ("peersync-audit-" + [Guid]::NewGuid().ToString("N"))

$ExcludedTopLevel = @(
  ".git",
  "node_modules",
  "build",
  "dist",
  "data",
  ".tmp"
)

$ExcludedExact = @(
  "as.7z",
  "BASE-COMMIT.txt",
  "build-npm-ci.log",
  "build-portable.log",
  "build-report.json",
  "PSN.exe",
  "PSN.exe.update.json",
  "PeerSync-external-audit.zip",
  "docs/reference-check.md",
  "docs/operator-acceptance.md"
)

function Normalize-RelativePath([string]$Path) {
  $normalized = $Path -replace '\\', '/'
  while ($normalized.StartsWith("./", [System.StringComparison]::Ordinal)) {
    $normalized = $normalized.Substring(2)
  }
  return $normalized.TrimStart([char[]]"/")
}

function Test-Excluded([string]$RelativePath) {
  $rel = Normalize-RelativePath $RelativePath

  if ($ExcludedExact -contains $rel) { return $true }

  foreach ($top in $ExcludedTopLevel) {
    if ($rel -eq $top -or $rel.StartsWith($top + "/", [System.StringComparison]::OrdinalIgnoreCase)) {
      return $true
    }
  }

  if ($rel -match '(^|/)__pycache__(/|$)') { return $true }
  if ($rel -match '\.py[co]$') { return $true }
  if ($rel -match '\.log$') { return $true }
  # Nested archives are never product source. A committed stale source archive
  # inside the audit package makes the source of truth ambiguous and can expose
  # an outdated snapshot, so every archive container is denied here.
  if ($rel -match '\.(zip|7z|rar|tar|tar\.gz|tgz|gz|bz2|xz)$') { return $true }

  return $false
}

function Get-AuditFiles {
  $git = Get-Command git -ErrorAction SilentlyContinue
  if ($git) {
    $inside = & git -C $Root rev-parse --is-inside-work-tree 2>$null
    if ($LASTEXITCODE -eq 0 -and (($inside | Select-Object -First 1).ToString().Trim() -eq "true")) {
      $listed = @(& git -C $Root -c core.quotepath=false ls-files --cached --others --exclude-standard)
      if ($LASTEXITCODE -eq 0) {
        return @($listed | ForEach-Object { $_.ToString() } | Where-Object { $_ })
      }
    }
  }

  # Fallback for a source tree without .git: enumerate the current directory
  # and apply the same generated/local exclusions explicitly.
  return @(
    Get-ChildItem -LiteralPath $Root -File -Recurse -Force |
      ForEach-Object {
        $_.FullName.Substring($Root.Length).TrimStart([char[]]"\/")
      }
  )
}

if (Test-Path $Output) {
  Remove-Item -LiteralPath $Output -Force
}
New-Item -ItemType Directory -Path $Stage -Force | Out-Null

try {
  $files = @(Get-AuditFiles | Sort-Object -Unique)
  $copied = 0

  foreach ($raw in $files) {
    $rel = Normalize-RelativePath $raw
    if (-not $rel -or (Test-Excluded $rel)) { continue }

    $source = Join-Path $Root ($rel -replace '/', '\')
    if (-not (Test-Path -LiteralPath $source -PathType Leaf)) { continue }

    $destination = Join-Path $Stage ($rel -replace '/', '\')
    $destinationDir = Split-Path -Parent $destination
    if ($destinationDir) {
      New-Item -ItemType Directory -Path $destinationDir -Force | Out-Null
    }
    Copy-Item -LiteralPath $source -Destination $destination -Force
    $copied++
  }

  if ($copied -eq 0) {
    throw "No source files were selected for the audit archive."
  }

  Add-Type -AssemblyName System.IO.Compression.FileSystem
  [System.IO.Compression.ZipFile]::CreateFromDirectory(
    $Stage,
    $Output,
    [System.IO.Compression.CompressionLevel]::Optimal,
    $false
  )

  $size = (Get-Item -LiteralPath $Output).Length
  Write-Host ("Created: " + $Output)
  Write-Host ("Files:   " + $copied)
  Write-Host ("Bytes:   " + $size)
}
finally {
  if (Test-Path $Stage) {
    Remove-Item -LiteralPath $Stage -Recurse -Force -ErrorAction SilentlyContinue
  }
}
