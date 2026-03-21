#!/usr/bin/env bash
set -euo pipefail

# Generate a minimal test DVD (VIDEO_TS) for development.
# Requires: ffmpeg, dvdauthor
#
# The test disc has:
#   - A 10-second video with a visible frame counter + color bars
#   - AC-3 audio (440Hz sine tone)
#   - Proper DVD-Video structure (VIDEO_TS with IFO/VOB files)

OUT_DIR="${1:-/tmp/webdvd-test}"
WORK_DIR="$(mktemp -d)"

cleanup() {
    rm -rf "$WORK_DIR"
}
trap cleanup EXIT

echo "=== Generating test MPEG-2 video ==="
ffmpeg -y \
    -f lavfi -i "testsrc=duration=10:size=720x480:rate=29.97" \
    -f lavfi -i "sine=frequency=440:duration=10" \
    -target ntsc-dvd \
    -c:a ac3 -b:a 192k \
    "$WORK_DIR/test.mpg"

echo "=== Building DVD structure ==="
rm -rf "$OUT_DIR"
export VIDEO_FORMAT=NTSC
dvdauthor -o "$OUT_DIR" -t "$WORK_DIR/test.mpg"
dvdauthor -o "$OUT_DIR" -T

echo "=== Done ==="
echo "VIDEO_TS directory: $OUT_DIR/VIDEO_TS"
echo ""
echo "Test with:"
echo "  cd server && cargo run -- $OUT_DIR/VIDEO_TS"
ls -la "$OUT_DIR/VIDEO_TS/"
