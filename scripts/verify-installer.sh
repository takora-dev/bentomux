#!/bin/sh
# End-to-end check for installers/install.sh without touching the real release:
# generates a manifest with the real generator, points it at a local file mirror
# and runs the AppImage install path into a throwaway HOME. The generator
# swallows most mistakes at build time; this is what proves the installed script
# agrees with it (manifest extraction, checksum gate, desktop entry, dry run).
set -eu

root="$(cd "$(dirname "$0")/.." && pwd)"
tmp="$(mktemp -d "${TMPDIR:-/tmp}/bentomux-verify.XXXXXX")"

cleanup() {
    rm -rf "$tmp"
}
trap cleanup EXIT

fail() {
    printf 'verify-installer: %s\n' "$1" >&2
    exit 1
}

mkdir -p "$tmp/serve" "$tmp/home"
name="Bentomux_0.1.0_amd64.AppImage"
printf '#!/bin/sh\necho fake appimage\n' > "$tmp/serve/$name"

node -e '
const { createHash } = require("node:crypto");
const { readFileSync } = require("node:fs");
process.stdout.write(createHash("sha256").update(readFileSync(process.argv[1])).digest("hex") + "  " + process.argv[2] + "\n");
' "$tmp/serve/$name" "$name" > "$tmp/checksums.sha256"

node "$root/scripts/release-manifest.mjs" --tag v0.1.0 --checksums "$tmp/checksums.sha256" \
    --out "$tmp/serve/latest.json" > "$tmp/manifest.log"

# Point the generated manifest at the local mirror; the asset layout stays the
# one CI publishes, so the installer still parses real generator output.
node -e '
const { readFileSync, writeFileSync } = require("node:fs");
const [file, from, to] = process.argv.slice(1);
writeFileSync(file, readFileSync(file, "utf8").replaceAll(from, to));
' "$tmp/serve/latest.json" "https://github.com/takora-dev/bentomux/releases/download/v0.1.0/" "file://$tmp/serve/"

base="file://$tmp/serve"
install_env="BENTOMUX_MANIFEST_URL=$base/latest.json BENTOMUX_TARGET=linux-x86_64 BENTOMUX_INSTALL_DIR=$tmp/home/.local/bin"

# 1. dry run resolves the asset and stops.
env HOME="$tmp/home" $install_env BENTOMUX_DRY_RUN=1 sh "$root/installers/install.sh" > "$tmp/dry.log" 2>&1 \
    || fail "dry run failed: $(cat "$tmp/dry.log")"
[ -e "$tmp/home/.local/bin/bentomux" ] && fail "dry run installed the binary anyway"
grep -q 'dry run: not writing' "$tmp/dry.log" || fail "dry run did not report skipping the install"
grep -q "$base/$name" "$tmp/dry.log" || fail "dry run did not resolve the AppImage url"
grep -q 'release: v0.1.0' "$tmp/dry.log" || fail "the manifest version was not read"

# 2. real install into the throwaway HOME.
env HOME="$tmp/home" $install_env sh "$root/installers/install.sh" > "$tmp/install.log" 2>&1 \
    || fail "install failed: $(cat "$tmp/install.log")"
[ -x "$tmp/home/.local/bin/bentomux" ] || fail "installed binary missing or not executable"
cmp -s "$tmp/serve/$name" "$tmp/home/.local/bin/bentomux" || fail "installed binary differs from the download"
grep -q "Exec=$tmp/home/.local/bin/bentomux" "$tmp/home/.local/share/applications/bentomux.desktop" \
    || fail "desktop entry missing or pointing at the wrong binary"

# 3. a tampered checksum must abort before anything is written.
tampered="$tmp/home/tampered"
node -e '
const { readFileSync, writeFileSync } = require("node:fs");
const file = process.argv[1];
const json = JSON.parse(readFileSync(file, "utf8"));
for (const asset of Object.values(json.assets)) asset.sha256 = "0".repeat(64);
writeFileSync(file, JSON.stringify(json, null, 2) + "\n");
' "$tmp/serve/latest.json"
if env HOME="$tmp/home" $install_env BENTOMUX_INSTALL_DIR="$tampered" sh "$root/installers/install.sh" > "$tmp/tamper.log" 2>&1; then
    fail "installer accepted a bad checksum"
fi
grep -q 'checksum mismatch' "$tmp/tamper.log" || fail "unexpected failure on bad checksum: $(cat "$tmp/tamper.log")"
[ -e "$tampered/bentomux" ] && fail "installer wrote a file despite the checksum mismatch"

# 4. an unpublished target must be refused, not guessed.
if env HOME="$tmp/home" $install_env BENTOMUX_TARGET=linux-aarch64 sh "$root/installers/install.sh" > "$tmp/target.log" 2>&1; then
    fail "installer accepted a target the release does not provide"
fi
grep -q 'no build for linux-aarch64' "$tmp/target.log" || fail "unexpected target error: $(cat "$tmp/target.log")"

# 5. an unreachable manifest must abort on the fetch error instead of carrying
# an empty document into a confusing "no build for X" message.
if env HOME="$tmp/home" BENTOMUX_MANIFEST_URL="$base/missing.json" sh "$root/installers/install.sh" > "$tmp/missing.log" 2>&1; then
    fail "installer accepted a manifest that does not exist"
fi
grep -q 'cannot reach' "$tmp/missing.log" || fail "unexpected missing-manifest error: $(cat "$tmp/missing.log")"
grep -q 'has no build' "$tmp/missing.log" && fail "the fetch error was swallowed into a target error"

printf 'verify-installer: ok\n'
