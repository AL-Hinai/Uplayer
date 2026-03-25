#!/usr/bin/env bash

set -euo pipefail

G='\033[0;32m'
Y='\033[1;33m'
B='\033[0;34m'
C='\033[0;36m'
R='\033[0;31m'
N='\033[0m'

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INSTALL_DIR="${HOME}/.local/bin"
VLC_COMMAND=""
VLC_DOWNLOAD_URL="https://www.videolan.org/vlc/"
VLC_INSTALL_STATUS="not-attempted"

print_header() {
  clear || true
  echo -e "${C}========================================${N}"
  echo -e "${C}  UPLAYER - Universal Installer         ${N}"
  echo -e "${C}========================================${N}"
  echo
}

has_command() {
  command -v "$1" >/dev/null 2>&1
}

resolve_vlc_command() {
  if has_command vlc; then
    command -v vlc
    return 0
  fi

  if has_command vlc.exe; then
    command -v vlc.exe
    return 0
  fi

  local candidate
  for candidate in \
    "/c/Program Files/VideoLAN/VLC/vlc.exe" \
    "/c/Program Files (x86)/VideoLAN/VLC/vlc.exe" \
    "/mnt/c/Program Files/VideoLAN/VLC/vlc.exe" \
    "/mnt/c/Program Files (x86)/VideoLAN/VLC/vlc.exe"
  do
    if [[ -x "$candidate" ]]; then
      echo "$candidate"
      return 0
    fi
  done

  return 1
}

detect_os() {
  case "$(uname -s)" in
    Linux*) echo "linux" ;;
    Darwin*) echo "macos" ;;
    MINGW*|MSYS*|CYGWIN*) echo "windows-shell" ;;
    *) echo "linux" ;;
  esac
}

detect_shell_rc() {
  if [[ -n "${ZSH_VERSION:-}" ]]; then
    echo "${HOME}/.zshrc"
  elif [[ -n "${BASH_VERSION:-}" ]]; then
    echo "${HOME}/.bashrc"
  else
    echo "${HOME}/.profile"
  fi
}

