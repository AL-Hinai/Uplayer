#!/usr/bin/env bash

# ═══════════════════════════════════════════════════════════════
#  UPLAYER - Universal One-Command Installer
#  Works on: Linux, macOS, Windows (WSL/Git Bash)
#  Result: Global 'uplayer' command ready to use
# ═══════════════════════════════════════════════════════════════

set -e

# Colors
G='\033[0;32m' Y='\033[1;33m' B='\033[0;34m' C='\033[0;36m' R='\033[0;31m' N='\033[0m'

clear
echo -e "${C}╔════════════════════════════════════════╗${N}"
echo -e "${C}║  UPLAYER - Universal Installer        ║${N}"
echo -e "${C}║  One command. Works everywhere.        ║${N}"
echo -e "${C}╚════════════════════════════════════════╝${N}\n"

# Detect OS
case "$(uname -s)" in
    Linux*)  OS="linux";;
    Darwin*) OS="macos";;
    *) OS="linux";;  # Fallback for WSL/Git Bash
esac

INSTALL_DIR="$HOME/.local/bin"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo -e "${B}→${N} Detected: ${G}$OS${N}"
echo -e "${B}→${N} Installing to: ${C}$INSTALL_DIR${N}\n"

# Step 1: Check/Install Runtime
echo -e "${C}[1/4]${N} Checking runtime..."
if command -v bun >/dev/null 2>&1; then
    echo -e "  ${G}✓${N} Bun found (fastest!)"
    RUNTIME="bun"
    INSTALL_CMD="bun install"
    RUN_CMD="bun run"
elif command -v node >/dev/null 2>&1; then
    echo -e "  ${G}✓${N} Node.js found"
    RUNTIME="node"
    INSTALL_CMD="npm install"
    RUN_CMD="node --expose-gc"
else
    echo -e "  ${Y}!${N} No runtime found. Installing Bun (fastest)..."
    if [[ "$OS" == "linux" ]] || [[ "$OS" == "macos" ]]; then
        curl -fsSL https://bun.sh/install | bash
        export BUN_INSTALL="$HOME/.bun"
        export PATH="$BUN_INSTALL/bin:$PATH"
        RUNTIME="bun"
        INSTALL_CMD="bun install"
        RUN_CMD="bun run"
        echo -e "  ${G}✓${N} Bun installed!"
    else
        echo -e "${R}✗${N} Please install Node.js from https://nodejs.org"
        exit 1
    fi
fi

# Step 2: Install Dependencies
echo -e "\n${C}[2/4]${N} Installing dependencies..."
cd "$SCRIPT_DIR"
if [[ ! -d "node_modules" ]]; then
    $INSTALL_CMD > /dev/null 2>&1
    echo -e "  ${G}✓${N} Dependencies installed"
else
    echo -e "  ${G}✓${N} Already installed"
fi

# Step 3: Create Global Command
echo -e "\n${C}[3/4]${N} Creating global command..."
mkdir -p "$INSTALL_DIR"

cat > "$INSTALL_DIR/uplayer" << EOF
#!/usr/bin/env bash
exec $RUN_CMD "$SCRIPT_DIR/uplayer.js" "\$@"
EOF

chmod +x "$INSTALL_DIR/uplayer"
echo -e "  ${G}✓${N} Global command created"

# Step 4: Add to PATH
echo -e "\n${C}[4/4]${N} Adding to PATH..."

# Detect shell config
if [[ -n "$BASH_VERSION" ]]; then
    RC="$HOME/.bashrc"
elif [[ -n "$ZSH_VERSION" ]]; then
    RC="$HOME/.zshrc"
else
    RC="$HOME/.profile"
fi

# Add to PATH if not already there
if ! grep -q "$INSTALL_DIR" "$RC" 2>/dev/null; then
    echo "" >> "$RC"
    echo "# Uplayer" >> "$RC"
    echo "export PATH=\"\$PATH:$INSTALL_DIR\"" >> "$RC"
    echo -e "  ${G}✓${N} Added to $RC"
else
    echo -e "  ${G}✓${N} Already in PATH"
fi

# Add to current session
export PATH="$PATH:$INSTALL_DIR"

# Check for media player
echo -e "\n${B}→${N} Checking for media player..."
if command -v vlc >/dev/null 2>&1 || command -v mpv >/dev/null 2>&1; then
    echo -e "  ${G}✓${N} Media player found"
else
    echo -e "  ${Y}!${N} No media player found. Install VLC or MPV."
fi

# Success!
echo -e "\n${G}╔════════════════════════════════════════╗${N}"
echo -e "${G}║  ✓ Installation Complete!             ║${N}"
echo -e "${G}╚════════════════════════════════════════╝${N}"

echo -e "\n${C}Try it now:${N}"
echo -e "  ${G}uplayer \"Inception\"${N}"
echo -e "\n${Y}Note:${N} If 'uplayer' command not found, run:"
echo -e "  ${C}source $RC${N}"
echo -e "  or restart your terminal\n"

