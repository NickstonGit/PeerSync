# Build FIRST TRY portable Windows artifact (plan 12).
# From workspace root:  build-portable.bat
#
# Produces:
#   dist/PSN.exe
#   dist/build-report.json
# Copy of dist/PSN.exe in the workspace root.
# PeerSync public version is DDMMYY (package.json releaseVersion). Internal 0.0.0/buildLabel fields exist only for npm/wire compatibility.

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $PSScriptRoot
Set-Location $Root
$Workspace = $Root
$LogPath = Join-Path $Workspace "build-portable.log"
try { Start-Transcript -Path $LogPath -Force | Out-Null } catch {}

function Write-BuildBanner([string]$Text, [ConsoleColor]$Color) {
  Write-Host ""
  Write-Host $Text -ForegroundColor $Color
}

function Get-Sha256([string]$Path) {
  $sha = [System.Security.Cryptography.SHA256]::Create()
  $fs = [System.IO.File]::OpenRead($Path)
  try {
    return ([BitConverter]::ToString($sha.ComputeHash($fs))).Replace("-", "").ToLowerInvariant()
  } finally {
    $fs.Dispose()
    $sha.Dispose()
  }
}

function Require-Cmd([string]$Name) {
  if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) {
    throw "Command not found in PATH: $Name"
  }
}

function Invoke-NativeChecked(
  [string]$FilePath,
  [string[]]$ArgumentList,
  [string]$FailMessage,
  [string]$CommandLog = ""
) {
  Write-Host ("> $FilePath " + ($ArgumentList -join ' '))
  if ($CommandLog -and (Test-Path $CommandLog)) { Remove-Item $CommandLog -Force }

  # Windows PowerShell 5.1 turns native stderr redirected with 2>&1 into
  # ErrorRecord objects. With the script-wide ErrorActionPreference=Stop even
  # harmless output such as `npm notice` can otherwise abort a successful
  # native command before its exit code is inspected. Native stderr is output,
  # not failure: the process exit code is the only success/failure boundary.
  $PreviousErrorActionPreference = $ErrorActionPreference
  $ExitCode = -1
  try {
    $ErrorActionPreference = "Continue"
    & $FilePath @ArgumentList 2>&1 | ForEach-Object {
      $Line = $_.ToString()
      Write-Host $Line
      if ($CommandLog) {
        Add-Content -LiteralPath $CommandLog -Value $Line -Encoding UTF8
      }
    }
    $ExitCode = $LASTEXITCODE
  } finally {
    $ErrorActionPreference = $PreviousErrorActionPreference
  }

  if ($ExitCode -ne 0) {
    if ($CommandLog) {
      Write-Host ("Command log: " + $CommandLog) -ForegroundColor Yellow
      if (Test-Path $CommandLog) {
        Write-Host "---- last command output ----" -ForegroundColor DarkYellow
        Get-Content -Path $CommandLog -Tail 80 | ForEach-Object { Write-Host $_ }
        Write-Host "-----------------------------" -ForegroundColor DarkYellow
      }
    }
    throw "$FailMessage (exit $ExitCode)"
  }
}

function Invoke-Checked([string]$FilePath, [string[]]$ArgumentList, [string]$FailMessage) {
  Invoke-NativeChecked $FilePath $ArgumentList $FailMessage
}

function Invoke-CheckedLogged([string]$FilePath, [string[]]$ArgumentList, [string]$FailMessage, [string]$CommandLog) {
  Invoke-NativeChecked $FilePath $ArgumentList $FailMessage $CommandLog
}

function Invoke-NativeCapture([string]$FilePath, [string[]]$ArgumentList) {
  $PreviousErrorActionPreference = $ErrorActionPreference
  try {
    $ErrorActionPreference = "Continue"
    $Lines = @(& $FilePath @ArgumentList 2>$null)
    $ExitCode = $LASTEXITCODE
  } finally {
    $ErrorActionPreference = $PreviousErrorActionPreference
  }
  [PSCustomObject]@{
    ExitCode = $ExitCode
    Text = (($Lines | ForEach-Object { $_.ToString() }) -join [Environment]::NewLine).Trim()
  }
}

