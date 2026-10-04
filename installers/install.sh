#!/bin/sh
# Bentomux installer for macOS and Linux.
#
#   curl -fsSL https://raw.githubusercontent.com/takora-dev/bentomux/master/installers/install.sh | sh
#
# Reads the release manifest published by CI, downloads the build for this
# platform, verifies its SHA-256 and installs it:
#   macOS  .dmg  -> the .app bundle into /Applications (or ~/Applications)
#   Linux  .deb  -> through apt/dpkg (--deb, needs root)
#   Linux  .AppImage -> ~/.local/bin/bentomux plus a desktop entry (default)
#
# Options: --deb, --appimage, --dry-run, --help
# Env: BENTOMUX_INSTALL_DIR, BENTOMUX_MANIFEST_URL, BENTOMUX_TARGET, BENTOMUX_DRY_RUN
set -eu

REPO="${BENTOMUX_REPO:-takora-dev/bentomux}"
MANIFEST_URL="${BENTOMUX_MANIFEST_URL:-https://github.com/${REPO}/releases/latest/download/latest.json}"
INSTALL_DIR="${BENTOMUX_INSTALL_DIR:-$HOME/.local/bin}"
TARGET="${BENTOMUX_TARGET:-}"
FORMAT=""
DRY_RUN=0

# A custom manifest may point at a local mirror (http mirror or a file:// path);
# an HTTPS manifest keeps the downloads HTTPS-only so a hijacked asset URL
# cannot downgrade them.
case "$MANIFEST_URL" in
    https://*) CURL_PROTO="--proto =https" ;;
    *) CURL_PROTO="--proto =http,https,file" ;;
esac

log() { printf '  \033[32m>\033[0m %s\n' "$1"; }
warn() { printf '  \033[33m!\033[0m %s\n' "$1" >&2; }
err() { printf '  \033[31mx\033[0m %s\n' "$1" >&2; exit 1; }

need() {
    command -v "$1" >/dev/null 2>&1 || err "requires '$1', which is not installed"
}

usage() {
    cat <<'EOF'
Bentomux installer

  install.sh [--deb | --appimage] [--dry-run]

  --deb        Linux only: install the .deb through apt/dpkg (needs root)
  --appimage   Linux only: install the AppImage into ~/.local/bin (default)
  --dry-run    resolve and verify the release, then stop before installing
  --help       show this message

Environment:
  BENTOMUX_INSTALL_DIR   where the AppImage is installed (default ~/.local/bin)
  BENTOMUX_MANIFEST_URL  release manifest to read (default: latest GitHub release)
  BENTOMUX_TARGET        override platform detection, e.g. linux-x86_64
  BENTOMUX_DRY_RUN       set to 1 for --dry-run
EOF
}

parse_args() {
    while [ $# -gt 0 ]; do
        case "$1" in
            --deb) FORMAT="deb" ;;
            --appimage) FORMAT="appimage" ;;
            --dry-run) DRY_RUN=1 ;;
            -h | --help) usage; exit 0 ;;
            *) err "unknown option '$1' (see --help)" ;;
        esac
        shift
    done
    if [ "${BENTOMUX_DRY_RUN:-0}" = "1" ]; then
        DRY_RUN=1
    fi
}

detect_target() {
    os="$(uname -s)"
    arch="$(uname -m)"
    case "$arch" in
        x86_64 | amd64) arch="x86_64" ;;
        aarch64 | arm64) arch="aarch64" ;;
        *) err "unsupported architecture: $arch" ;;
    esac
    case "$os" in
        Darwin) [ -z "$FORMAT" ] || [ "$FORMAT" = "dmg" ] || err "--$FORMAT is not available on macOS"; printf 'macos' ;;
        Linux)
            if [ "$FORMAT" = "deb" ]; then printf 'linux-deb-%s' "$arch"; else printf 'linux-%s' "$arch"; fi
            ;;
        *) err "unsupported OS: $os (Bentomux ships macOS, Linux and Windows builds)" ;;
    esac
}

fetch_manifest() {
    curl -fsSL --retry 3 --connect-timeout 10 --max-time 60 $CURL_PROTO -- "$MANIFEST_URL" \
        || err "cannot reach $MANIFEST_URL"
}

# install.sh and scripts/release-manifest.mjs must agree on this expression: the
# manifest is emitted as pretty JSON with a fixed key order, flattened here so a
# plain sed can pull one asset out of it (no jq/python on a fresh machine).
asset_entry() {
    printf '%s' "$1" | sed -n 's/.*"'"$2"'":\({"format":"[^"]*","url":"[^"]*","sha256":"[^"]*"}\).*/\1/p'
}

