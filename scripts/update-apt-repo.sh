#!/usr/bin/env bash
# Updates the gh-pages APT repository with a new .deb file.
# Usage: update-apt-repo.sh <path-to-deb> <repo-root>
set -euo pipefail

DEB="${1:?Usage: update-apt-repo.sh <path-to-deb> <repo-root>}"
REPO_ROOT="${2:-.}"
DEBNAME=$(basename "$DEB")

mkdir -p "$REPO_ROOT/pool/main/o/orkllm"
mkdir -p "$REPO_ROOT/dists/stable/main/binary-arm64"

cp "$DEB" "$REPO_ROOT/pool/main/o/orkllm/$DEBNAME"

# Packages index — run from REPO_ROOT so Filename: paths are relative
cd "$REPO_ROOT"
dpkg-scanpackages --arch arm64 pool/ \
  > dists/stable/main/binary-arm64/Packages
gzip  -k -f dists/stable/main/binary-arm64/Packages
bzip2 -k -f dists/stable/main/binary-arm64/Packages

# Release file
cd "$REPO_ROOT/dists/stable"
{
  cat <<EOF
Origin: oRKLLM
Label: oRKLLM
Suite: stable
Codename: stable
Architectures: arm64
Components: main
Description: oRKLLM APT Repository - OpenAI-compatible LLM inference for Rockchip NPU
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

echo "==> APT repo updated with $DEBNAME"
