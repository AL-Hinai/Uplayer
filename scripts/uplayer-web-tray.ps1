#requires -Version 5.1
<#
  Starts Uplayer Web (hidden Node or Bun process), opens the UI, and hosts a system-tray icon until Quit.
  Must run under Windows PowerShell with -STA (see shortcut / create-windows-shortcuts.ps1).
#>
param(
  [string]$RepoRoot = ''
)

$ErrorActionPreference = 'Stop'

# Explorer shortcuts often start with a minimal PATH; merge user + machine PATH like a new logon session.
$userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
$machinePath = [Environment]::GetEnvironmentVariable('Path', 'Machine')
if ($userPath -or $machinePath) {
  $env:Path = @($machinePath, $userPath, $env:Path) -join ';'
}

if ([string]::IsNullOrWhiteSpace($RepoRoot)) {
  $RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
} else {
  $RepoRoot = $RepoRoot.TrimEnd('\', '/')
}

$port = 3000
if ($env:PORT -match '^\d+$') {
  $p = [int]$env:PORT
  if ($p -gt 0 -and $p -le 65535) { $port = $p }
}

function Test-UplayerServer {
  param([int]$Port)
  try {
    $uri = "http://127.0.0.1:$Port/api/stream/status"
    $r = Invoke-WebRequest -Uri $uri -TimeoutSec 2 -UseBasicParsing -ErrorAction Stop
    return ($r.StatusCode -eq 200)
  } catch {
    return $false
  }
}

function Open-UplayerWeb {
  param([int]$Port)
  Start-Process "http://localhost:$Port/"
}

function Resolve-Runtime {
  param([string]$UplayerPath)
  $node = Get-Command node -ErrorAction SilentlyContinue
  if ($node) {
    return @{ Exe = $node.Source; Args = "`"$UplayerPath`" web" }
  }
  $bun = Get-Command bun -ErrorAction SilentlyContinue
  if ($bun) {
    return @{ Exe = $bun.Source; Args = "run `"$UplayerPath`" web" }
  }
  return $null
}

# --- Already running: open browser and exit (no second tray) ---
if (Test-UplayerServer -Port $port) {
  Open-UplayerWeb -Port $port
  exit 0
}

$uplayerJs = Join-Path $RepoRoot 'uplayer.js'
if (-not (Test-Path -LiteralPath $uplayerJs)) {
  Add-Type -AssemblyName System.Windows.Forms
  [System.Windows.Forms.MessageBox]::Show(
    "uplayer.js not found at:`n$uplayerJs",
    'Uplayer Web',
    [System.Windows.Forms.MessageBoxButtons]::OK,
    [System.Windows.Forms.MessageBoxIcon]::Error
  ) | Out-Null
  exit 1
}

$runtime = Resolve-Runtime -UplayerPath $uplayerJs
if (-not $runtime) {
  Add-Type -AssemblyName System.Windows.Forms
  [System.Windows.Forms.MessageBox]::Show(
    'Neither Node.js nor Bun was found in PATH. Install Node.js (or Bun) or rerun setup from Git Bash.',
    'Uplayer Web',
    [System.Windows.Forms.MessageBoxButtons]::OK,
    [System.Windows.Forms.MessageBoxIcon]::Error
  ) | Out-Null
  exit 1
}

$psi = New-Object System.Diagnostics.ProcessStartInfo
$psi.FileName = $runtime.Exe
$psi.Arguments = $runtime.Args
$psi.WorkingDirectory = $RepoRoot
$psi.UseShellExecute = $false
$psi.CreateNoWindow = $true

$serverProcess = [System.Diagnostics.Process]::Start($psi)
if (-not $serverProcess) {
  exit 1
}

$deadline = (Get-Date).AddSeconds(45)
while ((Get-Date) -lt $deadline) {
  if ($serverProcess.HasExited) {
    Add-Type -AssemblyName System.Windows.Forms
    [System.Windows.Forms.MessageBox]::Show(
      'Uplayer Web exited unexpectedly. Check Node and project dependencies.',
      'Uplayer Web',
      [System.Windows.Forms.MessageBoxButtons]::OK,
      [System.Windows.Forms.MessageBoxIcon]::Error
    ) | Out-Null
    exit 1
  }
  if (Test-UplayerServer -Port $port) { break }
  Start-Sleep -Milliseconds 400
}

if (-not (Test-UplayerServer -Port $port)) {
  try {
    if (-not $serverProcess.HasExited) { $serverProcess.Kill() }
  } catch { }
  Add-Type -AssemblyName System.Windows.Forms
  [System.Windows.Forms.MessageBox]::Show(
    'Timed out waiting for the web server. Check port ' + $port + ' and firewall settings.',
    'Uplayer Web',
    [System.Windows.Forms.MessageBoxButtons]::OK,
    [System.Windows.Forms.MessageBoxIcon]::Warning
  ) | Out-Null
  exit 1
}

# uplayer web already opens the browser; avoid double-open here.

Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Windows.Forms
[System.Windows.Forms.Application]::EnableVisualStyles()

$iconPath = Join-Path $RepoRoot 'assets\uplayer.ico'
$icon = $null
if (Test-Path -LiteralPath $iconPath) {
  try {
    $icon = New-Object System.Drawing.Icon $iconPath
  } catch {
    $icon = $null
  }
}
if (-not $icon) {
  $icon = [System.Drawing.SystemIcons]::Application
}

$notifyIcon = New-Object System.Windows.Forms.NotifyIcon
$notifyIcon.Icon = $icon
$notifyIcon.Visible = $true
$notifyIcon.Text = 'Uplayer Web'

$menu = New-Object System.Windows.Forms.ContextMenuStrip
$openItem = $menu.Items.Add('Open in browser')
$quitItem = $menu.Items.Add('Quit')
$notifyIcon.ContextMenuStrip = $menu

$openItem.add_Click({
  Open-UplayerWeb -Port $port
})

$quitItem.add_Click({
  try {
    if ($script:serverProcess -and -not $script:serverProcess.HasExited) {
      $script:serverProcess.Kill()
    }
  } catch { }
  $notifyIcon.Visible = $false
  $notifyIcon.Dispose()
  if ($icon -and $icon -ne [System.Drawing.SystemIcons]::Application) {
    $icon.Dispose()
  }
  [System.Windows.Forms.Application]::Exit()
})

$notifyIcon.add_DoubleClick({
  Open-UplayerWeb -Port $port
})

$script:serverProcess = $serverProcess

[System.Windows.Forms.Application]::Run()
