#!/usr/bin/env bash
set -euo pipefail

# Build libdvdread + libdvdnav + glue to WASM via Emscripten.
# Requires: emcc (from emsdk)

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
BUILD_DIR="$SCRIPT_DIR/build"
DVDREAD_SRC="$SCRIPT_DIR/lib/libdvdread/src"
DVDNAV_SRC="$SCRIPT_DIR/lib/libdvdnav/src"
CONFIG_H="$SCRIPT_DIR/src/config.h"

mkdir -p "$BUILD_DIR/obj"

COMMON_FLAGS="-O2 -I$SCRIPT_DIR/src -include $CONFIG_H -Wno-pointer-sign -D__linux__ -DHAVE_CONFIG_H"

# Include paths — our wasm/src/ overrides come first (version.h, dvd_filesystem.h, config.h)
OVERRIDE_INCLUDES="-I$SCRIPT_DIR/src/dvdread -I$SCRIPT_DIR/src/dvdnav"
DVDREAD_INCLUDES="$OVERRIDE_INCLUDES -I$DVDREAD_SRC -I$DVDREAD_SRC/dvdread"
DVDNAV_INCLUDES="$OVERRIDE_INCLUDES -I$DVDNAV_SRC -I$DVDNAV_SRC/dvdnav -I$DVDNAV_SRC/vm $DVDREAD_INCLUDES"

echo "=== Compiling libdvdread ==="
for f in bitreader dvd_input dvd_reader dvd_udf ifo_print ifo_read logger md5 nav_print nav_read; do
  echo "  $f.c"
  emcc $COMMON_FLAGS $DVDREAD_INCLUDES -c "$DVDREAD_SRC/$f.c" -o "$BUILD_DIR/obj/dr_$f.o"
done

echo "=== Compiling libdvdnav ==="
for f in dvdnav read_cache navigation highlight searching settings logger; do
  echo "  $f.c"
  emcc $COMMON_FLAGS $DVDNAV_INCLUDES -pthread -c "$DVDNAV_SRC/$f.c" -o "$BUILD_DIR/obj/nav_$f.o"
done
for f in decoder vm play getset vmcmd vmget; do
  echo "  vm/$f.c"
  emcc $COMMON_FLAGS $DVDNAV_INCLUDES -pthread -c "$DVDNAV_SRC/vm/$f.c" -o "$BUILD_DIR/obj/vm_$f.o"
done

echo "=== Compiling glue ==="
emcc $COMMON_FLAGS $DVDNAV_INCLUDES -c "$SCRIPT_DIR/src/glue.c" -o "$BUILD_DIR/obj/glue.o"

echo "=== Linking ==="
emcc $BUILD_DIR/obj/*.o \
  -o "$BUILD_DIR/dvdnav.js" \
  -s MODULARIZE=1 \
  -s EXPORT_NAME=createDvdnavModule \
  -s "EXPORTED_RUNTIME_METHODS=['cwrap','FS']" \
  -s ALLOW_MEMORY_GROWTH=1 \
  -s FORCE_FILESYSTEM=1 \
  -s NO_EXIT_RUNTIME=1 \
  -s ENVIRONMENT=web \
  -O2

# Copy to player public dir for Vite to serve
DEST="$SCRIPT_DIR/../player/public/wasm"
mkdir -p "$DEST"
cp "$BUILD_DIR/dvdnav.js" "$BUILD_DIR/dvdnav.wasm" "$DEST/"

echo "=== Done ==="
echo "Output: $BUILD_DIR/dvdnav.js + dvdnav.wasm"
echo "Copied to: $DEST/"
ls -lh "$DEST/dvdnav.js" "$DEST/dvdnav.wasm"