# Read the commit and the working-tree state from git. $Dirty defaults to
# $true: when git cannot be queried at all, the build is not releasable.
function Get-GitReleaseMetadata([string]$RepoPath) {
  # A source export under build/ inherits the parent repository when Git is
  # invoked there. It has no checkout metadata of its own and cannot be clean.
  if (-not (Test-Path -LiteralPath (Join-Path $RepoPath ".git"))) {
    return [PSCustomObject]@{ Commit = "unknown"; Dirty = $true }
  }
  $Commit = "unknown"
  $IsDirty = $true
  if (Get-Command git -ErrorAction SilentlyContinue) {
    try {
      $Head = (& git -C $RepoPath rev-parse HEAD 2>$null)
      if ($Head) { $Commit = $Head.Trim() } else { $Commit = "unknown" }
      $Status = & git -C $RepoPath status --porcelain 2>$null
      $IsDirty = [bool]$Status
    } catch {
      $Commit = "unknown"
    }
  }
  return [PSCustomObject]@{ Commit = $Commit; Dirty = $IsDirty }
}

function Get-WorkingTreeDirty([string]$RepoPath = $Root) {
  return (Get-GitReleaseMetadata -RepoPath $RepoPath).Dirty
}

try {
  $env:Path = @(
    $env:PEERSYNC_BUILD_NODE_DIR
    "C:\Program Files\nodejs"
    "C:\Program Files\Git\cmd"
    "C:\Program Files\Python314"
    "C:\Program Files\Python313"
    "C:\Program Files\Python312"
    $env:Path
  ) -join ";"

  Write-Host "== tools =="
  $PythonCommand = if ($env:PEERSYNC_BUILD_PYTHON) { $env:PEERSYNC_BUILD_PYTHON } else { "python.exe" }
  Require-Cmd $PythonCommand
  Require-Cmd node
  Require-Cmd npm
  Write-Host ("python: " + (Get-Command $PythonCommand).Source)
  Invoke-Checked $PythonCommand @("scripts/check-build-environment.py") "Python release compiler environment mismatch"
  Write-Host ("node:   " + (Get-Command node).Source)
  $NodeVerResult = Invoke-NativeCapture "node.exe" @("-v")
  if ($NodeVerResult.ExitCode -ne 0) { throw "node -v failed (exit $($NodeVerResult.ExitCode))" }
  $NpmVerResult = Invoke-NativeCapture "npm.cmd" @("-v")
  if ($NpmVerResult.ExitCode -ne 0) { throw "npm -v failed (exit $($NpmVerResult.ExitCode))" }
  $NodeVerEarly = $NodeVerResult.Text
  $NpmVerEarly = $NpmVerResult.Text
  Write-Host ("node version: " + $NodeVerEarly)
  Write-Host ("npm version:  " + $NpmVerEarly)
  $ExpectedNodeVersion = 'v' + (Get-Content -LiteralPath (Join-Path $Root '.node-version') -Raw).Trim()
  if ($NodeVerEarly -ne $ExpectedNodeVersion) {
    throw "Release build requires Node $ExpectedNodeVersion from .node-version; found $NodeVerEarly."
  }
  $env:PYTHONHASHSEED = '0'

  # PeerSync intentionally builds unsigned P2P update sources. Do not read
  # signing seeds and do not emit PSN.exe.update.json. Transfer admission is
  # restricted to remembered devices marked as mine; executable integrity is
  # verified by exact size + SHA-256 before install and again in the updater.
  Remove-Item Env:PEERSYNC_UPDATE_SIGNING_SEED -ErrorAction SilentlyContinue

  $PyInstallerVersionResult = Invoke-NativeCapture $PythonCommand @("-c", "import PyInstaller; print(PyInstaller.__version__)")
  $PyInstallerVersion = $PyInstallerVersionResult.Text
  if ($PyInstallerVersionResult.ExitCode -ne 0 -or -not $PyInstallerVersion) {
    throw "PyInstaller 6.22.x is required. Run: python -m pip install -r apps\portable-python\requirements-build.txt"
  }
  $PyInstallerVersion = $PyInstallerVersion.Trim()
  if ($PyInstallerVersion -notmatch '^6\.22\.') {
    throw "Unsupported PyInstaller $PyInstallerVersion. Expected 6.22.x. Run: python -m pip install -r apps\portable-python\requirements-build.txt"
  }
  Write-Host ("PyInstaller: " + $PyInstallerVersion)

$pkg = Get-Content -Raw -Encoding UTF8 "package.json" | ConvertFrom-Json
  $ReleaseVersion = [string]$pkg.releaseVersion
  if ($ReleaseVersion -notmatch '^\d{6}$') { throw "package.json releaseVersion must be DDMMYY" }
  # Monotonic within-day revision: the machine-orderable identity behind the
  # date-only UI label. scripts/bump-portable-version.mjs validates the format
  # and the release workflow enforces monotonicity against real tags.
  $ReleaseRevision = [int]$pkg.releaseRevision
  if ($ReleaseRevision -lt 1 -or $ReleaseRevision -gt 99999999) {
    throw "package.json releaseRevision must be an integer 1..99999999"
  }
  if (-not $env:SOURCE_DATE_EPOCH) {
    $ReleaseDate = [DateTime]::ParseExact($ReleaseVersion, 'ddMMyy', [Globalization.CultureInfo]::InvariantCulture)
    $env:SOURCE_DATE_EPOCH = ([DateTimeOffset][DateTime]::SpecifyKind($ReleaseDate, [DateTimeKind]::Utc)).ToUnixTimeSeconds().ToString()
  }
  $AppVersion = "0.0.0"       # wire/npm compatibility only; never shown as the PeerSync version
  $BuildLabel = $ReleaseVersion # retained on the wire for compatibility with existing update messages

  $DistDir = Join-Path $Root "dist"
  $BuildCore = Join-Path $Root "build\core"
  $BuildPyi = Join-Path $Root "build\pyi"
  if (Test-Path $BuildCore) { Remove-Item $BuildCore -Recurse -Force }
  if (Test-Path $BuildPyi) { Remove-Item $BuildPyi -Recurse -Force }
  New-Item -ItemType Directory -Force -Path $DistDir, $BuildCore | Out-Null
  foreach ($StaleOutput in @(
    (Join-Path $DistDir "PSN.exe"),
    (Join-Path $DistDir "PSN.exe.update.json"),
    (Join-Path $DistDir "build-report.json"),
    (Join-Path $DistDir "release-manifest.json"),
    (Join-Path $DistDir "artifact-smoke.json"),
    (Join-Path $DistDir "gui-smoke.json"),
    (Join-Path $DistDir "reproducibility.json"),
    (Join-Path $DistDir "forbidden-payload-scan.json")
  )) {
    if (Test-Path $StaleOutput) { Remove-Item $StaleOutput -Force }
  }

  # Artifact acronym is PSN. Remove stale convenience copies from older
  # ASN/AS builds so a successful build cannot leave differently named EXEs.
  foreach ($LegacyExe in @((Join-Path $DistDir "ASN.exe"), (Join-Path $Workspace "ASN.exe"), (Join-Path $DistDir "AS.exe"), (Join-Path $Workspace "AS.exe"))) {
    if (Test-Path $LegacyExe) { Remove-Item $LegacyExe -Force }
  }


  Write-Host "== git metadata =="
  $GitMetadata = Get-GitReleaseMetadata -RepoPath $Root
  $BaseCommit = $GitMetadata.Commit
  $Dirty = $GitMetadata.Dirty
  Write-Host "commit $BaseCommit dirty=$Dirty"

  Write-Host "== npm portable graph =="
  # Packaging does not need Git hooks, and audit/source archives may not contain .git.
  $env:HUSKY = "0"
  if ($env:PEERSYNC_SKIP_NPM_CI -eq "1") {
    Write-Host "PEERSYNC_SKIP_NPM_CI=1: reusing node_modules (developer override)." -ForegroundColor Yellow
  } else {
    # Keep a separate native-command log. PowerShell transcripts can otherwise
    # end at the `npm ci` command line and hide the useful npm error/progress.
    $NpmCiLog = Join-Path $Workspace "build-npm-ci.log"
    $NpmRegistryResult = Invoke-NativeCapture "npm.cmd" @("config", "get", "registry")
    $NpmRegistry = if ($NpmRegistryResult.ExitCode -eq 0) { ($NpmRegistryResult.Text -split '\r?\n' | Select-Object -First 1) } else { "unknown" }
    Write-Host ("npm registry: " + $NpmRegistry)
    Write-Host ("npm ci log: " + $NpmCiLog)
    Invoke-CheckedLogged "npm.cmd" @(
      "ci",
      "--no-audit",
      "--no-fund",
      "--prefer-offline",
      "--progress=false",
      "--loglevel=notice",
      "--fetch-retries=2",
      "--fetch-retry-maxtimeout=30000",
      "--fetch-timeout=120000"
    ) "npm ci failed" $NpmCiLog
  }
  Write-Host "== all dependency audit (Critical/High) =="
  Invoke-Checked "npm.cmd" @("audit", "--audit-level=high") "npm dependency audit failed"

  $BareBuild = Join-Path $Root "node_modules\.bin\bare-build.cmd"
  if (-not (Test-Path $BareBuild)) {
    throw "Local bare-build is missing after dependency setup. Run npm ci (or unset PEERSYNC_SKIP_NPM_CI)."
  }
  $BarePackage = Join-Path $Root "node_modules\bare-build\package.json"
  if (-not (Test-Path $BarePackage)) { throw "node_modules\bare-build\package.json is missing" }
  $BareVer = (Get-Content -Raw -Encoding UTF8 $BarePackage | ConvertFrom-Json).version
  $ExpectedBareVer = [string]$pkg.devDependencies.'bare-build'
  if ($BareVer -ne $ExpectedBareVer) {
    throw "bare-build version mismatch: installed=$BareVer expected=$ExpectedBareVer. Run npm ci."
  }
  Invoke-Checked "npm.cmd" @("run", "build:portable-core-deps") "npm build:portable-core-deps failed"

  $UpdateSigningPublicKey = ""
  Write-Host "unsigned P2P update mode enabled (remembered-mine + size + SHA-256)." -ForegroundColor Yellow

  $Entry = Join-Path $Root "packages\core\dist\portable\entry.js"
  if (-not (Test-Path $Entry)) {
    throw "missing portable entry.js (tsup did not emit packages/core/dist/portable/entry.js)"
  }

  Write-Host "== bare-build standalone PSNCore =="
$Icon = Join-Path $Root "apps\portable-python\assets\peersync.ico"
  $BareArgs = @(
    "--host", "win32-x64",
    "--standalone",
    "--name", "PSNCore",
    "--author", "PeerSync by Nickston",
    "--description", "PeerSync Core",
    "--out", $BuildCore,
    $Entry
  )
  if (Test-Path $Icon) {
    $BareArgs = @(
      "--host", "win32-x64", "--standalone",
      "--name", "PSNCore", "--author", "PeerSync by Nickston",
      "--description", "PeerSync Core", "--icon", $Icon,
      "--out", $BuildCore, $Entry
    )
  }
  Invoke-Checked $BareBuild $BareArgs "bare-build failed"

  $Built = Get-ChildItem $BuildCore -Filter "*.exe" | Sort-Object LastWriteTime -Descending | Select-Object -First 1
  if (-not $Built) { throw "bare-build produced no exe in $BuildCore" }
  $CoreDest = Join-Path $BuildCore "PSNCore.exe"
  if ($Built.FullName -ne $CoreDest) {
    Copy-Item $Built.FullName $CoreDest -Force
  }

  Write-Host "== embed core payload =="
  Invoke-Checked $PythonCommand @("scripts/gen-core-payload.py", $CoreDest) "gen-core-payload failed"
  $CoreHash = Get-Sha256 $CoreDest
  $CoreBytes = (Get-Item $CoreDest).Length

  Set-Content -Encoding ASCII -Path "apps\portable-python\build_info.py" -Value @"
APP_VERSION = '$AppVersion'
BUILD_LABEL = '$BuildLabel'
RELEASE_VERSION = '$ReleaseVersion'
RELEASE_REVISION = $ReleaseRevision
UPDATE_SIGNING_PUBLIC_KEY = '$UpdateSigningPublicKey'
ALLOW_UNSIGNED_UPDATE = True
"@

  $TraySource = Join-Path $Root "apps\portable-python\windows\tray.py"
  $TraySourceHash = Get-Sha256 $TraySource
  Write-Host "tray source sha256 $TraySourceHash"

  Write-Host "== TypeScript typecheck =="
  Invoke-Checked "npm.cmd" @("run", "typecheck") "TypeScript typecheck failed"

  Write-Host "== python tests =="
  Invoke-Checked $PythonCommand @("-m", "unittest", "discover", "-s", "apps/portable-python/tests", "-q") "python tests failed"

  Write-Host "== drive unit tests =="
  Invoke-Checked "npm.cmd" @("test", "-w", "packages/drive") "vitest drive failed"

  Write-Host "== portable core unit tests =="
  Invoke-Checked "npm.cmd" @("test", "-w", "packages/core") "vitest core failed"
  Invoke-Checked "npm.cmd" @("run", "lint:portable") "TypeScript lint failed"

  Write-Host "== M0 IPC smoke (10000 frames, dataRoot) =="
  Invoke-Checked $PythonCommand @("scripts/spike-headless-smoke.py", $CoreDest) "headless 10k smoke failed"

  Write-Host "== PyInstaller onefile =="
  $Spec = Join-Path $Root "apps\portable-python\PSN.spec"
  Invoke-Checked $PythonCommand @("-m", "PyInstaller", "--noconfirm", "--clean", "--distpath", $DistDir, "--workpath", $BuildPyi, $Spec) "PyInstaller failed"

  $ArtifactName = "PSN.exe"
  $Artifact = Join-Path $DistDir $ArtifactName
  if (-not (Test-Path $Artifact)) { throw "PyInstaller did not emit PSN.exe" }

  $FinalHash = Get-Sha256 $Artifact
  $FinalBytes = (Get-Item $Artifact).Length
  $UpdateManifest = "$Artifact.update.json"
  if (Test-Path $UpdateManifest) { Remove-Item $UpdateManifest -Force }


  Write-Host "== forbidden payload scan =="
  $ForbiddenJson = Join-Path $DistDir "forbidden-payload-scan.json"
  Invoke-Checked $PythonCommand @("scripts/forbidden-payload-scan.py", $CoreDest, $Artifact, $ForbiddenJson) "forbidden payload scan failed"
  $Forbidden = Get-Content -Raw -Encoding UTF8 $ForbiddenJson | ConvertFrom-Json

  Write-Host "== artifact smoke (first+second run) =="
  $SmokeJson = Join-Path $DistDir "artifact-smoke.json"
  Invoke-Checked $PythonCommand @("scripts/artifact-smoke.py", $Artifact, $SmokeJson) "frozen --smoke failed"
  $Smoke = Get-Content -Raw -Encoding UTF8 $SmokeJson | ConvertFrom-Json
  Write-Host "== frozen GUI/Core readiness =="
  $GuiSmokeJson = Join-Path $DistDir "gui-smoke.json"
  Invoke-Checked $PythonCommand @("scripts/artifact-gui-smoke.py", $Artifact, $GuiSmokeJson) "frozen GUI startup failed"
  $GuiSmoke = Get-Content -Raw -Encoding UTF8 $GuiSmokeJson | ConvertFrom-Json

  $PyVerResult = Invoke-NativeCapture $PythonCommand @("-c", "import sys; print(sys.version.split()[0])")
  if ($PyVerResult.ExitCode -ne 0) { throw "python version probe failed" }
  $PyVer = $PyVerResult.Text
  $PyI = $PyInstallerVersion
  $NodeVer = $NodeVerEarly
  $NpmVer = $NpmVerEarly

  $SizeBudgetPath = Join-Path $DistDir "size-budget.json"
  $SizeBudgetNote = $null
  if (Test-Path $SizeBudgetPath) {
    $prev = Get-Content -Raw -Encoding UTF8 $SizeBudgetPath | ConvertFrom-Json
    if ($prev.finalExeBytes -gt 0) {
      $growth = [math]::Round((($FinalBytes - $prev.finalExeBytes) / $prev.finalExeBytes) * 100, 2)
      if ($growth -gt 5) {
        $SizeBudgetNote = "size grew $growth% vs budget $($prev.finalExeBytes) - needs reason"
        Write-Host "WARNING: $SizeBudgetNote"
      }
    }
  } else {
    @{ finalExeBytes = $FinalBytes; version = $ReleaseVersion } | ConvertTo-Json | Set-Content -Encoding UTF8 $SizeBudgetPath
  }

  $Report = [ordered]@{
    version = $ReleaseVersion
    releaseRevision = $ReleaseRevision
    protocolAppVersion = $AppVersion
    buildLabel = $BuildLabel
    baseCommit = $BaseCommit
    dirtyWorkingTree = $Dirty
    pythonVersion = $PyVer
    pyinstallerVersion = $PyI
    nodeVersion = $NodeVer
    npmVersion = $NpmVer
    bareBuildVersion = $BareVer
    sourceDateEpoch = $env:SOURCE_DATE_EPOCH
    pythonPackageLockSha256 = Get-Sha256 (Join-Path $Root 'apps\portable-python\requirements-build.txt')
    coreSha256 = $CoreHash
    coreBytes = $CoreBytes
    extractedStableCoreBytes = $Smoke.firstRun.coreBytes
    finalExeSha256 = $FinalHash
    finalExeBytes = $FinalBytes
    artifact = $ArtifactName
    updateSigningPublicKey = ""
    updateManifest = $null
    traySourceSha256 = $TraySourceHash
    coldStartSampleSec = $Smoke.firstRun.readySec
    idleWorkingSetSampleBytes = $Smoke.firstRun.idleWorkingSetBytes
    firstRunExtractionSec = $Smoke.firstRun.launcherStartSec
    firstRunCoreInstallSec = $Smoke.firstRun.coreInstallSec
    secondRunStartSec = $Smoke.secondRun.readySec
    peakProcessTreeWorkingSetBytes = $Smoke.firstRun.peakProcessTreeWorkingSetBytes
    firstRunCoreRewritten = $Smoke.firstRun.coreInstallChanged
    secondRunCoreRewritten = $Smoke.secondRun.coreInstallChanged
    forbiddenPayloadScan = $Forbidden
    artifactSmoke = @{
      ok = $Smoke.ok
      corePathStable = $Smoke.corePathStable
    }
    guiSmoke = $GuiSmoke
    sizeBudgetNote = $SizeBudgetNote
  }
  $ReportPath = Join-Path $DistDir "build-report.json"
  $Report | ConvertTo-Json -Depth 6 | Set-Content -Encoding UTF8 $ReportPath

  # Release manifest: the immutable description of the exact tested bytes.
  # CI uploads it together with PSN.exe, and the release job re-verifies both
  # instead of rebuilding anything.
  # The working tree is re-read here, after dependency installation and the build
  # itself: a lifecycle script or a dependency step that edits tracked source
  # would otherwise be published under the stale "clean" flag read before npm ci.
  $Dirty = Get-WorkingTreeDirty
  Write-Host "commit $BaseCommit dirty=$Dirty (re-read before the manifest)"
  $ManifestPath = Join-Path $DistDir "release-manifest.json"
  Invoke-Checked $PythonCommand @(
    "scripts/write-release-manifest.py",
    "--psn", $Artifact,
    "--core", $CoreDest,
    "--out", $ManifestPath,
    "--release-version", $ReleaseVersion,
    "--release-revision", "$ReleaseRevision",
    "--repo", $Root,
    "--commit", $BaseCommit,
    "--dirty", $(if ($Dirty) { "1" } else { "0" })
  ) "release manifest generation failed"
  $ReleaseManifest = Get-Content -Raw -Encoding UTF8 $ManifestPath | ConvertFrom-Json
  Write-Host ("release manifest " + $ReleaseManifest.releaseVersion + " r" + $ReleaseManifest.releaseRevision + " " + $ReleaseManifest.psnSha256)

  $RootCopy = Join-Path $Workspace "PSN.exe"
  Copy-Item $Artifact $RootCopy -Force
  $StaleRootManifest = $RootCopy + ".update.json"
  if (Test-Path $StaleRootManifest) { Remove-Item $StaleRootManifest -Force }
  Copy-Item $ReportPath (Join-Path $Workspace "build-report.json") -Force

  Write-Host "artifact $Artifact"
  Write-Host "root copy $RootCopy"
  Write-Host "bytes $FinalBytes"
  Write-Host "report $ReportPath"
  Write-BuildBanner "DONE  PSN.exe is in this folder and in dist\" Green
}
catch {
  Write-BuildBanner "BUILD FAILED" Red
  Write-Host $_.Exception.Message -ForegroundColor Red
  if ($_.ScriptStackTrace) { Write-Host $_.ScriptStackTrace -ForegroundColor DarkYellow }
  Write-Host "Log: $LogPath"
  try { Stop-Transcript | Out-Null } catch {}
  exit 1
}

try { Stop-Transcript | Out-Null } catch {}
exit 0
