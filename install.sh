#!/bin/sh
# shoots installer for macOS / Linux.
#
#   curl -fsSL https://www.shoots-ai.com/install.sh | bash
#
# Downloads the latest release binary for your OS/arch, verifies its SHA-256,
# installs it to ~/.shoots/bin and adds that to your PATH. Override the target
# directory with SHOOTS_INSTALL_DIR, or the repo with SHOOTS_REPO.
set -eu

REPO="${SHOOTS_REPO:-stefanopascazi/shoots}"
INSTALL_DIR="${SHOOTS_INSTALL_DIR:-$HOME/.shoots/bin}"

err() { echo "error: $*" >&2; exit 1; }

os=$(uname -s 2>/dev/null || echo unknown)
arch=$(uname -m 2>/dev/null || echo unknown)
case "$os" in
  Linux) plat=linux ;;
  Darwin) plat=darwin ;;
  *) err "unsupported OS '$os' — on Windows use the PowerShell installer (install.ps1)" ;;
esac
case "$arch" in
  x86_64 | amd64) cpu=x64 ;;
  aarch64 | arm64) cpu=arm64 ;;
  *) err "unsupported architecture '$arch'" ;;
esac

# Intel macOS is intentionally not built (no reliable Intel CI runner; the Bun
# binary embeds per-arch native addons, so no universal/cross build). Fail early
# with a clear reason rather than a confusing "download failed".
if [ "$plat" = darwin ] && [ "$cpu" = x64 ]; then
  err "Intel macOS (darwin-x64) is not supported — shoots ships an Apple Silicon (arm64) build only"
fi

target="${plat}-${cpu}"
asset="shoots-${target}"
base="https://github.com/${REPO}/releases/latest/download"

command -v curl >/dev/null 2>&1 || err "curl is required"

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

echo "Downloading shoots (${target})…"
curl -fsSL "${base}/${asset}" -o "${tmp}/shoots" \
  || err "download failed — is there a published release with a ${target} binary?"

# Verify against the release checksums when present.
if curl -fsSL "${base}/SHA256SUMS.txt" -o "${tmp}/sums" 2>/dev/null; then
  expected=$(awk -v f="$asset" '$2 == f {print $1}' "${tmp}/sums" | tr 'A-F' 'a-f')
  if [ -n "$expected" ]; then
    if command -v sha256sum >/dev/null 2>&1; then
      actual=$(sha256sum "${tmp}/shoots" | awk '{print $1}')
    elif command -v shasum >/dev/null 2>&1; then
      actual=$(shasum -a 256 "${tmp}/shoots" | awk '{print $1}')
    else
      actual=""
    fi
    [ -z "$actual" ] || [ "$expected" = "$actual" ] \
      || err "checksum mismatch (expected $expected, got $actual)"
  fi
fi

mkdir -p "$INSTALL_DIR"
mv "${tmp}/shoots" "${INSTALL_DIR}/shoots"
chmod +x "${INSTALL_DIR}/shoots"
echo "Installed to ${INSTALL_DIR}/shoots"

# Ensure INSTALL_DIR is on PATH for future shells.
add_to_rc() {
  rc="$1"
  [ -f "$rc" ] || return 0
  grep -Fqs "$INSTALL_DIR" "$rc" && return 0
  printf '\n# shoots\nexport PATH="%s:$PATH"\n' "$INSTALL_DIR" >>"$rc"
  echo "Added ${INSTALL_DIR} to PATH in ${rc}"
}
case ":${PATH}:" in
  *":${INSTALL_DIR}:"*) ;;
  *)
    add_to_rc "$HOME/.bashrc"
    add_to_rc "$HOME/.zshrc"
    add_to_rc "$HOME/.profile"
    echo "Open a new terminal (or run: export PATH=\"${INSTALL_DIR}:\$PATH\") to use shoots."
    ;;
esac

echo "✓ Done. Next: shoots setup && shoots --help"
