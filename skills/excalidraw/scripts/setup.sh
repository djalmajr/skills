#!/usr/bin/env sh
# One-time setup for the programmatic (JS-official) path. Installs the headless
# toolchain and bundles @excalidraw/* into vendor/bundle.mjs (the published
# packages use bare subpath imports raw Node ESM can't resolve, so they must be
# bundled). Re-run after bumping versions in package.json.
#
#   sh scripts/setup.sh
#
# Needs: node >= 18, npm. `canvas` installs a prebuilt binary on common
# platforms; if it must compile, it needs cairo/pango/libpng/jpeg/giflib
# (macOS: `brew install pkg-config cairo pango libpng jpeg giflib librsvg`).
set -eu
cd "$(dirname "$0")"
echo "installing toolchain (npm)..."
# --legacy-peer-deps: jsdom declares an OPTIONAL peer on canvas@^2, but we use
# canvas@^3 (the version with Node 22/24 prebuilts). The peer is advisory only.
npm install --no-fund --no-audit --legacy-peer-deps
echo "bundling @excalidraw/* -> vendor/bundle.mjs (esbuild)..."
npm run build
# Verify the bundle imports (dom-shim must load first — it installs the globals).
node --input-type=module -e "import './dom-shim.mjs'; const m = await import('./vendor/bundle.mjs'); console.log('ready:', Object.keys(m).join(', '));" \
  || { echo "vendor/bundle.mjs built but failed to import — check node >= 18"; exit 1; }
echo "done. Try: node examples/architecture.example.mjs && node scripts/render.mjs /tmp/arch.excalidraw"
