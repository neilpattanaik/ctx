#!/usr/bin/env bash
set -euo pipefail

REPO="${CTX_INSTALL_REPO:-neilpattanaik/ctx}"
INSTALL_DIR="${CTX_INSTALL_DIR:-/usr/local/bin}"
VERSION="${CTX_VERSION:-latest}"

need_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "error: required command '$1' is not installed" >&2
    exit 1
  fi
}

need_cmd curl
need_cmd tar

os_raw="$(uname -s)"
arch_raw="$(uname -m)"

case "$os_raw" in
  Linux)
    os="linux"
    ;;
  Darwin)
    os="macos"
    ;;
  *)
    echo "error: unsupported OS '$os_raw' for this installer" >&2
    echo "Download Windows binaries manually from releases: https://github.com/${REPO}/releases" >&2
    exit 1
    ;;
esac

case "$arch_raw" in
  x86_64|amd64)
    arch="x64"
    ;;
  arm64|aarch64)
    if [ "$os" = "macos" ]; then
      arch="arm64"
    else
      echo "error: unsupported architecture '$arch_raw' on $os (available: x64)" >&2
      exit 1
    fi
    ;;
  *)
    echo "error: unsupported architecture '$arch_raw'" >&2
    exit 1
    ;;
esac

asset="ctx-${os}-${arch}.tar.gz"

if [ "$VERSION" = "latest" ]; then
  download_url="https://github.com/${REPO}/releases/latest/download/${asset}"
else
  case "$VERSION" in
    v*)
      tag="$VERSION"
      ;;
    *)
      tag="v$VERSION"
      ;;
  esac
  download_url="https://github.com/${REPO}/releases/download/${tag}/${asset}"
fi

tmp_dir="$(mktemp -d)"
archive_path="${tmp_dir}/${asset}"

echo "Downloading ${download_url}"
curl -fL "$download_url" -o "$archive_path"

tar -xzf "$archive_path" -C "$tmp_dir"
binary_path="${tmp_dir}/ctx"

if [ ! -f "$binary_path" ]; then
  echo "error: archive did not contain expected binary 'ctx'" >&2
  exit 1
fi

install_target="${INSTALL_DIR}/ctx"

if [ -w "$INSTALL_DIR" ] || [ ! -e "$INSTALL_DIR" ] && [ -w "$(dirname "$INSTALL_DIR")" ]; then
  mkdir -p "$INSTALL_DIR"
  install -m 0755 "$binary_path" "$install_target"
else
  if command -v sudo >/dev/null 2>&1; then
    sudo mkdir -p "$INSTALL_DIR"
    sudo install -m 0755 "$binary_path" "$install_target"
  else
    echo "error: cannot write to '$INSTALL_DIR' and 'sudo' is unavailable" >&2
    echo "Try: CTX_INSTALL_DIR=\"$HOME/.local/bin\" curl -fsSL https://raw.githubusercontent.com/${REPO}/main/scripts/install.sh | bash" >&2
    exit 1
  fi
fi

echo "Installed ctx to ${install_target}"
echo "Run: ctx --help"
