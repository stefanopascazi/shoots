# shoots installer for Windows (PowerShell 5.1+).
#
#   irm https://raw.githubusercontent.com/stefanopascazi/shoots/main/install.ps1 | iex
#
# Downloads the latest release binary, verifies its SHA-256, installs it to
# %USERPROFILE%\.shoots\bin and adds that to your user PATH. Override with the
# SHOOTS_INSTALL_DIR or SHOOTS_REPO environment variables.
$ErrorActionPreference = 'Stop'

if ($env:SHOOTS_REPO) { $repo = $env:SHOOTS_REPO } else { $repo = 'stefanopascazi/shoots' }
if ($env:SHOOTS_INSTALL_DIR) { $installDir = $env:SHOOTS_INSTALL_DIR } else { $installDir = "$env:USERPROFILE\.shoots\bin" }

# Only x64 Windows binaries are published; they run under x64 emulation on ARM.
$asset = 'shoots-windows-x64.exe'
$base = "https://github.com/$repo/releases/latest/download"

Write-Host "Downloading shoots (windows-x64)..."
New-Item -ItemType Directory -Force -Path $installDir | Out-Null
$staged = Join-Path $env:TEMP ("shoots-" + $PID + ".exe")
try {
  Invoke-WebRequest -Uri "$base/$asset" -OutFile $staged -UseBasicParsing
} catch {
  throw "download failed - is there a published release with a windows-x64 binary?"
}

# Verify against the release checksums when present.
$sums = $null
try { $sums = (Invoke-WebRequest -Uri "$base/SHA256SUMS.txt" -UseBasicParsing).Content } catch { }
if ($sums) {
  $expected = $null
  foreach ($line in ($sums -split "`n")) {
    $parts = $line.Trim() -split '\s+'
    if ($parts.Count -ge 2) {
      $name = $parts[$parts.Count - 1].TrimStart('*')
      if ($name -eq $asset) { $expected = $parts[0].ToLower() }
    }
  }
  if ($expected) {
    $actual = (Get-FileHash -Algorithm SHA256 $staged).Hash.ToLower()
    if ($expected -ne $actual) {
      Remove-Item $staged -Force
      throw "checksum mismatch (expected $expected, got $actual)"
    }
  } else {
    Write-Warning "no checksum entry for $asset; skipping verification"
  }
} else {
  Write-Warning "SHA256SUMS.txt not found; skipping verification"
}

$dest = Join-Path $installDir 'shoots.exe'
Move-Item -Force $staged $dest
Write-Host "Installed to $dest"

# Ensure installDir is on the user PATH for future terminals.
$userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
if (-not $userPath) { $userPath = '' }
if (($userPath -split ';') -notcontains $installDir) {
  $trimmed = $userPath.TrimEnd(';')
  if ($trimmed) { $newPath = $trimmed + ';' + $installDir } else { $newPath = $installDir }
  [Environment]::SetEnvironmentVariable('Path', $newPath, 'User')
  $env:Path = $env:Path + ';' + $installDir
  Write-Host "Added $installDir to your user PATH."
}

Write-Host "OK. Open a new terminal, then run: shoots setup ; shoots --help"
