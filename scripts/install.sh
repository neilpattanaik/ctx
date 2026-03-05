#!/usr/bin/env bash
set -euo pipefail

REPO="${CTX_INSTALL_REPO:-neilpattanaik/ctx}"
INSTALL_DIR="${CTX_INSTALL_DIR:-/usr/local/bin}"
VERSION="${CTX_VERSION:-latest}"
API_BASE="https://api.github.com/repos/${REPO}"
tmp_dir="$(mktemp -d)"

need_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "error: required command '$1' is not installed" >&2
    exit 1
  fi
}

need_cmd curl
need_cmd tar

extract_json_value() {
  local key="$1"
  sed -n "s/.*\"${key}\": *\"\\([^\"]*\\)\".*/\\1/p" | head -n1
}

resolve_release_tag() {
  if [ "$VERSION" = "latest" ]; then
    local latest_json
    latest_json="$(curl -fsSL "${API_BASE}/releases/latest")"
    local latest_tag
    latest_tag="$(printf '%s' "$latest_json" | extract_json_value "tag_name")"
    if [ -z "$latest_tag" ]; then
      echo "error: failed to resolve latest release tag for ${REPO}" >&2
      exit 1
    fi
    printf '%s' "$latest_tag"
    return
  fi

  case "$VERSION" in
    v*)
      printf '%s' "$VERSION"
      ;;
    *)
      printf 'v%s' "$VERSION"
      ;;
  esac
}

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
tag="$(resolve_release_tag)"
download_url="https://github.com/${REPO}/releases/download/${tag}/${asset}"
archive_path="${tmp_dir}/${asset}"

install_binary() {
  local bin_path="$1"
  local install_target="${INSTALL_DIR}/ctx"

  if [ -w "$INSTALL_DIR" ] || { [ ! -e "$INSTALL_DIR" ] && [ -w "$(dirname "$INSTALL_DIR")" ]; }; then
    mkdir -p "$INSTALL_DIR"
    install -m 0755 "$bin_path" "$install_target"
  else
    if command -v sudo >/dev/null 2>&1; then
      sudo mkdir -p "$INSTALL_DIR"
      sudo install -m 0755 "$bin_path" "$install_target"
    else
      echo "error: cannot write to '$INSTALL_DIR' and 'sudo' is unavailable" >&2
      echo "Try: CTX_INSTALL_DIR=\"$HOME/.local/bin\" curl -fsSL https://raw.githubusercontent.com/${REPO}/main/scripts/install.sh | bash" >&2
      exit 1
    fi
  fi

  echo "Installed ctx to ${install_target}"
  echo "Run: ctx --help"
}

echo "Downloading ${download_url}"
if curl -fL "$download_url" -o "$archive_path"; then
  tar -xzf "$archive_path" -C "$tmp_dir"
  binary_path="${tmp_dir}/ctx"

  if [ ! -f "$binary_path" ]; then
    echo "error: release archive did not contain expected binary 'ctx'" >&2
    exit 1
  fi

  install_binary "$binary_path"
  exit 0
fi

echo "warning: no prebuilt binary found for ${tag} (${asset}), falling back to source build" >&2
need_cmd bun

source_archive_path="${tmp_dir}/source.tar.gz"
source_url="https://github.com/${REPO}/archive/refs/tags/${tag}.tar.gz"
echo "Downloading source archive ${source_url}"
curl -fL "$source_url" -o "$source_archive_path"
tar -xzf "$source_archive_path" -C "$tmp_dir"

source_dir="$(find "$tmp_dir" -mindepth 1 -maxdepth 1 -type d | head -n1)"
if [ -z "$source_dir" ]; then
  echo "error: failed to locate extracted source directory" >&2
  exit 1
fi

(
  cd "$source_dir"
  bun install --frozen-lockfile --ignore-scripts
  bun build src/index.ts --compile --outfile dist/ctx
)

source_binary="${source_dir}/dist/ctx"
if [ ! -f "$source_binary" ]; then
  echo "error: source build did not produce dist/ctx" >&2
  exit 1
fi

install_binary "$source_binary"
