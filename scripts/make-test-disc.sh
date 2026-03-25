#!/usr/bin/env bash
set -euo pipefail

# Generate a multi-title test DVD (VIDEO_TS) for development.
# Requires: ffmpeg, dvdauthor
#
# The test disc has:
#   - 3 titles in separate titlesets (each with its own VOB)
#   - Title 1 (VTS 1): 8s, blue-shifted test pattern, 2 chapters (4s each)
#   - Title 2 (VTS 2): 10s, green-shifted test pattern, 3 chapters (~3.3s each)
#   - Title 3 (VTS 3): 6s, red-shifted test pattern, 1 chapter
#   - First Play PGC jumps to title 2 (proves the VM doesn't just default to title 1)
#   - AC-3 audio on all titles (440Hz, 880Hz, 660Hz — distinguishable by ear)

OUT_DIR="${1:-/tmp/webdvd-test}"
WORK_DIR="$(mktemp -d)"

cleanup() {
    rm -rf "$WORK_DIR"
}
trap cleanup EXIT

echo "=== Generating test MPEG-2 videos ==="

# Title 1: blue-shifted test pattern, 8 seconds, 2 chapters
ffmpeg -y -loglevel error \
    -f lavfi -i "testsrc=duration=8:size=720x480:rate=29.97,hue=h=240" \
    -f lavfi -i "sine=frequency=440:duration=8" \
    -target ntsc-dvd \
    -c:a ac3 -b:a 192k \
    "$WORK_DIR/title1.mpg"

# Title 2: green-shifted test pattern, 10 seconds, 3 chapters (the "main feature")
ffmpeg -y -loglevel error \
    -f lavfi -i "testsrc=duration=10:size=720x480:rate=29.97,hue=h=120" \
    -f lavfi -i "sine=frequency=880:duration=10" \
    -target ntsc-dvd \
    -c:a ac3 -b:a 192k \
    "$WORK_DIR/title2.mpg"

# Title 3: red-shifted test pattern, 6 seconds, 1 chapter (bonus)
ffmpeg -y -loglevel error \
    -f lavfi -i "testsrc=duration=6:size=720x480:rate=29.97,hue=h=0:s=3" \
    -f lavfi -i "sine=frequency=660:duration=6" \
    -target ntsc-dvd \
    -c:a ac3 -b:a 192k \
    "$WORK_DIR/title3.mpg"

echo "=== Building DVD structure ==="
rm -rf "$OUT_DIR"

# Each title in its own titleset — separate VOBs, clean transcoding.
# First Play PGC jumps to title 2 (global title numbering).
cat > "$WORK_DIR/dvdauthor.xml" <<XMLEOF
<dvdauthor dest="$OUT_DIR">
  <vmgm>
    <fpc>jump title 2;</fpc>
  </vmgm>
  <titleset>
    <titles>
      <pgc>
        <vob file="$WORK_DIR/title1.mpg" chapters="0,4" />
      </pgc>
    </titles>
  </titleset>
  <titleset>
    <titles>
      <pgc>
        <vob file="$WORK_DIR/title2.mpg" chapters="0,3.3,6.6" />
      </pgc>
    </titles>
  </titleset>
  <titleset>
    <titles>
      <pgc>
        <vob file="$WORK_DIR/title3.mpg" />
      </pgc>
    </titles>
  </titleset>
</dvdauthor>
XMLEOF

export VIDEO_FORMAT=NTSC
dvdauthor -x "$WORK_DIR/dvdauthor.xml"

echo "=== Done ==="
echo "VIDEO_TS directory: $OUT_DIR/VIDEO_TS"
echo ""
echo "Disc layout:"
echo "  Title 1 (VTS 1): 8s, blue test pattern, 2 chapters (440Hz tone)"
echo "  Title 2 (VTS 2): 10s, green test pattern, 3 chapters (880Hz tone) — First Play target"
echo "  Title 3 (VTS 3): 6s, red test pattern, 1 chapter (660Hz tone)"
echo ""
echo "Test with:"
echo "  cd server && cargo run -- $OUT_DIR/VIDEO_TS"
ls -la "$OUT_DIR/VIDEO_TS/"
