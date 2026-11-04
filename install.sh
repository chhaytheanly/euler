
#!/usr/bin/env bash

set -Eeuo pipefail

GITHUB_REPO="chhaytheanly/euler"
BRANCH="main"

INSTALL_DIR="$HOME/.local/share/euler"
BIN_DIR="$HOME/.local/bin"
BIN_PATH="$BIN_DIR/euler"

REPO_URL="https://github.com/${GITHUB_REPO}"
ARCHIVE_URL="https://codeload.github.com/${GITHUB_REPO}/tar.gz/refs/heads/${BRANCH}"

echo ""
echo "  Euler CLI Installer"
echo "  ==================="
echo ""

# Requirement
for cmd in curl tar node npm; do
    if ! command -v "$cmd" >/dev/null 2>&1; then
        echo "Error: $cmd is required but not installed."
        exit 1
    fi
done

NODE_VERSION="$(node -p 'process.versions.node')"
NODE_MAJOR="${NODE_VERSION%%.*}"

if (( NODE_MAJOR < 22 )); then
    echo "Error: Euler requires Node.js >= 22."
    echo "Current version: $NODE_VERSION"
    exit 1
fi

echo "[1/6] Requirements satisfied"
echo "      Node.js $NODE_VERSION"

# Shift to tmp then clean up
TMP_DIR="$(mktemp -d)"
SOURCE_DIR="$TMP_DIR/source"

cleanup() {
    rm -rf "$TMP_DIR"
}

trap cleanup EXIT

mkdir -p "$SOURCE_DIR"

# Clone source code from GitHub
echo "[2/6] Downloading Euler from GitHub..."

curl -fsSL --retry 3 "$ARCHIVE_URL" \
    -o "$TMP_DIR/euler.tar.gz"

tar -xzf "$TMP_DIR/euler.tar.gz" \
    --strip-components=1 \
    -C "$SOURCE_DIR"

if [[ ! -f "$SOURCE_DIR/package.json" ]]; then
    echo "Error: Invalid Euler repository archive."
    exit 1
fi

# Install dependencies
echo "[3/6] Installing dependencies..."

cd "$SOURCE_DIR"

if [[ -f package-lock.json ]]; then
    npm ci
else
    npm install
fi

# Build Euler
echo "[4/6] Building Euler..."

npm run typecheck
npm run build

if [[ ! -f "$SOURCE_DIR/dist/index.js" ]]; then
    echo "Error: Euler build output not found."
    exit 1
fi

chmod +x "$SOURCE_DIR/dist/index.js"

# install Euler
echo "[5/6] Installing Euler..."

mkdir -p "$(dirname "$INSTALL_DIR")"
mkdir -p "$BIN_DIR"

# Replace previous installation
rm -rf "$INSTALL_DIR"
mv "$SOURCE_DIR" "$INSTALL_DIR"

# Create executable
ln -sfn "$INSTALL_DIR/dist/index.js" "$BIN_PATH"

# Path
add_path_to_file() {
    local file="$1"

    touch "$file"

    if ! grep -Fq 'export PATH="$HOME/.local/bin:$PATH"' "$file"; then
        {
            echo ""
            echo '# Euler CLI'
            echo 'export PATH="$HOME/.local/bin:$PATH"'
        } >> "$file"
    fi
}

if [[ ":$PATH:" != *":$BIN_DIR:"* ]]; then
    case "${SHELL##*/}" in
        bash)
            add_path_to_file "$HOME/.bashrc"
            add_path_to_file "$HOME/.profile"
            ;;
        zsh)
            add_path_to_file "$HOME/.zshrc"
            add_path_to_file "$HOME/.zprofile"
            ;;
        *)
            add_path_to_file "$HOME/.profile"
            ;;
    esac
fi


echo "[6/6] Installation completed!"
echo ""
echo "  Euler has been installed successfully."
echo ""
echo "  Repository: $REPO_URL"
echo "  Location:   $INSTALL_DIR"
echo "  Executable: $BIN_PATH"
echo ""

if [[ ":$PATH:" != *":$BIN_DIR:"* ]]; then
    echo "  Run this to update your current terminal:"
    echo ""
    echo '    export PATH="$HOME/.local/bin:$PATH"'
    echo ""
    echo "  Or restart your terminal."
else
    echo "  Start Euler with:"
    echo ""
    echo "    euler"
fi

echo ""