field() {
    printf '%s' "$1" | sed -n 's/.*"'"$2"'":"\([^"]*\)".*/\1/p'
}

available_targets() {
    printf '%s' "$1" | grep -o '"[a-z0-9_-]*":{"format":"' | sed 's/":{"format":"$//; s/^"//' | tr '\n' ' '
}

sha256_of() {
    if command -v sha256sum >/dev/null 2>&1; then
        sha256sum "$1" | cut -d' ' -f1
    elif command -v shasum >/dev/null 2>&1; then
        shasum -a 256 "$1" | cut -d' ' -f1
    elif command -v openssl >/dev/null 2>&1; then
        openssl dgst -sha256 "$1" | awk '{ print $NF }'
    else
        err "verifying the download needs sha256sum, shasum or openssl"
    fi
}

verify_sha() {
    got="$(sha256_of "$1")"
    if [ "$got" != "$SHA256" ]; then
        err "checksum mismatch for $(basename "$1"): expected $SHA256, got $got"
    fi
    log "checksum verified"
}

download() {
    log "downloading $(basename "$1")"
    if [ -t 2 ]; then
        curl -fL --retry 3 --connect-timeout 10 --max-time 900 --progress-bar $CURL_PROTO -o "$2" -- "$1" \
            || err "download failed: $1"
    else
        curl -fsSL --retry 3 --connect-timeout 10 --max-time 900 $CURL_PROTO -o "$2" -- "$1" \
            || err "download failed: $1"
    fi
}

install_appimage() {
    appimage="$tmp/$(basename "$URL")"
    download "$URL" "$appimage"
    verify_sha "$appimage"
    if [ "$DRY_RUN" = 1 ]; then
        log "dry run: not writing to $INSTALL_DIR"
        return 0
    fi
    mkdir -p "$INSTALL_DIR"
    cp -f "$appimage" "$INSTALL_DIR/bentomux" || err "cannot write to $INSTALL_DIR"
    chmod 755 "$INSTALL_DIR/bentomux"
    install_icon
    write_desktop_entry
    check_path
    check_fuse
    log "installed: $INSTALL_DIR/bentomux"
}

