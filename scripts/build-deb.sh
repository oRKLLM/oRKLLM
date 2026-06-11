#!/usr/bin/env bash
set -euo pipefail

VERSION="${1:?Usage: build-deb.sh <version>}"
PKG="orkllm"
ARCH="arm64"
DEB_NAME="${PKG}_${VERSION}_${ARCH}"
INSTALL_DIR="/usr/lib/orkllm"
STAGE="$(pwd)/build_stage/${DEB_NAME}"

echo "==> Building ${DEB_NAME}.deb"

rm -rf "$(pwd)/build_stage"
mkdir -p "${STAGE}/DEBIAN"
mkdir -p "${STAGE}${INSTALL_DIR}/frontend"
mkdir -p "${STAGE}/lib/systemd/system"
mkdir -p "${STAGE}/etc/orkllm"
mkdir -p "${STAGE}/var/lib/orkllm/models"
mkdir -p "${STAGE}/usr/share/doc/orkllm"

# Application source and built frontend
cp -r src "${STAGE}${INSTALL_DIR}/"
cp -r frontend/dist "${STAGE}${INSTALL_DIR}/frontend/"
cp package.json "${STAGE}${INSTALL_DIR}/"
cp frontend/package.json "${STAGE}${INSTALL_DIR}/frontend/"

# ARM64 compiled native addons and production node_modules
cp -r arm64_deps/node_modules "${STAGE}${INSTALL_DIR}/"
cp -r arm64_deps/build "${STAGE}${INSTALL_DIR}/"

# Systemd unit and default config
cp debian/orkllm.service "${STAGE}/lib/systemd/system/"
cp debian/orkllm.conf.example "${STAGE}/etc/orkllm/"
cp README.md "${STAGE}/usr/share/doc/orkllm/" 2>/dev/null || true

# DEBIAN/control
cat > "${STAGE}/DEBIAN/control" <<EOF
Package: ${PKG}
Version: ${VERSION}
Architecture: ${ARCH}
Maintainer: Michael Fischer <mfischer@toorakcapital.io>
Pre-Depends: debconf (>= 0.5) | debconf-2.0
Depends: nodejs (>= 18.0.0), smartmontools, libgomp1, libvulkan1, mesa-vulkan-drivers
Suggests: tailscale
Section: net
Priority: optional
Homepage: https://github.com/mafischer/oRKLLM
Description: OpenAI-compatible LLM inference server for Rockchip NPU
 oRKLLM is a high-performance local LLM inference server designed for
 Rockchip NPU-powered platforms (RK3576, RK3588). Provides an OpenAI-
 compatible API and a premium admin dashboard.
EOF

cp debian/templates "${STAGE}/DEBIAN/templates"
cp debian/config "${STAGE}/DEBIAN/config"
cp debian/postinst "${STAGE}/DEBIAN/postinst"
cp debian/prerm "${STAGE}/DEBIAN/prerm"
chmod 0755 "${STAGE}/DEBIAN/config" "${STAGE}/DEBIAN/postinst" "${STAGE}/DEBIAN/prerm"

mkdir -p dist
dpkg-deb --build --root-owner-group "${STAGE}" "dist/${DEB_NAME}.deb"

SIZE=$(du -sh "dist/${DEB_NAME}.deb" | cut -f1)
echo "==> Built: dist/${DEB_NAME}.deb (${SIZE})"
