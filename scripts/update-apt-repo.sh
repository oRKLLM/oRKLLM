#!/usr/bin/env bash
# Updates the gh-pages APT repository with a new .deb file.
# Usage: update-apt-repo.sh <path-to-deb> <repo-root> [channel]
#   channel: stable (default) | beta | alpha
set -euo pipefail

DEB="${1:?Usage: update-apt-repo.sh <path-to-deb> <repo-root> [channel]}"
REPO_ROOT="${2:-.}"
CHANNEL="${3:-stable}"
DEBNAME=$(basename "$DEB")

# Validate channel
case "$CHANNEL" in
  stable|beta|alpha) ;;
  *) echo "ERROR: invalid channel '$CHANNEL' — must be stable, beta, or alpha"; exit 1 ;;
esac

POOL_DIR="pool/$CHANNEL/o/orkllm"
DISTS_DIR="dists/$CHANNEL/main/binary-arm64"

mkdir -p "$REPO_ROOT/$POOL_DIR"
mkdir -p "$REPO_ROOT/$DISTS_DIR"

cp "$DEB" "$REPO_ROOT/$POOL_DIR/$DEBNAME"

# Packages index — scans only this channel's pool so packages don't bleed across channels
cd "$REPO_ROOT"
dpkg-scanpackages --arch arm64 "$POOL_DIR" \
  > "$DISTS_DIR/Packages"
gzip  -k -f "$DISTS_DIR/Packages"
bzip2 -k -f "$DISTS_DIR/Packages"

# Release file
cd "$REPO_ROOT/dists/$CHANNEL"

SUITE_DESC="oRKLLM APT Repository — OpenAI-compatible LLM inference for Rockchip NPU"
case "$CHANNEL" in
  stable) LABEL="oRKLLM Stable" ;;
  beta)   LABEL="oRKLLM Beta (pre-release)" ;;
  alpha)  LABEL="oRKLLM Alpha (development)" ;;
esac

{
  cat <<EOF
Origin: oRKLLM
Label: $LABEL
Suite: $CHANNEL
Codename: $CHANNEL
Architectures: arm64
Components: main
Description: $SUITE_DESC
Date: $(date -Ru)
EOF
  echo "MD5Sum:"
  find main -type f | sort | while read -r f; do
    printf " %s %s %s\n" "$(md5sum "$f" | cut -d' ' -f1)" "$(wc -c < "$f" | tr -d ' ')" "$f"
  done
  echo "SHA256:"
  find main -type f | sort | while read -r f; do
    printf " %s %s %s\n" "$(sha256sum "$f" | cut -d' ' -f1)" "$(wc -c < "$f" | tr -d ' ')" "$f"
  done
} > Release

gpg --batch --yes --armor --detach-sign  --output Release.gpg Release
gpg --batch --yes --armor --clearsign    --output InRelease   Release

echo "==> APT repo updated: channel=$CHANNEL pkg=$DEBNAME"