install_icon() {
    if ! (cd "$tmp" && "$INSTALL_DIR/bentomux" --appimage-extract '*.png' >/dev/null 2>&1); then
        warn "could not read the bundle icon; the desktop entry falls back to a generic icon"
        return 0
    fi
    for size in 256x256 512x512 128x128 64x64 48x48 32x32; do
        icon="$(find "$tmp/squashfs-root" -path "*/hicolor/$size/apps/*.png" -print 2>/dev/null | head -n 1)"
        if [ -n "$icon" ]; then
            icon_dir="$HOME/.local/share/icons/hicolor/$size/apps"
            mkdir -p "$icon_dir"
            cp -f "$icon" "$icon_dir/bentomux.png" 2>/dev/null || true
            return 0
        fi
    done
    warn "the bundle has no hicolor png icon; the desktop entry falls back to a generic icon"
}

write_desktop_entry() {
    dir="$HOME/.local/share/applications"
    mkdir -p "$dir"
    cat >"$dir/bentomux.desktop" <<EOF
[Desktop Entry]
Type=Application
Name=Bentomux
Comment=Calm desktop for AI agent runtime workspaces
Exec=$INSTALL_DIR/bentomux %U
Icon=bentomux
Terminal=false
Categories=Development;Utility;
StartupNotify=true
EOF
    if command -v update-desktop-database >/dev/null 2>&1; then
        update-desktop-database "$dir" >/dev/null 2>&1 || true
    fi
}

check_path() {
    case ":${PATH}:" in
        *":$INSTALL_DIR:"*) return 0 ;;
    esac
    warn "$INSTALL_DIR is not in your PATH; add it and reopen your shell:"
    warn "  export PATH=\"$INSTALL_DIR:\$PATH\""
}

check_fuse() {
    if [ -e /dev/fuse ] || command -v fusermount >/dev/null 2>&1 || command -v fusermount3 >/dev/null 2>&1; then
        return 0
    fi
    warn "the AppImage needs libfuse2, which does not look installed:"
    warn "  sudo apt install libfuse2"
}

install_deb() {
    deb="$tmp/$(basename "$URL")"
    download "$URL" "$deb"
    verify_sha "$deb"
    if [ "$DRY_RUN" = 1 ]; then
        log "dry run: not running apt/dpkg"
        return 0
    fi
    sudo_cmd=""
    if [ "$(id -u)" -ne 0 ]; then
        command -v sudo >/dev/null 2>&1 || err "installing a .deb needs root: rerun with sudo, or use --appimage"
        sudo_cmd="sudo"
    fi
    # shellcheck disable=SC2086
    if command -v apt-get >/dev/null 2>&1; then
        if ! $sudo_cmd apt-get install -y "$deb"; then
            $sudo_cmd dpkg -i "$deb" || err "apt/dpkg could not install $(basename "$deb")"
        fi
    elif command -v dpkg >/dev/null 2>&1; then
        $sudo_cmd dpkg -i "$deb" || err "dpkg could not install $(basename "$deb")"
    else
        err "no dpkg or apt-get on this system: install the AppImage with --appimage instead"
    fi
    log "installed $(basename "$deb")"
}

install_macos() {
    dmg="$tmp/$(basename "$URL")"
    download "$URL" "$dmg"
    verify_sha "$dmg"
    if [ "$DRY_RUN" = 1 ]; then
        log "dry run: not mounting $(basename "$dmg")"
        return 0
    fi
    need hdiutil
    need ditto
    mount="$tmp/mnt"
    mkdir -p "$mount"
    hdiutil attach -nobrowse -quiet -mountpoint "$mount" "$dmg" >/dev/null || err "cannot mount $(basename "$dmg")"
    trap 'hdiutil detach "$mount" -quiet >/dev/null 2>&1 || true; rm -rf "$tmp"' EXIT
    app="$(find "$mount" -maxdepth 1 -name '*.app' -print | head -n 1)"
    if [ -z "$app" ]; then
        err "no .app bundle inside $(basename "$dmg")"
    fi
    name="$(basename "$app")"
    dest_dir="/Applications"
    if [ ! -w "$dest_dir" ]; then
        dest_dir="$HOME/Applications"
        warn "/Applications is not writable; installing into $dest_dir instead"
    fi
    mkdir -p "$dest_dir"
    dest="$dest_dir/$name"
    if [ -e "$dest" ]; then
        log "replacing the existing $dest"
        rm -rf "$dest"
    fi
    ditto "$app" "$dest" || err "cannot copy $name into $dest_dir"
    hdiutil detach "$mount" -quiet >/dev/null 2>&1 || true
    if xattr -p com.apple.quarantine "$dest" >/dev/null 2>&1; then
        warn "$name carries the com.apple.quarantine flag (browser download)"
        warn "this build is not signed or notarized, so Gatekeeper cannot verify it;"
        warn "clearing the flag so it can start"
        xattr -dr com.apple.quarantine "$dest" >/dev/null 2>&1 || true
    fi
    log "installed: $dest"
}

main() {
    parse_args "$@"
    need curl
    need sed
    if [ -z "$TARGET" ]; then
        TARGET="$(detect_target)"
    fi
    log "target: $TARGET"
    log "manifest: $MANIFEST_URL"
    flat="$(fetch_manifest)"
    # Fetched first, flattened second: inside a pipeline the fetch error would be
    # masked by tr's exit status and the script would carry on with nothing.
    flat="$(printf '%s' "$flat" | tr -d ' \t\n\r')"
    [ -n "$flat" ] || err "$MANIFEST_URL returned an empty manifest"
    VERSION="$(field "$flat" version)"
    entry="$(asset_entry "$flat" "$TARGET")"
    if [ -z "$entry" ]; then
        err "release ${VERSION:-?} has no build for $TARGET (available: $(available_targets "$flat"))"
    fi
    URL="$(field "$entry" url)"
    SHA256="$(field "$entry" sha256)"
    if [ "${#SHA256}" -ne 64 ]; then
        err "manifest carries no usable SHA-256 for $TARGET; refusing to install"
    fi
    log "release: v${VERSION:-?}"
    if [ "$DRY_RUN" = 1 ]; then
        log "url: $URL"
        log "sha256: $SHA256"
    fi

    tmp="$(mktemp -d "${TMPDIR:-/tmp}/bentomux.XXXXXX")"
    trap 'rm -rf "$tmp"' EXIT

    case "$TARGET" in
        macos) install_macos ;;
        linux-deb-*) install_deb ;;
        linux-*) install_appimage ;;
        *) err "no install path for target $TARGET" ;;
    esac
    log "Bentomux ${VERSION:-} installed"
}

main "$@"
