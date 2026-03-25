#requires -Version 5.1
param(
  [Parameter(Mandatory = $true)]
  [string]$RepoRoot
)

$ErrorActionPreference = 'Stop'
$RepoRoot = $RepoRoot.TrimEnd('\', '/')

$trayScript = Join-Path $RepoRoot 'scripts\uplayer-web-tray.ps1'
if (-not (Test-Path -LiteralPath $trayScript)) {
  Write-Error "Missing tray script: $trayScript"
}

$icon = Join-Path $RepoRoot 'assets\uplayer.ico'
$psExe = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
if (-not (Test-Path -LiteralPath $psExe)) {
  Write-Error "Windows PowerShell 5.1 not found at $psExe"
}

$argsLine = "-NoProfile -ExecutionPolicy Bypass -STA -File `"$trayScript`" -RepoRoot `"$RepoRoot`""

$wsh = New-Object -ComObject WScript.Shell

function New-UplayerShortcut {
  param(
    [string]$Directory,
    [string]$Name
  )
  if (-not (Test-Path -LiteralPath $Directory)) {
    New-Item -ItemType Directory -Force -Path $Directory | Out-Null
  }
  $path = Join-Path $Directory "$Name.lnk"
  $sc = $wsh.CreateShortcut($path)
  $sc.TargetPath = $psExe
  $sc.Arguments = $argsLine
  $sc.WorkingDirectory = $RepoRoot
  if (Test-Path -LiteralPath $icon) {
    $sc.IconLocation = "$icon,0"
  }
  $sc.Description = 'Uplayer Web — streaming UI (tray)'
  $sc.Save()
}

$desktop = [Environment]::GetFolderPath('Desktop')
$programs = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs'

New-UplayerShortcut -Directory $desktop -Name 'Uplayer Web'
New-UplayerShortcut -Directory $programs -Name 'Uplayer Web'

Write-Host "Shortcuts created:"
Write-Host "  Desktop: $(Join-Path $desktop 'Uplayer Web.lnk')"
Write-Host "  Start Menu: $(Join-Path $programs 'Uplayer Web.lnk')"