vlc_exists() {
  local resolved=""
  if ! resolved="$(resolve_vlc_command)"; then
    return 1
  fi

  if [[ "$resolved" == */* ]]; then
    export PATH="${PATH}:$(dirname "$resolved")"
  fi

  return 0
}

run_install_deps() {
  "${INSTALL_CMD[@]}"
}

write_launcher() {
  mkdir -p "$INSTALL_DIR"

  if [[ "$RUNTIME" == "bun" ]]; then
    cat > "${INSTALL_DIR}/uplayer" <<EOF
#!/usr/bin/env bash
exec bun run "${SCRIPT_DIR}/uplayer.js" "\$@"
EOF
  else
    cat > "${INSTALL_DIR}/uplayer" <<EOF
#!/usr/bin/env bash
exec node "${SCRIPT_DIR}/uplayer.js" "\$@"
EOF
  fi

  chmod +x "${INSTALL_DIR}/uplayer"
}

ensure_path() {
  local rc_file
  rc_file="$(detect_shell_rc)"

  if ! grep -Fq "$INSTALL_DIR" "$rc_file" 2>/dev/null; then
    {
      echo
      echo "# Uplayer"
      echo "export PATH=\"\$PATH:${INSTALL_DIR}\""
    } >> "$rc_file"
    echo -e "  ${G}OK${N} Added ${INSTALL_DIR} to ${rc_file}"
  else
    echo -e "  ${G}OK${N} PATH already contains ${INSTALL_DIR}"
  fi

  export PATH="${PATH}:${INSTALL_DIR}"
}

print_manual_vlc_help() {
  echo -e "  ${Y}!${N} VLC was not installed automatically."
  if [[ -n "$VLC_COMMAND" ]]; then
    echo -e "  ${Y}!${N} Exact install command:"
    echo "      ${VLC_COMMAND}"
  fi
  echo -e "  ${Y}!${N} Manual download: ${VLC_DOWNLOAD_URL}"
}

linux_vlc_install() {
  local -a elevate=()
  if [[ "$(id -u)" -ne 0 ]]; then
    if has_command sudo; then
      elevate=(sudo)
    else
      return 1
    fi
  fi

  if has_command apt-get; then
    VLC_COMMAND="${elevate[*]} apt-get update && ${elevate[*]} apt-get install -y vlc"
    "${elevate[@]}" apt-get update && "${elevate[@]}" apt-get install -y vlc
    return
  fi

  if has_command dnf; then
    VLC_COMMAND="${elevate[*]} dnf install -y vlc"
    "${elevate[@]}" dnf install -y vlc
    return
  fi

  if has_command yum; then
    VLC_COMMAND="${elevate[*]} yum install -y vlc"
    "${elevate[@]}" yum install -y vlc
    return
  fi

  if has_command pacman; then
    VLC_COMMAND="${elevate[*]} pacman -Sy --noconfirm vlc"
    "${elevate[@]}" pacman -Sy --noconfirm vlc
    return
  fi

  if has_command zypper; then
    VLC_COMMAND="${elevate[*]} zypper --non-interactive install vlc"
    "${elevate[@]}" zypper --non-interactive install vlc
    return
  fi

  return 1
}

macos_vlc_install() {
  if ! has_command brew; then
    return 1
  fi

  VLC_COMMAND="brew install --cask vlc"
  brew install --cask vlc
}

windows_shell_vlc_install() {
  VLC_DOWNLOAD_URL="https://www.videolan.org/vlc/download-windows.html"

  if has_command winget.exe; then
    VLC_COMMAND="winget.exe install --exact --id VideoLAN.VLC --accept-package-agreements --accept-source-agreements --silent"
    winget.exe install --exact --id VideoLAN.VLC --accept-package-agreements --accept-source-agreements --silent
    return
  fi

  if has_command choco; then
    VLC_COMMAND="choco install vlc -y"
    choco install vlc -y
    return
  fi

  return 1
}

install_windows_shortcuts() {
  echo -e "\n${C}[Windows]${N} Creating Desktop and Start Menu shortcuts..."
  local repo_win create_ps1
  if has_command cygpath; then
    repo_win="$(cygpath -w "$SCRIPT_DIR")"
    create_ps1="$(cygpath -w "$SCRIPT_DIR/scripts/create-windows-shortcuts.ps1")"
  else
    repo_win="$SCRIPT_DIR"
    create_ps1="$SCRIPT_DIR/scripts/create-windows-shortcuts.ps1"
  fi
  if powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$create_ps1" -RepoRoot "$repo_win"; then
    echo -e "  ${G}OK${N} Shortcut: Uplayer Web (opens tray + web UI)"
  else
    echo -e "  ${Y}!${N} Shortcut creation failed. From PowerShell run:"
    echo "      powershell -ExecutionPolicy Bypass -File \"$SCRIPT_DIR/scripts/create-windows-shortcuts.ps1\" -RepoRoot \"<full path to repo>\""
  fi
}

install_vlc() {
  echo -e "\n${C}[5/5]${N} Ensuring VLC is available..."

  if vlc_exists; then
    echo -e "  ${G}OK${N} VLC already installed"
    VLC_INSTALL_STATUS="present"
    return
  fi

  echo -e "  ${B}->${N} VLC not found. Attempting automatic install..."

  if [[ "$OS" == "macos" ]]; then
    if macos_vlc_install; then
      VLC_INSTALL_STATUS="installed"
    else
      VLC_INSTALL_STATUS="failed"
    fi
  elif [[ "$OS" == "windows-shell" ]]; then
    if windows_shell_vlc_install; then
      VLC_INSTALL_STATUS="installed"
    else
      VLC_INSTALL_STATUS="failed"
    fi
  else
    if linux_vlc_install; then
      VLC_INSTALL_STATUS="installed"
    else
      VLC_INSTALL_STATUS="failed"
    fi
  fi

  if vlc_exists; then
    echo -e "  ${G}OK${N} VLC is ready"
    VLC_INSTALL_STATUS="verified"
  else
    print_manual_vlc_help
  fi
}

print_footer() {
  echo
  echo -e "${G}========================================${N}"
  echo -e "${G}  Uplayer installation complete         ${N}"
  echo -e "${G}========================================${N}"
  echo
  echo -e "${C}Try it now:${N}"
  echo -e "  ${G}uplayer \"Inception\"${N}"
  echo
  if [[ "$VLC_INSTALL_STATUS" == "verified" || "$VLC_INSTALL_STATUS" == "present" ]]; then
    echo -e "${G}VLC status:${N} ready"
  else
    echo -e "${Y}VLC status:${N} manual setup may still be needed"
  fi
  echo
  echo -e "${Y}Note:${N} If the 'uplayer' command is not available yet, restart your shell or run:"
  echo -e "  ${C}source $(detect_shell_rc)${N}"
  echo
  if [[ "$OS" == "windows-shell" ]]; then
    echo -e "${C}Windows launcher:${N} Use the ${G}Uplayer Web${N} shortcut on your Desktop or Start Menu."
    echo -e "  It runs the server in the background and keeps a tray icon until you choose ${G}Quit${N}."
    echo -e "${Y}SmartScreen:${N} The first launch may prompt to allow ${C}Windows PowerShell${N} for unsigned scripts."
    echo
  fi
}

print_header

OS="$(detect_os)"
VLC_DOWNLOAD_URL="https://www.videolan.org/vlc/"

if [[ "$OS" == "windows-shell" ]]; then
  echo -e "${B}->${N} Detected shell environment on Windows (shortcuts will be created at end of setup)"
else
  echo -e "${B}->${N} Detected: ${G}${OS}${N}"
fi
echo -e "${B}->${N} Installing launcher into: ${C}${INSTALL_DIR}${N}"
echo

echo -e "${C}[1/5]${N} Checking runtime..."
if has_command bun; then
  RUNTIME="bun"
  INSTALL_CMD=(bun install)
  echo -e "  ${G}OK${N} Bun found"
elif has_command node; then
  RUNTIME="node"
  INSTALL_CMD=(npm install)
  echo -e "  ${G}OK${N} Node.js found"
else
  echo -e "  ${Y}!${N} No runtime found."
  if [[ "$OS" == "linux" || "$OS" == "macos" ]]; then
    curl -fsSL https://bun.sh/install | bash
    export BUN_INSTALL="${HOME}/.bun"
    export PATH="${BUN_INSTALL}/bin:${PATH}"
    RUNTIME="bun"
    INSTALL_CMD=(bun install)
    echo -e "  ${G}OK${N} Bun installed"
  else
    echo -e "${R}X${N} Install Node.js or Bun first, then rerun setup."
    echo "    Node.js: https://nodejs.org/"
    echo "    Bun: https://bun.sh/"
    exit 1
  fi
fi

echo -e "\n${C}[2/5]${N} Installing / updating dependencies..."
cd "$SCRIPT_DIR"
echo -e "  ${B}->${N} Running ${INSTALL_CMD[*]} (refreshes on every setup run)"
run_install_deps
echo -e "  ${G}OK${N} Dependencies installed / updated"

echo -e "\n${C}[3/5]${N} Creating global command..."
write_launcher
echo -e "  ${G}OK${N} Created ${INSTALL_DIR}/uplayer"

echo -e "\n${C}[4/5]${N} Updating PATH..."
ensure_path

install_vlc

if [[ "$OS" == "windows-shell" ]]; then
  install_windows_shortcuts
fi

print_footer
